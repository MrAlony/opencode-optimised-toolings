import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { createConnection } from "node:net"
import { parseHTML } from "linkedom"
import TurndownService from "turndown"
import { chromium, request as patchrightRequest } from "patchright"
import { stealthConfig } from "./config.js"
import { controlCommand, ensureTorBinary, launchTor, waitForTor } from "./tor.js"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
const MAX_ITEM_BYTES = 2 * 1024 * 1024
const DDG = ["https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/", "http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/html"]
const markdown = new TurndownService({ headingStyle: "atx" })
const require = createRequire(import.meta.url)
let browserInstall = null

function portOpen(port) { return new Promise((resolvePromise) => { const socket = createConnection({ host: "127.0.0.1", port }); const done = (value) => { socket.destroy(); resolvePromise(value) }; socket.setTimeout(500); socket.once("connect", () => done(true)); socket.once("timeout", () => done(false)); socket.once("error", () => done(false)) }) }
function publicUrl(value, allowPrivate = false) { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error("A fully formed HTTP or HTTPS URL is required."); if (url.username || url.password) throw new Error("Credentials embedded in URLs are not allowed."); const host = url.hostname.toLowerCase(); if (!allowPrivate && (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(host))) throw new Error("Private, local, and metadata destinations are blocked by default."); return url.toString() }
function converted(html, text, format) { if (format === "html") return html; if (format === "text") return text; return markdown.turndown(html) }
function bounded(content) { const body = String(content ?? ""); return { content: body.slice(0, MAX_ITEM_BYTES), source_truncated: Buffer.byteLength(body) > MAX_ITEM_BYTES } }
async function boundedMap(items, concurrency, worker) { const rows = Array.from(items ?? []); const output = new Array(rows.length); let cursor = 0; const run = async () => { while (cursor < rows.length) { const index = cursor++; output[index] = await worker(rows[index], index) } }; await Promise.all(Array.from({ length: Math.min(Math.max(1, Number(concurrency) || 3), 4, rows.length) }, run)); return output }
async function ensureBrowserInstalled() {
  const executable = chromium.executablePath()
  if (existsSync(executable)) return executable
  if (browserInstall) return browserInstall
  browserInstall = new Promise((resolvePromise, reject) => {
    const cli = require.resolve("patchright/cli")
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let tail = ""
    const collect = (chunk) => { tail = (tail + String(chunk)).slice(-4000) }
    child.stdout.on("data", collect); child.stderr.on("data", collect)
    child.once("error", reject)
    child.once("close", (code) => code === 0 && existsSync(chromium.executablePath()) ? resolvePromise(chromium.executablePath()) : reject(new Error(`Patchright Chromium installation failed with code ${code}: ${tail.slice(-1500)}`)))
  }).finally(() => { browserInstall = null })
  return browserInstall
}

export function parseSearchResults(html, maximum = 10) {
  const { document } = parseHTML(html)
  const rows = []
  for (const link of document.querySelectorAll("a.result__a, a.result-link")) {
    const href = link.getAttribute("href") || ""
    if (!href || href.includes("y.js") || href.includes("ad_provider=")) continue
    let actual = href
    try { const parsed = new URL(href, "https://html.duckduckgo.com"); actual = decodeURIComponent(parsed.searchParams.get("uddg") || parsed.href) } catch {}
    const parent = link.closest("div.result") || link.closest("tr") || link.parentElement
    const snippet = parent?.querySelector(".result__snippet, .result-snippet")?.textContent?.trim() || ""
    const title = link.textContent?.trim() || ""
    if (!title || !actual) continue
    rows.push(`${rows.length + 1}. ${title}\n   ${actual}\n   ${snippet}`)
    if (rows.length >= maximum) break
  }
  return rows
}

export class StealthWorkerClient {
  constructor() { this.tor = null; this.browser = null; this.context = null; this.starting = null; this.lastNewnym = 0 }

  async ensureTor() {
    if (this.tor?.child?.exitCode === null && await portOpen(this.tor.config.socksPort)) return this.tor
    if (this.starting) return this.starting
    this.starting = (async () => {
      const config = stealthConfig()
      const binary = await ensureTorBinary(config.runtimeRoot, config.tor)
      if (await portOpen(config.socksPort) || await portOpen(config.controlPort)) throw new Error("Dedicated stealth Tor ports are occupied by an unverifiable process")
      const launched = await launchTor(binary, config.runtimeRoot, config.socksPort, config.controlPort)
      await waitForTor(config.controlPort, launched.cookie, launched.child, 75_000, launched.output)
      this.tor = { ...launched, binary, config }
      return this.tor
    })().finally(() => { this.starting = null })
    return this.starting
  }

  async ensureBrowser() {
    const tor = await this.ensureTor()
    if (this.context) return this.context
    await ensureBrowserInstalled()
    this.browser = await chromium.launch({ headless: true, proxy: { server: `socks5://127.0.0.1:${tor.config.socksPort}` } })
    this.context = await this.browser.newContext({ userAgent: UA })
    return this.context
  }

