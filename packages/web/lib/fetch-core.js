import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import pdfParse from "pdf-parse";

const cache = new Map();
const MAX_REQUESTS = 10;
const MAX_REDIRECTS = 6;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SHARED_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "template", "svg", "canvas"]);

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value ?? fallback);
  return Math.min(Math.max(Number.isFinite(number) ? Math.floor(number) : fallback, minimum), maximum);
}

function normalizeUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("URL must be a fully formed absolute URL."); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported.");
  if (url.username || url.password) throw new Error("Credentials embedded in URLs are not allowed.");
  return url;
}

function ipv4Private(ip) {
  const p = ip.split('.').map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
    || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
    || (p[0] === 169 && p[1] === 254)
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && (p[1] === 0 || p[1] === 168 || (p[1] === 88 && p[2] === 99)))
    || (p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51))
    || (p[0] === 203 && p[1] === 0 && p[2] === 113);
}

function ipv6Private(ip) {
  const value = ip.toLowerCase().split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return ipv4Private(mapped[1]);
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
    || /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8:');
}

export function isPrivateAddress(ip) {
  const version = isIP(ip);
  return version === 4 ? ipv4Private(ip) : version === 6 ? ipv6Private(ip) : true;
}

async function resolveAndValidate(url, allowPrivate) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (['localhost', 'localhost.localdomain'].includes(hostname.toLowerCase())) {
    if (!allowPrivate) throw new Error("Local and private destinations are blocked by default; set allow_private=true only for deliberate local access.");
    return [{ address: hostname, family: 0 }];
  }
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error(`DNS returned no addresses for ${hostname}.`);
  if (!allowPrivate && addresses.some((item) => isPrivateAddress(item.address))) throw new Error(`Destination ${hostname} resolves to a private, local, reserved, or non-routable address.`);
  return addresses;
}

function dispatcherFor(addresses) {
  let next = 0;
  const pinned = addresses.map((item) => ({ address: item.address, family: item.family || 0 }));
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (options?.all) { callback(null, pinned); return; }
        const compatible = options?.family ? pinned.filter((item) => item.family === options.family) : pinned;
        const pool = compatible.length ? compatible : pinned;
        const item = pool[next++ % pool.length];
        callback(null, item.address, item.family);
      },
    },
  });
}

async function readBodyBounded(response, maximum) {
  const reader = response.body?.getReader();
  if (!reader) return { buffer: Buffer.alloc(0), truncated: false };
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > maximum) {
        const remaining = Math.max(0, maximum - bytes);
        if (remaining) chunks.push(Buffer.from(value.subarray(0, remaining)));
        bytes = maximum;
        truncated = true;
        await reader.cancel("body limit reached");
        break;
      }
      chunks.push(Buffer.from(value));
      bytes += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  return { buffer: Buffer.concat(chunks, bytes), truncated };
}

function decodeText(buffer, contentType) {
  const charset = /charset\s*=\s*([^;\s]+)/i.exec(contentType)?.[1]?.replace(/["']/g, '').toLowerCase();
  if (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset)) {
    try { return new TextDecoder(charset).decode(buffer); } catch {}
  }
  return buffer.toString('utf8');
}

function selectHtml(html, url, selector, extraction) {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll('script,style,noscript,template,svg,canvas')) node.remove();
  if (selector) {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`CSS selector was not found: ${selector}`);
    return { title: document.title || '', html: node.outerHTML, text: node.textContent || '' };
  }
  if (extraction === 'main') {
    const semantic = document.querySelector('main, article, [role="main"]');
    if (semantic) return { title: document.title || '', html: semantic.outerHTML, text: semantic.textContent || '' };
    const article = new Readability(document, { charThreshold: 80 }).parse();
    if (article?.content) return { title: article.title || document.title || '', html: article.content, text: article.textContent || '' };
  }
  const body = document.body ?? document.documentElement;
  return { title: document.title || '', html: body?.innerHTML || html, text: body?.textContent || '' };
}

