import { tool } from "@opencode-ai/plugin";
import { fetchBatch, formatFetchBatch } from "./lib/fetch-core.js";
import { searchBatch } from "./lib/search-core.js";

const sessionState = new Map();
function getSession(context) { const id = context?.sessionID ?? "global"; if (!sessionState.has(id)) sessionState.set(id, { lastQueries: "", repeated: 0, lastUrls: "", repeatedUrls: 0 }); return sessionState.get(id); }
function duplicateAdvice(context, signature, kind) { const state = getSession(context); const key = kind === 'search' ? 'lastQueries' : 'lastUrls'; const counter = kind === 'search' ? 'repeated' : 'repeatedUrls'; state[counter] = state[key] === signature ? state[counter] + 1 : 1; state[key] = signature; return state[counter] >= 2 ? `[DUPLICATE WEB ${kind.toUpperCase()} WARNING] The same ${kind} batch has been requested ${state[counter]} times consecutively. Cached evidence may be reused; inspect it or materially change the request before repeating it.` : ""; }

export const WebToolingPlugin = async () => ({
  tool: {
    "alonix-web-search": tool({
      description: "Search 1-10 independent web questions in one call. fallback tries ordered backends until useful results exist; aggregate queries selected backends concurrently and deduplicates URLs. Local SearXNG and DuckDuckGo are preferred by default so paid keys are optional. Exact requests are cached and all backend attempts remain visible. Multiple web calls are acceptable when new evidence or dependent questions justify them; only exact consecutive duplicates are warned.",
      args: {
        queries: tool.schema.array(tool.schema.object({ query: tool.schema.string().min(1), max_results: tool.schema.number().optional(), backend: tool.schema.string().optional() })).min(1).max(10),
        strategy: tool.schema.string().optional(), backends: tool.schema.array(tool.schema.string()).optional(), max_concurrency: tool.schema.number().optional(), cache_ttl_seconds: tool.schema.number().optional(),
      },
      async execute(args, context) {
        const strategy = String(args.strategy ?? "fallback").toLowerCase();
        if (!["fallback", "aggregate"].includes(strategy)) return "WEB SEARCH FAILED\nWhat happened: strategy must be 'fallback' or 'aggregate'.";
        try {
          const result = await searchBatch({ queries: args.queries, strategy, backends: args.backends, maxConcurrency: args.max_concurrency, cacheTtlSeconds: args.cache_ttl_seconds });
          const note = duplicateAdvice(context, args.queries.map((item) => item.query.trim().toLowerCase()).join('\n'), 'search');
          return `${result.output}${note ? `\n\n${note}` : ''}`;
        } catch (error) { return `WEB SEARCH FAILED\nWhat happened: ${error instanceof Error ? error.message : String(error)}`; }
      },
    }),
    "alonix-web-fetch-many": tool({
      description: "Fetch and extract 1-10 URLs concurrently with per-hop DNS/redirect safety, private-network blocking by default, bounded retries/timeouts/body sizes, HTML readability or CSS extraction, Markdown/text/HTML/JSON/PDF support, exact metadata/fingerprints, caching, and one adaptive shared output budget. Set allow_private only for deliberate local service access.",
      args: {
        requests: tool.schema.array(tool.schema.object({
          url: tool.schema.string().min(1),
          format: tool.schema.enum(["markdown", "text", "html", "json"]).optional().default("markdown"),
          extract: tool.schema.enum(["main", "all"]).optional().default("main"),
          selector: tool.schema.string().optional(),
          headers: tool.schema.record(tool.schema.string(), tool.schema.string()).optional(),
          timeout_ms: tool.schema.number().optional(),
          max_source_bytes: tool.schema.number().optional(),
          max_redirects: tool.schema.number().optional(),
          retries: tool.schema.number().optional(),
          allow_private: tool.schema.boolean().optional().default(false),
        })).min(1).max(10),
        max_concurrency: tool.schema.number().optional(),
        cache_ttl_seconds: tool.schema.number().optional(),
        output_budget_bytes: tool.schema.number().optional(),
      },
      async execute(args, context) {
        try {
          const result = await fetchBatch({ requests: args.requests, maxConcurrency: args.max_concurrency, cacheTtlSeconds: args.cache_ttl_seconds, outputBudgetBytes: args.output_budget_bytes }, context.abort);
          const note = duplicateAdvice(context, args.requests.map((item) => `${item.url}|${item.format}|${item.selector || ''}`).join('\n'), 'fetch');
          return `${formatFetchBatch(result)}${note ? `\n\n${note}` : ''}`;
        } catch (error) { return `WEB FETCH RESULT: FAILED\nWHAT HAPPENED: ${error instanceof Error ? error.message : String(error)}`; }
      },
    }),
  },
});
