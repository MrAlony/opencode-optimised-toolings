# oc-webtooling

OpenCode plugin exposing one high-information `alonix-web-search` tool instead of overlapping per-provider tools.

## Capabilities

- Batches 1-10 independent queries in one call.
- `fallback` strategy tries backends in order and stops at the first useful result set.
- Explicit `aggregate` strategy searches selected backends concurrently and deduplicates URLs.
- Supports Serper, Firecrawl, Tavily, Exa, DuckDuckGo, and local SearXNG.
- Bounded output, five-minute default exact-request cache, concurrent query limit, and session advisories for serial or duplicate searches.

## Configuration

Set `SERPER_API_KEY`, `FIRECRAWL_API_KEY`, `TAVILY_API_KEY`, and `EXA_API_KEY`, or copy `config.example.json` to the ignored `config.local.json`. Local SearXNG ports can be configured there.

## Verification

```sh
npm test
```

## Local SearXNG backend

The `searxng` backend queries a local SearXNG instance (ports via `searxng_ports` in `config.local.json`, default `[18999, 8888]`). A Windows-native instance lives in `../searxng`:

```powershell
..\searxng\start.ps1   # serves http://127.0.0.1:18999 with JSON API enabled
```

If no instance is running, the backend reports a clear error and fallback moves on. Quota-style failures on API backends (HTTP 401/402/403, or 400 with a credits/quota body) trip a 15-minute circuit breaker so repeated calls stop hammering a dead key; error responses now include the upstream body for diagnosis.
