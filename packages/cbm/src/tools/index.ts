import * as consolidated from "../consolidated.js";

/**
 * Builds the consolidated native OpenCode tool registry for CBM.
 * Each public analysis tool returns a fixed high-information package so agents
 * cannot replace architecture and relationship context with low-value micro-calls.
 */
export function buildToolDefs(): Record<string, unknown> {
  return {
    cbm_project: consolidated.project,
    cbm_context: consolidated.context,
    cbm_investigate: consolidated.investigate,
    cbm_memory: consolidated.memory,
  };
}
