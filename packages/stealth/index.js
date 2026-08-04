import { tool } from "@opencode-ai/plugin";
import { StealthWorkerClient } from "./lib/worker-client.js";
import { formatStatus, formatStealth } from "./lib/format.js";

const client = new StealthWorkerClient();
const requestSchema = tool.schema.object({ url: tool.schema.string().min(1), wait_for: tool.schema.string().optional(), selector: tool.schema.string().optional(), render_js: tool.schema.boolean().optional().default(true), format: tool.schema.enum(["markdown", "text", "html"]).optional().default("markdown"), timeout_ms: tool.schema.number().optional(), allow_private: tool.schema.boolean().optional().default(false) });

export const StealthToolingPlugin = async () => ({
  tool: {
    stealth_fetch_many: tool({
      description: "Fetch 1-8 pages through a managed Tor circuit using Patchright Chromium for JavaScript rendering or a lighter Tor HTTP client. Uses dedicated authenticated Tor ports, bounded concurrency/timeouts/output, private-network blocking by default, browser self-healing, and exact per-item diagnostics.",
      args: { requests: tool.schema.array(requestSchema).min(1).max(8), max_concurrency: tool.schema.number().optional(), output_budget_bytes: tool.schema.number().optional() },
      async execute(args) { try { return formatStealth("fetch", await client.request("fetch_many", { requests: args.requests, max_concurrency: args.max_concurrency }, 180_000), args.output_budget_bytes); } catch (error) { return `STEALTH FETCH RESULT: FAILED\nWHAT HAPPENED: ${error.message}`; } },
    }),
    stealth_search_many: tool({
      description: "Search 1-8 independent DuckDuckGo queries through Tor in one call. Results are ad-filtered, bounded, and returned with Tor readiness evidence. Use when normal search is blocked, privacy-sensitive, or needs independent Tor egress.",
      args: { queries: tool.schema.array(tool.schema.object({ query: tool.schema.string().min(1), max_results: tool.schema.number().optional() })).min(1).max(8), max_concurrency: tool.schema.number().optional(), output_budget_bytes: tool.schema.number().optional() },
      async execute(args) { try { return formatStealth("search", await client.request("search_many", { queries: args.queries, max_concurrency: args.max_concurrency }, 180_000), args.output_budget_bytes); } catch (error) { return `STEALTH SEARCH RESULT: FAILED\nWHAT HAPPENED: ${error.message}`; } },
    }),
    stealth_rotate_tor: tool({ description: "Request a new Tor circuit using cookie-authenticated control protocol, respect Tor's NEWNYM cooldown, and rebuild the browser context so subsequent requests use the new circuit.", args: {}, async execute() { try { const result = await client.request("rotate", {}, 60_000); return `STEALTH TOR ROTATION: SUCCESS\nWHAT HAPPENED: ${result.message}\nCooldown waited: ${result.waited_seconds}s\nBrowser context rebuilt: ${result.browser_rebuilt ? "yes" : "no"}`; } catch (error) { return `STEALTH TOR ROTATION: FAILED\nWHAT HAPPENED: ${error.message}`; } } }),
    stealth_status: tool({ description: "Report native stealth worker, Tor executable/process/bootstrap/cookie-authentication, and browser readiness without fetching a page.", args: {}, async execute() { try { return formatStatus(await client.request("status", {}, 15_000)); } catch (error) { return `STEALTH STATUS: NOT READY\nWhat happened: ${error.message}`; } } }),
  },
  dispose: () => client.stop(),
});
