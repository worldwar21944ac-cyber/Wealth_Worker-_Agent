# Wealth Worker

A full multi-page Cloudflare Worker app built from the uploaded treasury and loan ledger files.

## Live site

The app is live on Cloudflare at:

- https://knockoutforever.com

`www.knockoutforever.com` redirects to the apex domain.

## Branding

- Custom Wealth Worker favicon
- Simple branded header treatment in the app shell

## Analytics and monitoring

- Cloudflare Web Analytics is enabled for the zone
- A Cloudflare health check monitors `https://knockoutforever.com/api/health`
- The app also exposes `/api/health` for simple uptime checks

## Hardware vault

- Open the vault mode at `https://knockoutforever.com/?vault=hardware`
- Send the access token as the `token` query parameter or the `x-vault-token` header
- Query the hardware catalog as JSON at `https://knockoutforever.com/routes?catalog=hardware`

## Pages

- `/` — home
- `/overview` — portfolio summary
- `/treasury` — Treasury General Account trend
- `/departments` — concentration analysis
- `/insights` — narrative analysis and build notes

## JSON routes

- `/api/health`
- `/api/summary`
- `/api/departments`
- `/api/tga`
- `/routes`
- `/favicon.svg`

## What it does

- Presents a polished dark analytics UI across multiple routes
- Embeds the supplied CSV data directly into the worker
- Shows headline wealth metrics, department concentration, and treasury movement
- Provides JSON endpoints for programmatic access
- Serves a branded favicon and canonical www-to-apex redirect

## Run locally

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```