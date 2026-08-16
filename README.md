# Wealth Worker

A full multi-page Cloudflare Worker app built from the uploaded treasury and loan ledger files, now extended with a monetizable technical-asset vault.

## Live site

The app is live on Cloudflare at:

- https://knockoutforever.com

`www.knockoutforever.com` redirects to the apex domain.

## Branding

- Custom Wealth Worker favicon
- Branded header treatment in the app shell

## Analytics and monitoring

- Cloudflare Web Analytics is enabled for the zone
- A Cloudflare health check monitors `https://knockoutforever.com/api/health`
- The app also exposes `/api/health` for simple uptime checks

## Hardware vault

- Browser entry point: `/?vault=hardware`
- JSON catalog: `/routes?catalog=hardware`
- Production access is controlled by the Worker secret `VAULT_TOKEN`
- The token may be supplied through the `x-vault-token` header or an authorized server-side access flow
- Do not put the production token in public links, source code, client-side JavaScript, or documentation
- Current vault is a catalog/access layer; payment and identity/checkout are not yet connected

## Pages

- `/` — home
- `/overview` — portfolio summary
- `/treasury` — Treasury General Account trend
- `/departments` — concentration analysis
- `/insights` — narrative analysis and build notes
- `/?vault=hardware` — enterprise hardware and architecture vault

## JSON routes

- `/api/health`
- `/api/summary`
- `/api/departments`
- `/api/tga`
- `/routes`
- `/routes?catalog=hardware`

## What it does

- Presents a polished dark analytics UI across multiple routes
- Embeds the supplied CSV data directly into the worker
- Shows headline wealth metrics, department concentration, and treasury movement
- Provides JSON endpoints for programmatic access
- Provides a gated catalog for technical artifacts and enterprise research
- Keeps the existing dashboard intact while adding a premium asset layer

## Run locally

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```

Before production vault access is enabled, configure the secret:

```bash
wrangler secret put VAULT_TOKEN
```