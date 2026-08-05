import * as consolidated from "../consolidated.js";

/**
 * Builds the consolidated native OpenCode tool registry for CBM.
 * Each public analysis tool returns a fixed high-information package so agents
 * cannot replace architecture and relationship context with low-value micro-calls.
 */
export function buildToolDefs(): Record<string, unknown> {
  return {
    "alonix-index-project": consolidated.project,
    "alonix-index-context": consolidated.context,
    "alonix-index-investigate": consolidated.investigate,
    "alonix-index-memory": consolidated.memory,
  };
}