async function extractContent(buffer, contentType, finalUrl, spec) {
  const requested = String(spec.format ?? 'markdown').toLowerCase();
  if (contentType.includes('application/pdf') || finalUrl.pathname.toLowerCase().endsWith('.pdf')) {
    const parsed = await pdfParse(buffer);
    return { title: parsed.info?.Title || '', format: 'text', content: parsed.text || '', parser: 'pdf-parse' };
  }
  if (contentType.includes('json') || requested === 'json') {
    const text = decodeText(buffer, contentType);
    try { return { title: '', format: 'json', content: JSON.stringify(JSON.parse(text), null, 2), parser: 'json' }; }
    catch { return { title: '', format: 'text', content: text, parser: 'text-invalid-json' }; }
  }
  const text = decodeText(buffer, contentType);
  const htmlLike = contentType.includes('html') || /^\s*<(?:!doctype|html|head|body|article|main)\b/i.test(text);
  if (!htmlLike) return { title: '', format: requested === 'html' ? 'text' : requested, content: text, parser: contentType.includes('xml') ? 'xml-text' : 'text' };
  const selected = selectHtml(text, finalUrl.href, spec.selector, spec.extract ?? 'main');
  if (requested === 'html') return { title: selected.title, format: 'html', content: selected.html, parser: spec.selector ? 'css-selector' : spec.extract === 'all' ? 'html-body' : 'readability' };
  if (requested === 'text') return { title: selected.title, format: 'text', content: selected.text.replace(/\n{3,}/g, '\n\n').trim(), parser: spec.selector ? 'css-selector' : spec.extract === 'all' ? 'html-body' : 'readability' };
  return { title: selected.title, format: 'markdown', content: turndown.turndown(selected.html).replace(/\n{3,}/g, '\n\n').trim(), parser: spec.selector ? 'css-selector+turndown' : spec.extract === 'all' ? 'html-body+turndown' : 'readability+turndown' };
}

function safeHeaders(input = {}) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (/^(host|connection|content-length|proxy-|sec-|cookie$)/i.test(key)) continue;
    output[key] = String(value);
  }
  if (!output['user-agent'] && !output['User-Agent']) output['user-agent'] = 'OpenCode-Optimised-Toolings/1.0 (+local research fetcher)';
  output.accept ??= 'text/html,application/xhtml+xml,application/json,application/pdf,text/plain;q=0.9,*/*;q=0.5';
  return output;
}

