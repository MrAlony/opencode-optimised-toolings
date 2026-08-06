import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatStatus, formatStealth } from "../lib/format.js"
import { runtimeRoot, stealthConfig } from "../lib/config.js"
import { parseSearchResults, StealthWorkerClient } from "../lib/worker-client.js"
import { controlCommand, ensureTorBinary, torrcContent } from "../lib/tor.js"

test("formats bounded stealth evidence with explicit Tor state", () => {
  const output = formatStealth("fetch", { tor: { bootstrapped: true, authenticated: true, socks_port: 19050 }, items: [{ ok: true, url: "https://example.com", content: "x".repeat(5000) }] }, 2000)
  assert.match(output, /STEALTH FETCH RESULT: SUCCESS/)
  assert.match(output, /control authentication=cookie/)
  assert.match(output, /OMITTED \d+ BYTES/)
})

test("stealth runtime is user-owned and has no Python requirement", () => {
  const config = stealthConfig()
  assert.equal("python" in config, false)
  assert.match(runtimeRoot.replaceAll("\\", "/"), /(?:runtime\/stealth|alonix\/runtime\/stealth)$/)
})

test("search parser handles both DuckDuckGo HTML and Lite result shapes", () => {
  const html = `<div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fone">HTML result</a><a class="result__snippet">First snippet</a></div><table><tr><td><a class="result-link" href="https://example.com/two">Lite result</a><span class="result-snippet">Second snippet</span></td></tr></table>`
  const rows = parseSearchResults(html, 5)
  assert.equal(rows.length, 2)
  assert.match(rows[0], /https:\/\/example\.com\/one/)
  assert.match(rows[1], /Lite result/)
})

test("status is instant and provisioning remains lazy", async () => {
  const client = new StealthWorkerClient()
  const status = await client.request("status")
  assert.equal(status.worker, true)
  assert.match(status.tor_executable, /auto-download|tor/i)
  await client.stop()
})

test("Tor configuration uses native escaped paths and captured process logs", () => {
  const content = torrcContent("C:\\Users\\Example User\\alonix", 19050, 19051)
  assert.match(content, /DataDirectory "C:\\\\Users\\\\Example User\\\\alonix\\\\tor-data"/)
  assert.match(content, /CookieAuthFile "C:\\\\Users\\\\Example User\\\\alonix\\\\control_auth_cookie"/)
  assert.doesNotMatch(content, /Log\s+notice\s+file/i)
})

test("explicit Tor override needs no download", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-tor-override-"))
  try {
    const binary = join(root, process.platform === "win32" ? "tor.exe" : "tor")
    mkdirSync(root, { recursive: true }); writeFileSync(binary, "fixture")
    assert.equal(await ensureTorBinary(join(root, "runtime"), binary), binary)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("Tor control responses retain bootstrap detail until the terminating OK", async () => {
  const { createServer } = await import("node:net")
  const root = mkdtempSync(join(tmpdir(), "alonix-tor-control-"))
  const cookie = join(root, "cookie")
  writeFileSync(cookie, Buffer.from("abcd", "hex"))
  const server = createServer((socket) => {
    socket.setEncoding("utf8")
    let authenticated = false
    socket.on("data", (value) => {
      if (!authenticated && value.includes("AUTHENTICATE")) { authenticated = true; socket.write("250 OK\r\n"); return }
      if (value.includes("GETINFO")) socket.write('250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=100 TAG=done\r\n250 OK\r\n')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
  try {
    const detail = await controlCommand(server.address().port, cookie, "GETINFO status/bootstrap-phase")
    assert.match(detail, /PROGRESS=100/)
    assert.match(detail, /250 OK/)
  } finally { await new Promise((resolvePromise) => server.close(resolvePromise)); rmSync(root, { recursive: true, force: true }) }
})

test("status distinguishes configured worker from Tor bootstrap", () => {
  const output = formatStatus({ ready: true, worker: true, tor_executable: "/tor", tor: { owned: false, bootstrapped: false, authenticated: false }, browser: false })
  assert.match(output, /STEALTH STATUS: READY/)
  assert.match(output, /Tor bootstrapped: no/)
})
