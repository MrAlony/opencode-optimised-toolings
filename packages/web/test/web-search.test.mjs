import test from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
process.env.SERPER_API_KEY = "test-only-serper";
process.env.TAVILY_API_KEY = "test-only-tavily";
process.env.EXA_API_KEY = "test-only-exa";
process.env.FIRECRAWL_API_KEY = "test-only-firecrawl";
const responses = new Map();

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  const body = init.body ? JSON.parse(init.body) : {};
  const query = body.q || body.query || new URL(href).searchParams.get("q") || "";
  const key = `${href.includes("serper") ? "serper" : href.includes("tavily") ? "tavily" : href.includes("exa") ? "exa" : href.includes("firecrawl") ? "firecrawl" : "other"}:${query}`;
  const value = responses.get(key);
  if (value instanceof Error) throw value;
  if (value && typeof value === "object" && value.__http) {
    return { ok: false, status: value.__http, json: async () => ({}), text: async () => String(value.body || "") };
  }
  if (!value) return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { ok: true, status: 200, json: async () => value, text: async () => text };
};

const { WebToolingPlugin } = await import("../index.js");
const { resetBreaker } = await import("../lib/search-core.js");
const plugin = await WebToolingPlugin();

test.after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SERPER_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.EXA_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
});

test("batches independent fallback queries", async () => {
  responses.set("serper:alpha", { organic: [{ title: "Alpha", link: "https://example.com/a", snippet: "A result" }] });
  responses.set("serper:beta", { organic: [{ title: "Beta", link: "https://example.com/b", snippet: "B result" }] });
  const output = await plugin.tool["alonix-web-search"].execute({
    queries: [{ query: "alpha" }, { query: "beta" }],
    backends: ["serper"],
  }, { sessionID: "batch" });
  assert.match(output, /WEB SEARCH RESULT: SUCCESS/);
  assert.match(output, /WHAT HAPPENED: 2 of 2 query\(s\) returned results/);
  assert.match(output, /Alpha/);
  assert.match(output, /Beta/);
  assert.match(output, /2 query\(s\)/);
});

test("fallback records a failed backend before success", async () => {
  responses.set("serper:fallback", new Error("serper down"));
  responses.set("tavily:fallback", { answer: "Recovered answer", results: [] });
  const output = await plugin.tool["alonix-web-search"].execute({
    queries: [{ query: "fallback" }],
    backends: ["serper", "tavily"],
    cache_ttl_seconds: 0,
  }, { sessionID: "fallback" });
  assert.match(output, /Backend attempts:/);
  assert.match(output, /serper: error: serper down/);
  assert.match(output, /tavily: ok/);
  assert.match(output, /serper=error: serper down/);
  assert.match(output, /tavily=ok/);
  assert.match(output, /Recovered answer/);
});

test("aggregate deduplicates canonical URLs", async () => {
  responses.set("serper:dedupe", { organic: [{ title: "One", link: "https://example.com/page?utm_source=x", snippet: "first" }] });
  responses.set("tavily:dedupe", { results: [{ title: "One duplicate", url: "https://example.com/page", content: "second" }] });
  const output = await plugin.tool["alonix-web-search"].execute({
    queries: [{ query: "dedupe", max_results: 10 }],
    strategy: "aggregate",
    backends: ["serper", "tavily"],
    cache_ttl_seconds: 0,
  }, { sessionID: "dedupe" });
  assert.equal((output.match(/URL: https:\/\/example\.com\/page/g) || []).length, 1);
});

test("exact consecutive duplicate queries warn without discouraging legitimate singleton research", async () => {
  responses.set("serper:repeat", { organic: [{ title: "Repeat", link: "https://example.com/r", snippet: "result" }] });
  const args = { queries: [{ query: "repeat" }], backends: ["serper"] };
  const context = { sessionID: "repeat" };
  const first = await plugin.tool["alonix-web-search"].execute(args, context);
  const second = await plugin.tool["alonix-web-search"].execute(args, context);
  assert.doesNotMatch(first, /EFFICIENCY NOTICE|BATCHING ADVICE|DUPLICATE/);
  assert.match(second, /DUPLICATE WEB SEARCH WARNING/);
  assert.match(second, /cache: hit/);
});

test("quota error trips breaker and later calls skip the cooled-down backend", async () => {
  resetBreaker();
  responses.set("serper:quota", { __http: 400, body: '{"message":"Not enough credits"}' });
  responses.set("tavily:quota", { answer: "Fallback answer", results: [] });
  const args = { queries: [{ query: "quota" }], backends: ["serper", "tavily"], cache_ttl_seconds: 0 };
  const first = await plugin.tool["alonix-web-search"].execute(args, { sessionID: "breaker" });
  assert.match(first, /serper=error: HTTP 400: \{"message":"Not enough credits"\}/);
  assert.match(first, /tavily=ok/);
  const second = await plugin.tool["alonix-web-search"].execute(args, { sessionID: "breaker" });
  assert.match(second, /serper=skipped \(cooldown/);
  assert.match(second, /tavily=ok/);
  resetBreaker();
});

test("duckduckgo parser drops ad results", async () => {
  const html = [
    '<div class="result__body">',
    '<a class="result__a" href="//duckduckgo.com/y.js?ad_domain=spam.com&ad_provider=bingv7aa">Sponsored Junk</a>',
    '<a class="result__snippet" href="#">Ad snippet</a>',
    "</div>",
    '<div class="result__body">',
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example.org%2Fpage">Real Result</a>',
    '<a class="result__snippet" href="#">Real snippet</a>',
    "</div>",
  ].join("");
  responses.set("other:ads", html);
  const output = await plugin.tool["alonix-web-search"].execute({
    queries: [{ query: "ads", backend: "duckduckgo" }],
    cache_ttl_seconds: 0,
  }, { sessionID: "ads" });
  assert.match(output, /Real Result/);
  assert.match(output, /URL: https:\/\/real\.example\.org\/page/);
  assert.doesNotMatch(output, /Sponsored Junk/);
});
