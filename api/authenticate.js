// api/authenticate.js

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { code, redirectUri, clientId } = req.body || {};
  const CLIENT_ID = process.env.GH_CLIENT_ID || clientId;
  const CLIENT_SECRET = process.env.GH_CLIENT_SECRET;

  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'OAuth server is missing GH_CLIENT_ID or GH_CLIENT_SECRET' });
  }

  try {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error || 'GitHub token exchange failed',
        error_description: data.error_description
      });
    }

    if (data.error) {
      return res.status(400).json({
        error: data.error,
        error_description: data.error_description
      });
    }

    return res.status(200).json(data);
  } catch (_) {
    return res.status(500).json({ error: 'Authentication failed' });
  }
}
