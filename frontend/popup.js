// DOM Elements for navigation
const promptInput = document.getElementById('prompt');
const responseDiv = document.getElementById('response');
const sendButton = document.getElementById('send-btn');
const stopButton = document.getElementById('stop-btn');
const clearButton = document.getElementById('clear-btn');
const statusSpan = document.getElementById('status');
const ttsButton = document.getElementById('tts-btn');
const copyButton = document.getElementById('copy-btn');

// Streaming and typing states
let abortController = null;
let typeQueue = [];
let typerInterval = null;

// Session-based conversation history (resets when popup closes)
// Format: [{role: 'user'|'model', parts: [{text: string}]}]
let conversationHistory = [];

// --- Storage helpers --------------------------------------------------
// Wrap chrome.storage.local with a safe fallback to localStorage so the UI
// doesn't blow up if the browser doesn't expose chrome.storage in some
// contexts (e.g., previewing popup.html outside the extension).
function storageKeyForUrl(url) {
    return `geminiHistory_${encodeURIComponent(url)}`;
}

async function loadStoredHistory() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) return;
        const key = storageKeyForUrl(tab.url);
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            return new Promise(resolve => chrome.storage.local.get([key], data => {
                if (data && Array.isArray(data[key])) conversationHistory = data[key];
                resolve();
            }));
        }
    } catch (e) {
        // Fallback to window.localStorage if chrome.storage isn't available
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const key = storageKeyForUrl(tab.url);
            const raw = localStorage.getItem(key);
            if (raw) conversationHistory = JSON.parse(raw);
        } catch (err) {
            // ignore
        }
    }
}

async function saveStoredHistory() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) return;
        const key = storageKeyForUrl(tab.url);
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            return new Promise(resolve => chrome.storage.local.set({ [key]: conversationHistory }, resolve));
        }
    } catch (e) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const key = storageKeyForUrl(tab.url);
            localStorage.setItem(key, JSON.stringify(conversationHistory));
        } catch (err) {
            // ignore
        }
    }
}

async function removeStoredHistoryForActiveTab() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) return;
        const key = storageKeyForUrl(tab.url);
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            return new Promise(resolve => chrome.storage.local.remove([key], resolve));
        }
        localStorage.removeItem(key);
    } catch (e) {
        // ignore
    }
}

// Text-to-speech state
let speechSynthesis = null;
let currentUtterance = null;
let isSpeaking = false;
let isIntentionallyStopping = false; // Track if we're manually stopping

// Typing animation tuning (adjust for speed/feel)
const TYPING_BATCH = 4; // characters processed per tick
const TYPING_INTERVAL_MS = 15; // milliseconds between ticks

/**
 * Update the small status label in the UI.
 * When status is 'loading' the visible text is handled by CSS animation.
 * @param {string} text
 */
function setStatus(text) {
    statusSpan.className = text;
    statusSpan.textContent = text === 'loading' ? '' : text;
}

/**
 * Start the typing pump which empties `typeQueue` into the response box
 * at a controlled rate so streamed text appears smooth.
 */
function startTyper() {
    if (typerInterval) return;
    typerInterval = setInterval(() => {
        if (typeQueue.length === 0) return;
        const batch = typeQueue.splice(0, TYPING_BATCH).join('');
        responseDiv.textContent += batch;
        responseDiv.scrollTop = responseDiv.scrollHeight;
    }, TYPING_INTERVAL_MS);
}

/**
 * Stop the typing pump and clear the interval.
 */
function stopTyper() {
    if (!typerInterval) return;
    clearInterval(typerInterval);
    typerInterval = null;
}

/**
 * Enqueue text for the typing pump. Characters are enqueued individually
 * to preserve precise flow when streaming partial chunks.
 * @param {string} text
 */
function enqueueText(text) {
    for (const ch of text) typeQueue.push(ch);
    startTyper();
}

