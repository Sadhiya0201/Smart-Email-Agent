const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');

const credentials = JSON.parse(fs.readFileSync('credentials.json'));

const config = credentials.installed || credentials.web;
const { client_id, client_secret } = config;

const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/gmail.readonly'],
  prompt: 'consent'
});

console.log('\nOpen this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for Google authorization...\n');

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) return;

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');

  if (!code) {
    res.end('Authorization failed. No code received.');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    console.log('\n========================================');
    console.log('YOUR GMAIL REFRESH TOKEN:');
    console.log(tokens.refresh_token);
    console.log('========================================\n');

    res.end('Authorization successful! You can close this browser tab.');
    server.close();
  } catch (error) {
    console.error('\nError getting token:', error.message);
    res.end('Authorization failed. Check the terminal.');
    server.close();
  }
});

server.listen(3000, '127.0.0.1', () => {
  console.log('Listening on http://localhost:3000');
});