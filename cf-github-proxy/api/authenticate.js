// api/authenticate.js

export default async function handler(req, res) {
  // 1. Enable CORS so your Chrome Extension is allowed to talk to this server
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { code } = req.body;

  // 2. These will be securely stored in Vercel, NOT in your code!
  const CLIENT_ID = process.env.GH_CLIENT_ID;
  const CLIENT_SECRET = process.env.GH_CLIENT_SECRET;

  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }

  try {
    // 3. Securely ask GitHub for the access token
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { 
        "Accept": "application/json", 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code
      })
    });

    const data = await response.json();
    
    // 4. Send the token back to the Chrome Extension
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: "Authentication failed" });
  }
}