/**
 * Normalize incoming stream chunks.
 * Handles two common cases: JSON-wrapped payloads like {"text":"..."}
 * and escaped sequences (\n, \t) that were serialized earlier.
 * This function is intentionally conservative and will fall back to
 * the raw text if parsing fails.
 * @param {string} raw
 * @returns {string}
 */
function cleanChunk(raw) {
    if (!raw) return '';
    let s = raw;

    const looksLikeJson = /^\s*\{\s*"text"\s*:/;
    if (looksLikeJson.test(s)) {
        try {
            const parsed = JSON.parse(s);
            if (parsed && typeof parsed.text === 'string') s = parsed.text;
        } catch (e) {
            // If we can't parse, continue with the original string.
            console.log('Chunk not valid JSON, using raw text:', e);
        }
    }

    // Replace common escape sequences produced by JSON serialization
    s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

    // Strip lightweight markdown bold markers for display clarity
    s = s.replace(/\*\*(.*?)\*\*/g, '$1');

    return s;
}

/**
 * Send a prompt to the local Gemini proxy and stream the response into the UI.
 * If `overridePrompt` is provided, it will be sent directly and the textarea
 * will be disabled while the request is in flight.
 * @param {string} [overridePrompt] - Optional prompt to send (for summarize)
 * @param {boolean} [hideUserMessage] - If true, don't show user message in UI (for summarize)
 */
async function sendPrompt(overridePrompt, hideUserMessage = false) {
    const prompt = (typeof overridePrompt === 'string' ? overridePrompt : promptInput.value).trim();
    if (!prompt) {
        responseDiv.textContent = 'Please enter a question.';
        return;
    }

    // Add user message to conversation history
    conversationHistory.push({
        role: 'user',
        parts: [{ text: prompt }]
    });
    // Persist to storage for this page/tab
    await saveStoredHistory();
    
    // Debug: Log conversation history
    console.log('Conversation History (after adding user message):', conversationHistory);
    console.log('History length:', conversationHistory.length);

    // Prepare UI for streaming
    responseDiv.textContent = '';
    const hideInput = typeof overridePrompt === 'string';
    if (hideInput) {
        promptInput.value = '';
        promptInput.disabled = true;
    }

    setStatus('loading');
    const loadingBox = document.createElement('div');
    loadingBox.className = 'loading-box';
    responseDiv.style.position = 'relative';
    responseDiv.appendChild(loadingBox);

    sendButton.disabled = true;
    stopButton.disabled = false;

    abortController = new AbortController();
    let fullResponse = '';

    // Prepare history to send (without the current message we just added)
    const historyToSend = conversationHistory.slice(0, -1);
    console.log('Sending to API - History length:', historyToSend.length);
    console.log('Sending to API - Current prompt:', prompt);
    
    try {
        const resp = await fetch('http://localhost:3000/api/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                prompt,
                conversationHistory: historyToSend // Send history without current message
            }),
            signal: abortController.signal
        });

        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Server error ${resp.status}: ${text}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let done = false;

        while (!done) {
            const { value, done: streamDone } = await reader.read();
            if (streamDone) {
                done = true;
                break;
            }
            if (value) {
                let chunkText = decoder.decode(value, { stream: true });
                chunkText = cleanChunk(chunkText);
                if (chunkText) {
                    enqueueText(chunkText);
                    fullResponse += chunkText;
                }
            }
        }

        // Wait for the UI queue to fully render the streamed text
        await new Promise(resolve => {
            const check = setInterval(() => {
                if (typeQueue.length === 0) {
                    clearInterval(check);
                    resolve();
                }
            }, 50);
        });

        // Add model response to conversation history
        if (fullResponse.trim()) {
            conversationHistory.push({
                role: 'model',
                parts: [{ text: fullResponse.trim() }]
            });
            
            // Limit history to last 10 messages to keep it manageable
            if (conversationHistory.length > 10) {
                conversationHistory = conversationHistory.slice(-10);
            }
            
            // Debug: Log conversation history
            console.log('🤖 Conversation History (after adding AI response):', conversationHistory);
            console.log('📊 History length:', conversationHistory.length);
            // Persist
            await saveStoredHistory();
        }

        setStatus('done');
        
        // Enable response control buttons
        ttsButton.disabled = false;
        copyButton.disabled = false;

    } catch (err) {
        if (err.name === 'AbortError') {
            responseDiv.textContent += '\n[Cancelled]\n';
            setStatus('cancelled');
        } else {
            console.error('Fetch/Stream error:', err);
            responseDiv.textContent = `Error: ${err.message}`;
            setStatus('error');
        }
    } finally {
        const loadingBox = responseDiv.querySelector('.loading-box');
        if (loadingBox) loadingBox.remove();

        // Restore the input area if it was hidden for this flow
        try { promptInput.disabled = false; } catch (e) {}

        sendButton.disabled = false;
        stopButton.disabled = true;
        abortController = null;
        stopTyper();
        
        // Disable response controls on error
        if (responseDiv.textContent.includes('Error') || responseDiv.textContent.includes('Cancelled')) {
            ttsButton.disabled = true;
            copyButton.disabled = true;
        }
    }
}

