const crypto = require('crypto');
const express = require('express');

const app = express();
app.use(express.json({ limit: '256kb' }));

const requiredVars = [
  'MELI_CLIENT_ID',
  'MELI_CLIENT_SECRET',
  'MELI_REDIRECT_URI',
  'ADMIN_TOKEN',
  'TOKEN_ENCRYPTION_KEY',
];

const missing = requiredVars.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const config = {
  clientId: process.env.MELI_CLIENT_ID,
  clientSecret: process.env.MELI_CLIENT_SECRET,
  redirectUri: process.env.MELI_REDIRECT_URI,
  adminToken: process.env.ADMIN_TOKEN,
  authBase: process.env.MELI_AUTH_BASE_URL || 'https://global-selling.mercadolibre.com',
  apiBase: process.env.MELI_API_BASE_URL || 'https://api.mercadolibre.com',
};

const key = crypto.createHash('sha256').update(process.env.TOKEN_ENCRYPTION_KEY).digest();

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function decrypt(payload) {
  const [iv, tag, encrypted] = payload.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// Temporary in-memory store. Suitable for the first OAuth test deployment.
// A database can be added after authorization works.
const accounts = new Map();
const webhookEvents = [];

async function exchangeCode(code) {
  const response = await fetch(`${config.apiBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function refreshAccessToken(account) {
  const response = await fetch(`${config.apiBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: decrypt(account.refreshTokenEncrypted),
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

function saveAccount(data) {
  const expiresAt = Date.now() + data.expires_in * 1000;
  accounts.set(String(data.user_id), {
    userId: String(data.user_id),
    nickname: data.nickname || null,
    accessTokenEncrypted: encrypt(data.access_token),
    refreshTokenEncrypted: encrypt(data.refresh_token),
    expiresAt,
    updatedAt: Date.now(),
  });
}

async function getValidAccessToken(userId) {
  const account = accounts.get(String(userId));
  if (!account) throw new Error(`Account not found: ${userId}`);
  if (account.expiresAt > Date.now() + 60_000) return decrypt(account.accessTokenEncrypted);
  const data = await refreshAccessToken(account);
  saveAccount({ ...data, user_id: userId, nickname: account.nickname });
  return data.access_token;
}

function requireAdmin(req, res, next) {
  const provided = req.get('x-admin-token') || req.query.admin_token;
  if (provided !== config.adminToken) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Mercado Libre API Starter',
    login: '/meli/login',
    health: '/health',
    adminStatus: '/admin/status',
  });
});

app.get('/meli/login', (req, res) => {
  const url = new URL(`${config.authBase}/authorization`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', crypto.randomBytes(16).toString('hex'));
  res.redirect(url.toString());
});

app.get('/meli/oauth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ error: 'Authorization failed', detail: error });
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });

  // Temporary bridge for local development: the public callback stays registered in
  // Mercado Libre, then the authorization code is handed to the local ERP process.
  if (process.env.MELI_LOCAL_CALLBACK_URL) {
    const local = new URL(process.env.MELI_LOCAL_CALLBACK_URL);
    for (const [key, value] of Object.entries(req.query)) {
      if (value !== undefined) local.searchParams.set(key, String(value));
    }
    return res.redirect(local.toString());
  }

  try {
    const data = await exchangeCode(code);
    saveAccount(data);
    res.json({ ok: true, user_id: data.user_id, nickname: data.nickname || null });
  } catch (error) {
    console.error('OAuth callback failed', error);
    res.status(502).json({ error: 'Token exchange failed', detail: error.message });
  }
});

app.post('/meli/webhooks', (req, res) => {
  const { topic, resource } = req.body || {};
  webhookEvents.unshift({
    receivedAt: new Date().toISOString(),
    topic: topic || null,
    resource: resource || null,
  });
  webhookEvents.splice(100);
  res.json({ received: true });
});

app.get('/admin/status', requireAdmin, (req, res) => {
  res.json({
    accounts: [...accounts.values()].map((account) => ({
      user_id: account.userId,
      nickname: account.nickname,
      access_token_expires_at: new Date(account.expiresAt).toISOString(),
      updated_at: new Date(account.updatedAt).toISOString(),
    })),
    recent_webhooks: webhookEvents.slice(0, 50),
  });
});

app.get('/admin/accounts/:user_id/verify', requireAdmin, async (req, res) => {
  try {
    const token = await getValidAccessToken(req.params.user_id);
    const response = await fetch(`${config.apiBase}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    res.status(response.ok ? 200 : response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));
