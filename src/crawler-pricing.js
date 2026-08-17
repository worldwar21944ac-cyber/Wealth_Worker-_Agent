/**
 * Wealth Worker — crawler monetization policy.
 *
 * Cloudflare Pay Per Crawl supplies `cf-pay-per-crawl: true` on eligible
 * crawler requests when dynamic pricing is enabled for the zone.
 * This module only declares the origin-side pricing decision and response
 * metadata; Cloudflare remains responsible for the Pay Per Crawl charge flow.
 */

export const CRAWLER_TIERS = Object.freeze({
  GPTBot: { price: "$3.50", description: "Full LLM training crawl per request" },
  ClaudeBot: { price: "$3.50", description: "Anthropic research/training extraction" },
  Bytespider: { price: "$4.00", description: "ByteDance high-frequency scraper" },
  CCBot: { price: "$2.00", description: "Common Crawl repository ingest" },
  default: { price: "$2.50", description: "Standard automated agent access" },
});

export function crawlerPriceFor(userAgent = "") {
  for (const [bot, config] of Object.entries(CRAWLER_TIERS)) {
    if (bot !== "default" && userAgent.includes(bot)) return config;
  }
  return CRAWLER_TIERS.default;
}

export function crawlerPricingHeaders(request) {
  const userAgent = request.headers.get("User-Agent") || "";
  const eligible = request.headers.get("cf-pay-per-crawl") === "true";
  const config = crawlerPriceFor(userAgent);

  return {
    "crawler-price": config.price,
    "cf-agent-readiness": "1.0",
    "x-content-license": eligible ? "commercial-pay-per-crawl" : "commercial-access-policy",
    "x-crawler-tier": userAgent || "unclassified",
  };
}

export function isCrawlerEligible(request) {
  return request.headers.get("cf-pay-per-crawl") === "true";
}
