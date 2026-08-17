# Wealth Worker — Crawler Monetization

## Purpose

This repository contains the Wealth Worker Cloudflare Worker plus the origin-side policy artifacts for commercial AI-crawler access.

## Cloudflare Pay Per Crawl

Cloudflare AI Crawl Control supports Pay Per Crawl and dynamic pricing. When dynamic pricing is enabled, Cloudflare can send `cf-pay-per-crawl: true` to the origin. The origin can return `crawler-price` to select the price for an eligible request.

The repository's pricing policy lives in `src/crawler-pricing.js`.

### Current policy

| Crawler | Price/request |
|---|---:|
| GPTBot | $3.50 |
| ClaudeBot | $3.50 |
| Bytespider | $4.00 |
| CCBot | $2.00 |
| Default | $2.50 |

### Route manifest

`public/crawlers.json` publishes route-level discovery metadata:

- `/api/tga` — $0.50/request
- `/api/summary` — $1.00/request
- `/vault/*` — $5.00/request

The manifest is descriptive. It does not itself collect money.

## Important deployment condition

Adding these files to GitHub does **not** enable Pay Per Crawl in Cloudflare. The zone must be configured in Cloudflare AI Crawl Control, and the Worker/origin must return the pricing header on the production request path.

Do not report crawler revenue until live Cloudflare metrics show crawler requests and successful paid transactions/referrals.

## Testing checklist

1. Confirm `knockoutforever.com/crawlers.json` is served by the intended Worker or static asset path.
2. Confirm `/robots.txt` is served and contains the intended crawler directives.
3. Enable Pay Per Crawl in the Cloudflare zone only after reviewing the route policy.
4. Send an eligible test crawler request and inspect `crawler-price`.
5. Confirm Cloudflare AI Crawl Control metrics record the traffic.
6. Keep human and ordinary search-engine access unaffected.

## Revenue model

The $407,000 Year-1 figure is an internal scenario, not a guaranteed result. Actual revenue depends on crawler volume, crawler participation, pricing, payment completion, human conversion, refunds, fees, and platform availability.
