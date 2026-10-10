const crypto = require('crypto');
const express = require('express');
const { Client } = require('pg');

const app = express();
app.use(express.json({ limit: '256kb' }));

const requiredVars = [
  'MELI_CLIENT_ID',
  'MELI_CLIENT_SECRET',
  'MELI_REDIRECT_URI',
  'ADMIN_TOKEN',
  'TOKEN_ENCRYPTION_KEY',
  'DATABASE_URL',
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

const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
db.connect().then(() => console.log('Database connected'));

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS meli_accounts (
      user_id TEXT PRIMARY KEY,
      nickname TEXT,
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT NOT NULL,
      access_token_expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      id BIGSERIAL PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      topic TEXT,
      resource TEXT,
      body JSONB NOT NULL
    );
  `);
}

async function saveAccount(tokenResponse) {
  const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);
  await db.query(
    `INSERT INTO meli_accounts
      (user_id, nickname, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       nickname = EXCLUDED.nickname,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       updated_at = NOW()`,
    [
      String(tokenResponse.user_id),
      tokenResponse.nickname || null,
      encrypt(tokenResponse.access_token),
      encrypt(tokenResponse.refresh_token),
      expiresAt,
    ]
  );
}

async function getAccount(userId) {
  const result = await db.query('SELECT * FROM meli_accounts WHERE user_id = $1', [String(userId)]);
  return result.rows[0] || null;
}

async function listAccounts() {
  const result = await db.query(
    `SELECT user_id, nickname, access_token_expires_at, updated_at FROM meli_accounts ORDER BY updated_at DESC`
  );
  return result.rows;
}

async function getValidAccessToken(userId) {
  const account = await getAccount(userId);
  if (!account) throw new Error(`Account not found: ${userId}`);
  if (new Date(account.access_token_expires_at).getTime() > Date.now() + 60_000) {
    return decrypt(account.access_token_encrypted);
  }

  const response = await fetch(`${config.apiBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: decrypt(account.refresh_token_encrypted),
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  await saveAccount({ ...data, user_id: userId, nickname: account.nickname });
  return data.access_token;
}

function requireAdmin(req, res, next) {
  const provided = req.get('x-admin-token') || req.query.admin_token;
  if (provided !== config.adminToken) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', time: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'error', message: error.message });
  }
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
  const state = crypto.randomBytes(16).toString('hex');
  const url = new URL(`${config.authBase}/authorization`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/meli/oauth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ error: 'Authorization failed', detail: error });
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });

  try {
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
    await saveAccount(data);
    res.json({ ok: true, user_id: data.user_id, nickname: data.nickname || null });
  } catch (error) {
    console.error('OAuth callback failed', error);
    res.status(502).json({ error: 'Token exchange failed', detail: error.message });
  }
});

app.post('/meli/webhooks', async (req, res) => {
  const { topic, resource } = req.body || {};
  try {
    await db.query('INSERT INTO webhook_events (topic, resource, body) VALUES ($1, $2, $3)', [
      topic || null,
      resource || null,
      JSON.stringify(req.body),
    ]);
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook storage failed', error);
    res.status(200).json({ received: true, stored: false });
  }
});

app.get('/admin/status', requireAdmin, async (req, res) => {
  const accounts = await listAccounts();
  const events = await db.query(
    'SELECT id, received_at, topic, resource FROM webhook_events ORDER BY id DESC LIMIT 50'
  );
  res.json({ accounts, recent_webhooks: events.rows });
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

initDb()
  .then(() => {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Listening on port ${port}`));
  })
  .catch((error) => {
    console.error('Startup failed', error);
    process.exit(1);
  });
