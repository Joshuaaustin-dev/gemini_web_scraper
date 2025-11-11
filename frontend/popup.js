// DOM Elements for navigation
const promptInput = document.getElementById('prompt');
const responseDiv = document.getElementById('response');
const sendButton = document.getElementById('send-btn');
const stopButton = document.getElementById('stop-btn');
const clearButton = document.getElementById('clear-btn');
const statusSpan = document.getElementById('status');

// Streaming and typing states
let abortController = null;
let typeQueue = [];
let typerInterval = null;

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
 * @param {string} [overridePrompt]
 */
async function sendPrompt(overridePrompt) {
    const prompt = (typeof overridePrompt === 'string' ? overridePrompt : promptInput.value).trim();
    if (!prompt) {
        responseDiv.textContent = 'Please enter a question.';
        return;
    }

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

    try {
        const resp = await fetch('http://localhost:3000/api/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
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
                if (chunkText) enqueueText(chunkText);
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

        setStatus('done');

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
        const MAX_SCRAPE = 5000;
        let textToSummarize = response.content || '';
        if (textToSummarize.length > MAX_SCRAPE) {
            textToSummarize = textToSummarize.slice(0, MAX_SCRAPE) + '\n\n[...truncated]';
        }

        const prompt = `Please summarize the following article concisely (max 100 words):\n\n${textToSummarize}`;

        // Reset UI queue and start streaming the summary. The prompt is passed
        // directly so it is never shown in the textarea.
        typeQueue = [];
        stopTyper();
        responseDiv.textContent = '';
        sendPrompt(prompt);
    } else {
        alert('Could not extract content from the page or the page returned empty content.');
    }
}

// Wire UI controls
document.getElementById('summarize-btn').addEventListener('click', summarizeCurrentPage);

sendButton.addEventListener('click', () => {
    typeQueue = [];
    stopTyper();
    responseDiv.textContent = '';
    sendPrompt();
});

stopButton.addEventListener('click', () => {
    if (abortController) abortController.abort();
    stopButton.disabled = true;
});

clearButton.addEventListener('click', () => {
    if (abortController) abortController.abort();
    typeQueue = [];
    stopTyper();
    responseDiv.textContent = '';
    setStatus('idle');
    sendButton.disabled = false;
    stopButton.disabled = true;
});

// Initialize UI state
setStatus('idle');