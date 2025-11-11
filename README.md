# Gemini AI Browser Extension

This is a TRON-themed browser extension that uses the Google Gemini API to instantly summarize web pages or answer questions with lightning-fast, concise responses.

## ✨ Features

* **Real-time Response Streaming:** Responses are streamed chunk-by-chunk for instant perceived speed.
* **TRON: Legacy Aesthetic:** Features a dark theme with neon blue glowing UI elements and a custom light cycle loading animation.
* **Web Page Summarization:** Scrape and summarize the content of the active tab with a single click.
* **Concise Answers:** Configured for extremely brief (single-sentence/paragraph) AI responses.

## 🛠️ Project Structure

The project is split into two main components:

1.  **Extension Files (`manifest.json`, `popup.html`, `popup.js`, `style.css`):** The client-side code that runs in the browser.
2.  **Backend Server (`server.js`):** A Node.js Express server that acts as a secure proxy to communicate with the Gemini API.

---

## 💻 Setup and Installation

### Step 1: Clone the Repository


Clone this project to your local machine:

git clone [YOUR_REPO_URL]
cd gemini-browser-extension

### Step 2: Backend Server Setup (Node.js)
A. Install dependencies - navigate to the project root and install the required Node.js packages:

npm install express cors dotenv @google/genai

B. Get Your Gemini API Key
 - Go to Google AI Studio to generate your API Key
 - Click "Create API Key" and copy the generated Key.

C. Configure Environment variables
 - Create a file names .env in the root directory of the project (where server.js is located). Paste your api key into this file:

    \# .env file
    GEMINI_API_KEY="YOUR_GENERATED_API_KEY"

    The backend server (server.js) will automatically load this key when it starts.

D. Start the Server
Run the backend server using Node:

cd backend
node server.js

<em>Note: this server will run on http://localhost:3000. Keep this window open while using the extension</em>

### Step 3: Install Browser Extension (Chrome/Edge)
1. Open your browser and navigate to the extensions management page:

 - Chrome/Brave: Type chrome://extensions in the address bar.

 - Edge: Type edge://extensions in the address bar.

2. Enable "Developer mode" using the toggle switch in the top right corner.

3. Click the "Load unpacked" button.

4. Navigate to and select the root directory of this cloned project.

The Gemini Extension icon will now appear in your browser's toolbar.
