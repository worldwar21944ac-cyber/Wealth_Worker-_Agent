# Wealth Worker

A full multi-page Cloudflare Worker app built from the uploaded treasury and loan ledger files.

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

## What it does

- Presents a polished dark analytics UI across multiple routes
- Embeds the supplied CSV data directly into the worker
- Shows headline wealth metrics, department concentration, and treasury movement
- Provides JSON endpoints for programmatic access

## Run locally

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```
