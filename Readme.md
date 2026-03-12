# CF → GitHub AutoPusher 🚀

A powerful, secure Chrome extension that automatically pushes your **Accepted Codeforces solutions** directly to your GitHub repository in real-time. 

Say goodbye to manually downloading and uploading your code. Just solve the problem, get "Accepted", and watch it appear in your GitHub repo!

## ✨ Features

* **Live "No-Refresh" Detection:** Monitors the Codeforces status table in the background. The exact millisecond your code is marked "Accepted", the extension catches it—no manual page refresh required.
* **One-Click Secure GitHub Login:** Uses a modern OAuth 2.0 flow. Connect your GitHub account with a single click without ever manually generating or pasting Personal Access Tokens (PATs).
* **Enterprise-Grade Security:** Built with a custom Vercel proxy server, ensuring your GitHub Client Secrets are never exposed in the public extension code.
* **Smart Organization:** Automatically organizes your pushed code into clean folders based on the Contest ID and Problem Index.
* **Dual Fetching:** Extracts both your raw source code and the problem statement (as a `README.md`).

---

## 🏗️ Architecture

To keep your credentials completely secure, this project is split into two parts:
1. **The Client (Chrome Extension):** Runs in your browser, detects accepted solutions, extracts code, and pushes to GitHub using a secure access token.
2. **The Proxy Server (Vercel):** A lightweight serverless function that handles the secure OAuth token exchange with GitHub so your `CLIENT_SECRET` remains hidden.

---

## 🛠️ Setup & Installation

Follow these steps to get your own version of the extension running.

### Step 1: Create a GitHub OAuth App
1. Go to your GitHub **Developer Settings** > **OAuth Apps** > **New OAuth App**.
2. Set the **Authorization callback URL** to: `https://<your-extension-id>.chromiumapp.org/`
3. Save the **Client ID** and generate a **Client Secret**. Keep these handy!

### Step 2: Deploy the Secure Proxy Server
1. Clone or create the proxy server code (a simple Node.js/Express app with one `/api/authenticate` endpoint).
2. Deploy the proxy code to [Vercel](https://vercel.com/) (it's free!).
3. In your Vercel project settings, add the following Environment Variables:
   * `GH_CLIENT_ID`: Your GitHub OAuth Client ID
   * `GH_CLIENT_SECRET`: Your GitHub OAuth Client Secret
4. Copy your Vercel deployment URL (e.g., `https://my-cf-proxy.vercel.app`).

### Step 3: Configure the Extension
1. Open the extension's `background.js` file.
2. Update the `CLIENT_ID` variable with your GitHub OAuth Client ID.
3. Update the `fetch()` URL in the `authenticate` listener to point to your new Vercel proxy URL.

### Step 4: Install in Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** ON (top right corner).
3. Click **Load unpacked** and select the folder containing your extension files.
4. Pin the extension to your toolbar!

---

## 🚀 Usage

1. Click the extension icon in your Chrome toolbar.
2. Click **Connect to GitHub** and authorize the application.
3. Enter the repository URL where you want your solutions saved (e.g., `https://github.com/username/cf-solutions`) and click **Save Settings**.
4. Go to Codeforces, solve a problem, and wait for the "Accepted" verdict on the status page.
5. Check your GitHub repository—your code is already there!

---

## 📁 Repository Structure Example

Once running, your linked GitHub repository will automatically organize itself like this:

```text
Codeforces/
├── 1900/
│   ├── A_Two_Vessels_README.md
│   └── A_Two_Vessels_solution.cpp
├── 1915/
│   ├── A_Odd_One_Out_README.md
│   └── A_Odd_One_Out_solution.cpp