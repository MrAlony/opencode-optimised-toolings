import { invokeCbm } from "../cbm.js";
import type { ToolContext } from "@opencode-ai/plugin/tool";

/**
 * Invokes a query tool without hidden indexing and forwards OpenCode cancellation.
 * Params: toolName (string), args (record), context (ToolContext).
 * Returns: Promise<string> containing CBM output.
 * Side effects: Starts one bounded CBM query process.
 * Assumptions: Repositories are indexed explicitly; the CBM binary handles incremental freshness.
 */
export async function invokeQuery(toolName: string, args: Record<string, unknown>, context: ToolContext): Promise<string> {
  return invokeCbm(toolName, args, { signal: context.abort });
}