function transient(status, error) {
  return Boolean(error) || status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function disposeDispatcher(dispatcher) {
  if (!dispatcher) return;

  const close = typeof dispatcher.close === 'function' ? dispatcher.close.bind(dispatcher) : null;
  const destroy = typeof dispatcher.destroy === 'function' ? dispatcher.destroy.bind(dispatcher) : null;

  if (close) {
    try {
      await Promise.resolve(close());
      return;
    } catch {
      // Some runtimes expose an incompatible or partially implemented close().
      // Fall through to destroy() when available so cleanup never masks the fetch result.
    }
  }

  if (destroy) {
    try { await Promise.resolve(destroy()); } catch {}
  }
}

async function cancelUnusedBody(response) {
  if (!response?.body || response.bodyUsed || response.body.locked !== false) return;
  try { await Promise.resolve(response.body.cancel()); } catch {}
}

async function fetchOne(spec, signal) {
  const timeoutMs = clamp(spec.timeout_ms, 1_000, 120_000, DEFAULT_TIMEOUT_MS);
  const maxBytes = clamp(spec.max_source_bytes, 16 * 1024, MAX_SOURCE_BYTES, 2 * 1024 * 1024);
  const maxRedirects = clamp(spec.max_redirects, 0, MAX_REDIRECTS, 5);
  const retries = clamp(spec.retries, 0, 2, 1);
  const started = Date.now();
  let current = normalizeUrl(spec.url);
  let headers = safeHeaders(spec.headers);
  const redirects = [];
  let attempt = 0;

  while (true) {
    attempt += 1;
    let response;
    let dispatcher;
    try {
      const addresses = await resolveAndValidate(current, spec.allow_private === true);
      dispatcher = dispatcherFor(addresses);
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      response = await undiciFetch(current, { method: 'GET', headers, redirect: 'manual', signal: combined, dispatcher });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`HTTP ${response.status} redirect omitted Location.`);
        if (redirects.length >= maxRedirects) throw new Error(`Redirect limit of ${maxRedirects} was exceeded.`);
        const next = normalizeUrl(new URL(location, current).href);
        await resolveAndValidate(next, spec.allow_private === true);
        if (next.origin !== current.origin) {
          for (const key of Object.keys(headers)) if (/^(authorization|proxy-authorization|x-api-key)$/i.test(key)) delete headers[key];
        }
        redirects.push({ status: response.status, from: current.href, to: next.href });
        await response.body?.cancel();
        current = next;
        continue;
      }

      if (!response.ok && attempt <= retries && transient(response.status)) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 1000)));
        continue;
      }

      const body = await readBodyBounded(response, maxBytes);
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const extracted = await extractContent(body.buffer, contentType, current, spec);
      return {
        requestedUrl: spec.url,
        finalUrl: current.href,
        status: response.status,
        ok: response.ok,
        statusText: response.statusText,
        contentType,
        contentLengthHeader: response.headers.get('content-length'),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        redirects,
        attempts: attempt,
        durationMs: Date.now() - started,
        sourceBytes: body.buffer.length,
        sourceTruncated: body.truncated,
        sha256: createHash('sha256').update(body.buffer).digest('hex'),
        ...extracted,
      };
    } catch (error) {
      if (attempt <= retries && transient(0, error)) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 1000)));
        continue;
      }
      throw error;
    } finally {
      await cancelUnusedBody(response);
      await disposeDispatcher(dispatcher);
    }
  }
}