/**
 * Extracts the active tab content via a content script and streams a summary.
 * This function attempts a direct message first; if there is no listener it
 * will inject the content script dynamically and retry.
 */
async function summarizeCurrentPage() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Avoid trying to inject into privileged or non-http pages
    try {
        const url = new URL(tab.url);
        if (!/^https?:/.test(url.protocol)) {
            alert('Cannot summarize this page (internal or unsupported page). Try a regular website page.');
            return;
        }
    } catch (e) {
        alert('Could not determine the active tab URL. Make sure you are on a normal web page.');
        return;
    }

    // Try messaging the page. If that fails, inject the content script and retry.
    let response = null;
    try {
        response = await chrome.tabs.sendMessage(tab.id, { action: 'summarizePage' });
    } catch (err) {
        console.log('Initial sendMessage failed (will try injecting content script):', err);
    }

    if (!response) {
        try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
            await new Promise(r => setTimeout(r, 150));
            response = await chrome.tabs.sendMessage(tab.id, { action: 'summarizePage' });
        } catch (err) {
            console.error('Failed to inject or message content script:', err);
            alert('Could not contact the page. Make sure the page allows scripts (not chrome:// or extension pages).');
            return;
        }
    }

    if (response && response.content) {
        // Reduced content size for faster processing
        const MAX_SCRAPE = 5000;
        let textToSummarize = response.content || '';
        if (textToSummarize.length > MAX_SCRAPE) {
            textToSummarize = textToSummarize.slice(0, MAX_SCRAPE) + '\n\n[...truncated]';
        }

        // Concise prompt for quick summary
        const prompt = `Summarize this article in 3-4 sentences:\n\n${textToSummarize}`;

        // Reset UI queue and start streaming the summary
        typeQueue = [];
        stopTyper();
        responseDiv.textContent = '';
        
        // Send prompt (hideUserMessage=true so we don't show the full prompt in UI)
        sendPrompt(prompt, true);
    } else {
        alert('Could not extract content from the page or the page returned empty content.');
    }
}

// Wire UI controls
document.getElementById('summarize-btn').addEventListener('click', summarizeCurrentPage);

sendButton.addEventListener('click', () => {
    stopTextToSpeech(); // Stop any ongoing speech when sending new message
    typeQueue = [];
    stopTyper();
    responseDiv.textContent = '';
    ttsButton.disabled = true;
    copyButton.disabled = true;
    sendPrompt();
});

stopButton.addEventListener('click', () => {
    if (abortController) abortController.abort();
    stopButton.disabled = true;
});

clearButton.addEventListener('click', () => {
    if (abortController) abortController.abort();
    stopTextToSpeech(); // Stop any ongoing speech
    typeQueue = [];
    stopTyper();
    responseDiv.textContent = '';
    conversationHistory = []; // Clear conversation history
    // Also remove any stored conversation for the active tab
    removeStoredHistoryForActiveTab();
    console.log('Conversation History cleared');
    setStatus('idle');
    sendButton.disabled = false;
    stopButton.disabled = true;
    ttsButton.disabled = true;
    copyButton.disabled = true;
});

