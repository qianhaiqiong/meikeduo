# Mercado Libre API Starter

A small Node.js service for Mercado Libre Global Selling (CBT) OAuth authorization and webhook receiving. It is designed to deploy on Render.

## Features

- OAuth login: `GET /meli/login`
- OAuth callback: `GET /meli/oauth/callback`
- Webhook receiver: `POST /meli/webhooks`
- Health check: `GET /health`
- Admin status: `GET /admin/status`
- Account verification: `GET /admin/accounts/:user_id/verify`

Tokens and refresh tokens are encrypted before being stored in PostgreSQL.

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Set all variables in `.env` before starting.

## Deploy to Render

1. Push this project to your GitHub repository.
2. In Render, choose **New -> Blueprint** and select the repository. Render reads `render.yaml`.
3. Fill these secret values when prompted:
   - `MELI_CLIENT_ID`
   - `MELI_CLIENT_SECRET`
   - `MELI_REDIRECT_URI`
4. Deploy the service.
5. Add your custom domain in Render and point your DNS `CNAME` to the target Render provides.
6. Use these URLs in Mercado Libre Dev Center:
   - Redirect URI: `https://your-domain.com/meli/oauth/callback`
   - Notification callback URL: `https://your-domain.com/meli/webhooks`

## Verify the Service

```bash
curl https://your-domain.com/health
```

Authorize a seller:

```text
https://your-domain.com/meli/login
```

Check saved accounts and recent webhooks:

```bash
curl -H "x-admin-token: YOUR_ADMIN_TOKEN" https://your-domain.com/admin/status
```

Verify an account can call the API:

```bash
curl -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  https://your-domain.com/admin/accounts/USER_ID/verify
```

## Security Notes

- Never commit `.env`.
- Never expose the database connection string.
- Keep `ADMIN_TOKEN` and `TOKEN_ENCRYPTION_KEY` long and random.
- Keep these two Render values unchanged after deployment. Changing `TOKEN_ENCRYPTION_KEY` makes previously saved tokens unreadable.