function cacheKey(spec) {
  return JSON.stringify({ url: spec.url, format: spec.format ?? 'markdown', selector: spec.selector ?? '', extract: spec.extract ?? 'main', allow_private: spec.allow_private === true, headers: spec.headers ?? {} });
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() { while (true) { const index = next++; if (index >= items.length) return; results[index] = await worker(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

function allocateBudgets(needs, total) {
  const allocations = Array(needs.length).fill(0);
  const pending = new Set(needs.map((_, index) => index));
  let remaining = total;
  while (pending.size && remaining > 0) {
    const share = Math.max(1, Math.floor(remaining / pending.size));
    let progressed = false;
    for (const index of [...pending]) {
      const demand = needs[index] - allocations[index];
      const grant = Math.min(demand, share, remaining);
      allocations[index] += grant;
      remaining -= grant;
      progressed ||= grant > 0;
      if (allocations[index] >= needs[index]) pending.delete(index);
      if (!remaining) break;
    }
    if (!progressed) break;
  }
  return allocations;
}

function boundedContent(content, budget) {
  const bytes = Buffer.byteLength(content);
  if (bytes <= budget) return { text: content, truncated: false, omittedBytes: 0 };
  if (budget < 256) return { text: '[content omitted: shared output budget exhausted]', truncated: true, omittedBytes: bytes };
  const headBudget = Math.floor((budget - 160) * 0.65);
  const tailBudget = Math.max(0, budget - 160 - headBudget);
  const source = Buffer.from(content);
  const head = source.subarray(0, headBudget).toString('utf8');
  const tail = source.subarray(Math.max(headBudget, source.length - tailBudget)).toString('utf8');
  const omittedBytes = Math.max(0, source.length - Buffer.byteLength(head) - Buffer.byteLength(tail));
  return { text: `${head}\n\n[... OMITTED ${omittedBytes} EXTRACTED BYTES ...]\n\n${tail}`, truncated: true, omittedBytes };
}

export async function fetchBatch({ requests, maxConcurrency = 4, cacheTtlSeconds = 300, outputBudgetBytes = MAX_SHARED_OUTPUT_BYTES }, signal) {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > MAX_REQUESTS) throw new Error(`requests must contain 1-${MAX_REQUESTS} items.`);
  const ttlMs = clamp(cacheTtlSeconds, 0, 3600, 300) * 1000;
  const concurrency = clamp(maxConcurrency, 1, 6, 4);
  const items = await mapConcurrent(requests, concurrency, async (spec) => {
    const key = cacheKey(spec);
    const saved = cache.get(key);
    if (ttlMs && saved && Date.now() - saved.createdAt <= ttlMs) return { ...saved.value, cached: true };
    try {
      const value = { ...(await fetchOne(spec, signal)), cached: false };
      if (ttlMs && value.ok) cache.set(key, { createdAt: Date.now(), value });
      return value;
    } catch (error) {
      return { requestedUrl: spec.url, ok: false, error: error instanceof Error ? error.message : String(error), durationMs: 0, content: '', cached: false, sourceBytes: 0, sourceTruncated: false, redirects: [], attempts: 0 };
    }
  });
  const metadataReserve = Math.min(64 * 1024, 1800 * items.length + 1024);
  const contentPool = Math.max(0, clamp(outputBudgetBytes, 16 * 1024, MAX_SHARED_OUTPUT_BYTES, MAX_SHARED_OUTPUT_BYTES) - metadataReserve);
  const allocations = allocateBudgets(items.map((item) => Buffer.byteLength(item.content || '')), contentPool);
  const rendered = items.map((item, index) => ({ ...item, rendered: boundedContent(item.content || '', allocations[index]), contentBudget: allocations[index] }));
  return { items: rendered, contentPool, totalBudget: contentPool + metadataReserve };
}

export function formatFetchBatch(result) {
  const succeeded = result.items.filter((item) => item.ok).length;
  const sections = [
    `WEB FETCH RESULT: ${succeeded === result.items.length ? 'SUCCESS' : succeeded ? 'PARTIAL SUCCESS' : 'FAILED'}`,
    `WHAT HAPPENED: ${succeeded} of ${result.items.length} URL request(s) returned successful HTTP responses.`,
    `OUTPUT ALLOCATION: shared_total=${result.totalBudget} bytes; extracted_content_pool=${result.contentPool} bytes; adaptive=true.`,
  ];
  result.items.forEach((item, index) => {
    const lines = [
      `=== URL ${index + 1}: ${item.requestedUrl} ===`,
      `Outcome: ${item.ok ? `HTTP ${item.status} ${item.statusText || ''}`.trim() : 'FAILED'}`,
      `Final URL: ${item.finalUrl || 'not reached'}`,
      `Cache: ${item.cached ? 'hit' : 'miss'}`,
      `Duration: ${item.durationMs ?? 0} ms; attempts=${item.attempts ?? 0}; redirects=${item.redirects?.length ?? 0}`,
    ];
    if (item.error) lines.push(`Error: ${item.error}`, 'Safety/completeness: no page content was returned for this item.');
    else {
      lines.push(
        `Content: type=${item.contentType}; parser=${item.parser}; format=${item.format}; source_bytes=${item.sourceBytes}; sha256=${item.sha256}`,
        `Source completeness: ${item.sourceTruncated ? 'partial; source body exceeded the configured per-request limit' : 'complete within the configured source limit'}`,
        `Returned extraction: ${item.rendered.truncated ? `partial; omitted ${item.rendered.omittedBytes} extracted bytes` : 'complete'}; allocated=${item.contentBudget} bytes`,
      );
      if (item.title) lines.push(`Title: ${item.title}`);
      if (item.redirects?.length) lines.push(`Redirect chain:\n${item.redirects.map((hop) => `  - HTTP ${hop.status}: ${hop.from} -> ${hop.to}`).join('\n')}`);
      lines.push('--- EXTRACTED CONTENT ---', item.rendered.text || '(empty response content)');
    }
    sections.push(lines.join('\n'));
  });
  return sections.join('\n\n');
}

export function resetFetchCache() { cache.clear(); }
