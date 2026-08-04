import { tool } from "@opencode-ai/plugin/tool";
import { invokeQuery } from "./guard.js";
import type { ToolContext } from "@opencode-ai/plugin/tool";

const s = tool.schema;

export const manageAdr = tool({
  description: "Create, read, update, delete, or list Architecture Decision Records (ADRs).",
  args: {
    action: s.enum(["create", "read", "update", "delete", "list"]).describe("ADR CRUD action"),
    project: s.string().describe("Project name"),
    id: s.string().optional().describe("ADR identifier (required for read/update/delete)"),
    title: s.string().optional().describe("Title (required for create/update)"),
    status: s.enum(["proposed", "accepted", "deprecated", "superseded"]).optional().describe("Decision status"),
    context: s.string().optional().describe("Context / problem statement"),
    decision: s.string().optional().describe("Decision made"),
    consequences: s.string().optional().describe("Consequences of the decision"),
  },
  async execute(args: any, context: ToolContext) {
    const result = await invokeQuery("manage_adr", args, context);
    return result || "ADR operation completed.";
  },
});

export const ingestTraces = tool({
  description: "Ingest runtime traces to validate and enrich HTTP_CALLS edges in the graph.",
  args: {
    project: s.string().describe("Project name"),
    traces: s.array(s.object({
      source: s.string().describe("Source endpoint or function"),
      target: s.string().describe("Target endpoint or function"),
      method: s.string().optional().describe("HTTP method or protocol"),
      timestamp: s.string().optional().describe("ISO 8601 timestamp"),
    })).describe("Runtime trace entries to ingest"),
  },
  async execute(args: any, context: ToolContext) {
    const result = await invokeQuery("ingest_traces", args, context);
    return result || "Traces ingested.";
  },
});
