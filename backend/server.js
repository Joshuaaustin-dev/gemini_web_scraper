require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const port = 3000;

// Initialize Gemini API client
const ai = new GoogleGenAI({});

// Middleware
app.use(cors());
app.use(express.json());

// Define the API endpoint for the Extension
app.post('/api/gemini', async (req, res) => {
    try {
        const { prompt } = req.body;

        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        // Set the response header for streaming
        // Use no-cache and disable buffering to improve realtime delivery
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        // For some proxies (nginx) to avoid buffering
        res.setHeader('X-Accel-Buffering', 'no');


        // Track if client disconnected to stop streaming work
        let clientAborted = false;
        res.on('close', () => {
            clientAborted = true;
            console.log('Client disconnected: aborting stream');
        });

        // Helper to clean/unwrap text that may be returned wrapped as JSON string
        function cleanText(raw) {
            if (!raw) return '';
            let text = raw;

            // If the SDK returned a JSON string like '{"text":"..."}', try to parse
            const looksLikeJson = /^\s*\{\s*"text"\s*:\s*"/;
            if (looksLikeJson.test(text)) {
                try {
                    const parsed = JSON.parse(text);
                    if (parsed && typeof parsed.text === 'string') {
                        text = parsed.text;
                    }
                } catch (e) {
                    // If parsing fails, keep original
                }
            }

            // Unescape common escaped sequences that sometimes appear in JSON-encoded text
            // e.g. "\n" -> newline
            text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

            // Remove simple markdown bold markers for a clean UI ("**bold**" -> "bold")
            text = text.replace(/\*\*(.*?)\*\*/g, '$1');

            return text;
        }

        // Generate content stream for realtime output
        // Instruct the model to be short and precise (approx 40-60 words)
        const stream = await ai.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                systemInstruction: "You are a concise, helpful assistant. Provide a short, accurate answer in about 80-100 words. Avoid filler.",
                // lower token budget to encourage short replies
            }
        });

        // Pipe the stream directly to the response object; honor client disconnects
        try {
            for await (const chunk of stream) {
                if (clientAborted) {
                    // Stop consuming the stream when client disconnects
                    console.log('Stopping stream due to client abort');
                    break;
                }

                // Some SDK chunks may be objects with .text; be defensive
                let text = typeof chunk === 'string' ? chunk : (chunk?.text ?? '');
                if (text) {
                    const cleaned = cleanText(text);
                    // Only write if there's something meaningful
                    if (cleaned) res.write(cleaned);
                }
            }
        } catch (streamErr) {
            console.error('Stream iteration error:', streamErr);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error during streaming' });
                return;
            }
            // If headers already sent, try to write a short message then end
            try { res.write('\n[Stream ended with an error]\n'); } catch (e) {}
        } finally {
            // End the response stream if still writable
            try { res.end(); } catch (e) { /* ignore */ }
        }

    } catch (error) {
        console.error('Error with Gemini API:', error);
        // If we haven't started a stream yet, return JSON error
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        } else {
            try { res.write('\n[Internal Server Error]\n'); } catch (e) {}
            try { res.end(); } catch (e) {}
        }
    
    }
    });

//Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});