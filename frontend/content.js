function extractMainContent() {
    // 1. Identify the main content area
    const articleSelectors = 'article, main, .post-content, .article-body, .main-content';
    let contentElement = document.querySelector(articleSelectors) || document.body;

    // 2. Extract and clean the text content
    let rawText = contentElement.innerText || '';

    //3. Cleanup
    const cleanedText = rawText
        .replace(/\s*\n\s*\n\s*/g, '\n\n') 
        .trim();
    // Limit the returned text to a safe size to avoid sending huge payloads
    // Reduced for faster processing
    const MAX_SCRAPE = 5000;
    if (cleanedText.length > MAX_SCRAPE) {
        return cleanedText.slice(0, MAX_SCRAPE) + '\n\n[...truncated]';
    }

    return cleanedText;
}

//Listen for a message from the popup script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'summarizePage') {
        const pageContent = extractMainContent();

        //Send scraped text to popup script
        sendResponse({ content: pageContent });
        return true;
    }
})

// Ensure stored conversation for this page is removed when the tab/page unloads.
// This ties the lifetime of the saved conversation to the tab being open.
try {
    const key = `geminiHistory_${encodeURIComponent(location.href)}`;
    window.addEventListener('beforeunload', () => {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.remove([key]);
            } else if (window.localStorage) {
                localStorage.removeItem(key);
            }
        } catch (e) {
            // ignore
        }
    });
} catch (e) {
    // ignore
}