/**
 * Text-to-Speech functionality
 */
function stopTextToSpeech() {
    if (speechSynthesis && (isSpeaking || speechSynthesis.speaking)) {
        isIntentionallyStopping = true; // Mark that we're intentionally stopping
        speechSynthesis.cancel();
        isSpeaking = false;
        currentUtterance = null;
        ttsButton.textContent = 'Read';
        ttsButton.title = 'Read response aloud';
        // Reset flag after a short delay
        setTimeout(() => {
            isIntentionallyStopping = false;
        }, 100);
    }
}

function startTextToSpeech() {
    const text = responseDiv.textContent.trim();
    if (!text || text === 'Waiting for a prompt...') {
        return;
    }

    // Check if browser supports speech synthesis
    if (!('speechSynthesis' in window)) {
        alert('Your browser does not support text-to-speech.');
        return;
    }

    if (isSpeaking) {
        stopTextToSpeech();
        return;
    }

    stopTextToSpeech();

    speechSynthesis = window.speechSynthesis;
    currentUtterance = new SpeechSynthesisUtterance(text);
    
    // MORE HUMAN settings - slower, natural pitch
    currentUtterance.rate = 0.95;  // Slightly slower = more natural and clear
    currentUtterance.pitch = 1.0;  // Normal pitch = less robotic
    currentUtterance.volume = 1.0;

    // Get voices and prioritize the MOST natural sounding ones
    const voices = speechSynthesis.getVoices();
    
    // Priority list of the best natural voices across platforms
    const bestVoiceNames = [
        'Samantha',           // macOS - extremely natural
        'Google UK English Female', // Chrome - very natural
        'Google US English',  // Chrome - good quality
        'Microsoft Zira',     // Windows - natural female
        'Microsoft David',    // Windows - natural male
        'Alex',              // macOS - good male voice
        'Karen',             // macOS - good female voice
        'Moira',             // macOS - Irish accent, very natural
        'Tessa',             // macOS - South African, very natural
    ];
    
    // Try to find the best voice from priority list
    let selectedVoice = null;
    for (const voiceName of bestVoiceNames) {
        selectedVoice = voices.find(v => v.name === voiceName);
        if (selectedVoice) break;
    }
    
    // If no exact match, look for Neural/Natural/Premium voices
    if (!selectedVoice) {
        const premiumVoices = voices.filter(v => 
            v.lang.startsWith('en') && 
            (v.name.includes('Neural') || 
             v.name.includes('Natural') || 
             v.name.includes('Premium') ||
             v.name.includes('Enhanced') ||
             v.name.includes('Google'))
        );
        
        // Prefer female voices as they often sound more natural
        const femaleVoices = premiumVoices.filter(v => 
            v.name.includes('Female') || 
            v.name.includes('Zira') || 
            v.name.includes('Samantha') ||
            v.name.includes('Karen')
        );
        
        selectedVoice = femaleVoices[0] || premiumVoices[0];
    }
    
    // Final fallback to any English voice
    if (!selectedVoice) {
        const englishVoices = voices.filter(v => v.lang.startsWith('en'));
        selectedVoice = englishVoices[0] || voices[0];
    }
    
    if (selectedVoice) {
        currentUtterance.voice = selectedVoice;
        console.log('Using voice:', selectedVoice.name); // Helpful for debugging
    }

    // Event handlers
    currentUtterance.onstart = () => {
        isSpeaking = true;
        isIntentionallyStopping = false;
        ttsButton.textContent = 'Stop';
        ttsButton.title = 'Stop reading';
    };

    currentUtterance.onend = () => {
        isSpeaking = false;
        currentUtterance = null;
        ttsButton.textContent = 'Read';
        ttsButton.title = 'Read response aloud';
    };

    currentUtterance.onerror = (event) => {
        if (isIntentionallyStopping) {
            isSpeaking = false;
            currentUtterance = null;
            return;
        }
        
        if (event.error !== 'interrupted' && event.error !== 'canceled') {
            console.error('Speech synthesis error:', event);
            isSpeaking = false;
            currentUtterance = null;
            ttsButton.textContent = 'Read';
            ttsButton.title = 'Read response aloud';
            alert('Error reading text. Please try again.');
        } else {
            isSpeaking = false;
            currentUtterance = null;
            ttsButton.textContent = 'Read';
            ttsButton.title = 'Read response aloud';
        }
    };

    speechSynthesis.speak(currentUtterance);
}