  async fetchItem(spec) {
    const raw = String(spec.url ?? "")
    try {
      const url = publicUrl(raw, spec.allow_private === true)
      const timeout = Math.max(1000, Math.min(Number(spec.timeout_ms) || 60_000, 120_000))
      const tor = await this.ensureTor()
      let html = "", text = "", finalUrl = url, status = 0, title = ""
      if (spec.render_js !== false) {
        const context = await this.ensureBrowser(); const page = await context.newPage()
        try {
          const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout })
          if (spec.wait_for) { const value = String(spec.wait_for); if (/^\d+$/.test(value)) await page.waitForTimeout(Math.min(Number(value), 30_000)); else await page.waitForSelector(value, { timeout: Math.min(timeout, 30_000) }) }
          const locator = spec.selector ? page.locator(String(spec.selector)).first() : page.locator("body")
          if (!await locator.count()) throw new Error(`CSS selector was not found: ${spec.selector}`)
          html = await locator.innerHTML(); text = await locator.innerText(); finalUrl = page.url(); status = response?.status() ?? 0; title = await page.title()
        } finally { await page.close() }
      } else {
        const client = await patchrightRequest.newContext({ proxy: { server: `socks5://127.0.0.1:${tor.config.socksPort}` }, userAgent: UA, timeout })
        try { const response = await client.get(url); status = response.status(); finalUrl = response.url(); html = await response.text(); const { document } = parseHTML(html); const node = spec.selector ? document.querySelector(String(spec.selector)) : document.body; if (!node) throw new Error(`CSS selector was not found: ${spec.selector}`); html = node.innerHTML; text = node.textContent || ""; title = document.title || "" } finally { await client.dispose() }
      }
      return { ok: true, url, final_url: finalUrl, status, title, ...bounded(converted(html, text, spec.format || "markdown")) }
    } catch (error) { return { ok: false, url: raw, error: error?.message ?? String(error), content: "" } }
  }

  async searchItem(spec) {
    const query = String(spec.query ?? "").trim(); const maximum = Math.max(1, Math.min(Number(spec.max_results) || 10, 20)); if (!query) return { ok: false, query, error: "Query must not be empty", content: "" }
    const tor = await this.ensureTor(); const client = await patchrightRequest.newContext({ proxy: { server: `socks5://127.0.0.1:${tor.config.socksPort}` }, userAgent: UA, timeout: 60_000 }); const errors = []
    try { for (const url of DDG) { try { const response = await client.post(url, { form: { q: query, b: "", kl: "wt-wt" } }); if (!response.ok()) throw new Error(`HTTP ${response.status()}`); const rows = parseSearchResults(await response.text(), maximum); if (rows.length) return { ok: true, query, backend: url, content: rows.join("\n\n") }; errors.push(`${url}: no parseable results`) } catch (error) { errors.push(`${url}: ${error?.message ?? error}`) } } } finally { await client.dispose() }
    return { ok: false, query, error: `All bounded DuckDuckGo Tor routes failed. ${errors.join(" | ")}`, content: "" }
  }

  async request(action, payload = {}) {
    if (action === "status") { const config = stealthConfig(); const tor = this.tor; return { ready: Boolean(config.tor || tor), worker: true, tor_executable: tor?.binary || config.tor || "auto-download on first use", tor: { owned: Boolean(tor?.child?.exitCode === null), bootstrapped: Boolean(tor && await portOpen(config.socksPort)), authenticated: Boolean(tor?.cookie && existsSync(tor.cookie)), socks_port: config.socksPort, control_port: config.controlPort }, browser: Boolean(this.context), detail: tor ? "managed Node runtime" : "Tor will be checksum-verified and provisioned lazily" } }
    if (action === "fetch_many") return { items: await boundedMap(payload.requests, payload.max_concurrency, (item) => this.fetchItem(item)), tor: (await this.request("status")).tor }
    if (action === "search_many") return { items: await boundedMap(payload.queries, payload.max_concurrency, (item) => this.searchItem(item)), tor: (await this.request("status")).tor }
    if (action === "rotate") { const tor = await this.ensureTor(); const wait = Math.max(0, 10_000 - (Date.now() - this.lastNewnym)); if (wait) await new Promise((resolvePromise) => setTimeout(resolvePromise, wait)); const message = await controlCommand(tor.config.controlPort, tor.cookie, "SIGNAL NEWNYM"); this.lastNewnym = Date.now(); await this.context?.close().catch(() => {}); await this.browser?.close().catch(() => {}); this.context = this.browser = null; return { message, waited_seconds: Math.round(wait / 10) / 100, browser_rebuilt: true } }
    throw new Error(`Unknown stealth action: ${action}`)
  }

  async stop() { await this.context?.close().catch(() => {}); await this.browser?.close().catch(() => {}); if (this.tor?.child?.exitCode === null) { await controlCommand(this.tor.config.controlPort, this.tor.cookie, "SIGNAL SHUTDOWN").catch(() => this.tor.child.kill("SIGTERM")) } this.context = this.browser = this.tor = null }
}
