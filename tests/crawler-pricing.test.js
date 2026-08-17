import test from "node:test";
import assert from "node:assert/strict";
import { crawlerPriceFor } from "../src/crawler-pricing.js";

test("prices GPTBot", () => {
  assert.equal(crawlerPriceFor("Mozilla/5.0 GPTBot/1.0").price, "$3.50");
});

test("prices ClaudeBot", () => {
  assert.equal(crawlerPriceFor("ClaudeBot/1.0").price, "$3.50");
});

test("prices Bytespider", () => {
  assert.equal(crawlerPriceFor("Bytespider").price, "$4.00");
});

test("prices CCBot", () => {
  assert.equal(crawlerPriceFor("CCBot/2.0").price, "$2.00");
});

test("falls back to default", () => {
  assert.equal(crawlerPriceFor("Mozilla/5.0").price, "$2.50");
});
