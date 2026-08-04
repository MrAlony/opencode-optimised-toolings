import test from "node:test";
import assert from "node:assert/strict";
import { formatStatus, formatStealth } from "../lib/format.js";

test("formats bounded stealth evidence with explicit Tor state", () => {
  const output = formatStealth("fetch", { tor: { bootstrapped: true, authenticated: true, socks_port: 19050 }, items: [{ ok: true, url: "https://example.com", content: "x".repeat(5000) }] }, 2000);
  assert.match(output, /STEALTH FETCH RESULT: SUCCESS/);
  assert.match(output, /control authentication=cookie/);
  assert.match(output, /OMITTED \d+ BYTES/);
});

test("status distinguishes configured worker from Tor bootstrap", () => {
  const output = formatStatus({ ready: true, worker: true, tor_executable: "/tor", tor: { owned: false, bootstrapped: false, authenticated: false }, browser: false });
  assert.match(output, /STEALTH STATUS: READY/);
  assert.match(output, /Tor bootstrapped: no/);
});
