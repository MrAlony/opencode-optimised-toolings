import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { disposeDispatcher, fetchBatch, formatFetchBatch, isPrivateAddress, resetFetchCache } from "../lib/fetch-core.js";

async function server(handler) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  return { instance, origin: `http://127.0.0.1:${instance.address().port}` };
}

test("disposes dispatchers across Node, Bun, and Undici capability shapes", async () => {
  const calls = [];

  await disposeDispatcher({ close: async () => { calls.push("async-close"); } });
  await disposeDispatcher({ close: () => { calls.push("sync-close"); } });
  await disposeDispatcher({ destroy: () => { calls.push("destroy-only"); } });
  await disposeDispatcher({
    close: () => { calls.push("close-throws"); throw new Error("unsupported close"); },
    destroy: async () => { calls.push("destroy-fallback"); },
  });
  await disposeDispatcher({});
  await disposeDispatcher(null);

  assert.deepEqual(calls, ["async-close", "sync-close", "destroy-only", "close-throws", "destroy-fallback"]);
});

test("dispatcher cleanup errors never replace a completed fetch result", async () => {
  await assert.doesNotReject(() => disposeDispatcher({
    close: () => { throw new Error("close failed"); },
    destroy: () => { throw new Error("destroy failed"); },
  }));
});

test("blocks private and reserved destinations by default", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateAddress(address), true, address);
  const result = await fetchBatch({ requests: [{ url: "http://127.0.0.1:1" }], cacheTtlSeconds: 0 });
  assert.equal(result.items[0].ok, false);
  assert.match(result.items[0].error, /private|local|reserved/i);
});

test("fetches multiple local test URLs only with explicit allow_private", async (t) => {
  const local = await server((request, response) => {
    if (request.url === "/json") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ok: true, nested: { value: 7 } })); return; }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>Example</title><main><h1>Primary heading</h1><p>Useful article text for extraction.</p></main><aside>noise</aside>");
  });
  t.after(() => local.instance.close());
  const result = await fetchBatch({ requests: [
    { url: `${local.origin}/page`, allow_private: true, format: "markdown", extract: "main" },
    { url: `${local.origin}/json`, allow_private: true, format: "json" },
  ], cacheTtlSeconds: 0 });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].ok, true);
  assert.match(result.items[0].content, /Primary heading/);
  assert.doesNotMatch(result.items[0].content, /noise/);
  assert.match(result.items[1].content, /"value": 7/);
});

test("supports CSS extraction and bounded source bodies", async (t) => {
  const local = await server((_request, response) => { response.setHeader("content-type", "text/html"); response.end(`<div id="target">selected</div><div>${"x".repeat(100_000)}</div>`); });
  t.after(() => local.instance.close());
  const selected = await fetchBatch({ requests: [{ url: local.origin, allow_private: true, selector: "#target", format: "text" }], cacheTtlSeconds: 0 });
  assert.equal(selected.items[0].content.trim(), "selected");
  const bounded = await fetchBatch({ requests: [{ url: local.origin, allow_private: true, max_source_bytes: 16_384, format: "text", extract: "all" }], cacheTtlSeconds: 0 });
  assert.equal(bounded.items[0].sourceTruncated, true);
  assert.equal(bounded.items[0].sourceBytes, 16_384);
});

test("strips authorization on cross-origin redirects", async (t) => {
  let observed = "unset";
  const destination = await server((request, response) => { observed = request.headers.authorization || ""; response.end("done"); });
  const source = await server((_request, response) => { response.writeHead(302, { Location: destination.origin }); response.end(); });
  t.after(() => { source.instance.close(); destination.instance.close(); });
  const result = await fetchBatch({ requests: [{ url: source.origin, allow_private: true, headers: { Authorization: "Bearer should-not-forward" }, format: "text" }], cacheTtlSeconds: 0 });
  assert.equal(result.items[0].ok, true);
  assert.equal(observed, "");
  assert.equal(result.items[0].redirects.length, 1);
});

test("retries transient failures only within the configured bound", async (t) => {
  let calls = 0;
  const local = await server((_request, response) => { calls += 1; if (calls === 1) { response.writeHead(503); response.end("retry"); } else response.end("recovered"); });
  t.after(() => local.instance.close());
  const result = await fetchBatch({ requests: [{ url: local.origin, allow_private: true, retries: 1, format: "text" }], cacheTtlSeconds: 0 });
  assert.equal(calls, 2);
  assert.equal(result.items[0].attempts, 2);
  assert.match(result.items[0].content, /recovered/);
});

test("distributes one adaptive output pool and reports omissions", async (t) => {
  const local = await server((request, response) => { response.end(request.url === "/small" ? "small" : "L".repeat(80_000)); });
  t.after(() => local.instance.close());
  const result = await fetchBatch({ requests: [
    { url: `${local.origin}/small`, allow_private: true, format: "text" },
    { url: `${local.origin}/large`, allow_private: true, format: "text" },
  ], cacheTtlSeconds: 0, outputBudgetBytes: 20_000 });
  assert.equal(result.items[0].rendered.truncated, false);
  assert.equal(result.items[1].rendered.truncated, true);
  assert.ok(result.items[1].rendered.omittedBytes > 0);
  assert.match(formatFetchBatch(result), /OMITTED \d+ EXTRACTED BYTES/);
});

test("successful responses are cached by exact extraction request", async (t) => {
  resetFetchCache();
  let calls = 0;
  const local = await server((_request, response) => { calls += 1; response.end("cacheable"); });
  t.after(() => local.instance.close());
  const args = { requests: [{ url: local.origin, allow_private: true, format: "text" }], cacheTtlSeconds: 60 };
  await fetchBatch(args);
  const second = await fetchBatch(args);
  assert.equal(calls, 1);
  assert.equal(second.items[0].cached, true);
});