/**
 * Copy response to clipboard
 */
async function copyResponseToClipboard() {
    const text = responseDiv.textContent.trim();
    if (!text || text === 'Waiting for a prompt...') {
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        // Visual feedback
        const originalText = copyButton.textContent;
        copyButton.textContent = 'Copied!';
        copyButton.style.color = '#00ff00';
        setTimeout(() => {
            copyButton.textContent = originalText;
            copyButton.style.color = '';
        }, 2000);
    } catch (err) {
        console.error('Failed to copy text:', err);
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            copyButton.textContent = 'Copied!';
            setTimeout(() => {
                copyButton.textContent = 'Copy';
            }, 2000);
        } catch (e) {
            alert('Failed to copy text. Please select and copy manually.');
        }
        document.body.removeChild(textArea);
    }
}

// TTS and Copy button event listeners
ttsButton.addEventListener('click', startTextToSpeech);
copyButton.addEventListener('click', copyResponseToClipboard);

// Load voices when available (some browsers need this)
if ('speechSynthesis' in window) {
    // Initialize speechSynthesis variable to the browser's implementation
    speechSynthesis = window.speechSynthesis;
    // Some browsers load voices asynchronously; register a no-op handler to
    // trigger the browser's internal events without assuming `speechSynthesis`
    // was already assigned.
    try {
        speechSynthesis.onvoiceschanged = () => { /* voices loaded */ };
    } catch (e) {
        // Some environments may not allow setting this; ignore.
    }
}

// Keyboard shortcuts
promptInput.addEventListener('keydown', (e) => {
    // Enter to send (Shift+Enter for new line)
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendButton.disabled) {
            sendButton.click();
        }
    }
    // Escape to stop
    if (e.key === 'Escape') {
        if (!stopButton.disabled) {
            stopButton.click();
        } else if (isSpeaking) {
            stopTextToSpeech();
        }
    }
});

// Initialize UI state
setStatus('idle');

// Load any stored history for the active tab so the chat can remember what we were
// talking about between popup sessions for the same page. If there is previous
// model output, display it to provide context immediately.
(async () => {
    await loadStoredHistory();
    if (conversationHistory.length > 0) {
        const lastModel = [...conversationHistory].reverse().find(m => m.role === 'model');
        if (lastModel && lastModel.parts && lastModel.parts[0]) {
            responseDiv.textContent = lastModel.parts[0].text;
            ttsButton.disabled = false;
            copyButton.disabled = false;
            setStatus('idle');
        }
    }
})();

// Debug helper: Expose conversation history to window for easy inspection
window.getConversationHistory = () => {
    console.log('Current Conversation History:');
    console.log('Total messages:', conversationHistory.length);
    conversationHistory.forEach((msg, index) => {
        console.log(`\n[${index + 1}] ${msg.role.toUpperCase()}:`);
        console.log(msg.parts[0].text.substring(0, 100) + (msg.parts[0].text.length > 100 ? '...' : ''));
    });
    return conversationHistory;
};

// Debug helper: Show formatted history in console
window.showHistory = () => {
    console.log('Full Conversation History:');
    console.table(conversationHistory.map((msg, i) => ({
        index: i + 1,
        role: msg.role,
        preview: msg.parts[0].text.substring(0, 50) + '...',
        length: msg.parts[0].text.length
    })));
};

console.log('*** Debug helpers available:');
console.log('  - getConversationHistory() - Returns and logs the full history');
console.log('  - showHistory() - Shows a formatted table of the history');