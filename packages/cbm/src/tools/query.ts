import { tool } from "@opencode-ai/plugin/tool";
import { invokeQuery } from "./guard.js";
import type { ToolContext } from "@opencode-ai/plugin/tool";

const s = tool.schema;

export const searchGraph = tool({
  description: "Structured search across symbol names, labels, file paths, and semantic meaning.",
  args: {
    project: s.string().describe("Project name (as returned by list_projects)"),
    name_pattern: s.string().optional().describe("Regex pattern to match symbol names"),
    label: s.string().optional().describe("Node label filter: Function, Class, Method, Interface, Enum, Type, Route, etc."),
    file_pattern: s.string().optional().describe("Glob pattern to filter by file path"),
    semantic_query: s.string().optional().describe("Natural language query for vector-based semantic search"),
    limit: s.number().int().min(1).max(500).optional().default(50).describe("Max results to return"),
    offset: s.number().int().min(0).optional().default(0).describe("Pagination offset"),
  },
  async execute(args: any, context: ToolContext) {
    const result = await invokeQuery("search_graph", args, context);
    return result || "No results found.";
  },
});

export const tracePath = tool({
  description: "Trace call chains to/from a function using BFS traversal.",
  args: {
    project: s.string().describe("Project name"),
    function_name: s.string().describe("Function name to trace"),
    direction: s.enum(["inbound", "outbound", "both"]).optional().default("both").describe("Call direction"),
    max_depth: s.number().int().min(1).max(5).optional().default(3).describe("Max BFS depth"),
  },
  async execute(args: any, context: ToolContext) {
    const result = await invokeQuery("trace_path", args, context);
    return result || "No call paths found.";
  },
});

export const queryGraph = tool({
  description: "Execute read-only Cypher queries against the knowledge graph.",
  args: {
    project: s.string().describe("Project name"),
    query: s.string().describe("Read-only Cypher query (e.g. MATCH (f:Function) RETURN f.name LIMIT 10)"),
  },
  async execute(args: any, context: ToolContext) {
    const result = await invokeQuery("query_graph", args, context);
    return result || "Query returned no results.";
  },
});

export const getGraphSchema = tool({
  description: "Returns node/edge type counts, relationship patterns, and property definitions per label.",
  args: {
    project: s.string().describe("Project name"),
  },
  async execute(args: any, context: ToolContext) {
    const result = await invokeQuery("get_graph_schema", args, context);
    return result || "No schema data available.";
  },
});

export const searchCode = tool({
  description: "Grep-like text search within indexed project files.",
  args: {
    project: s.string().describe("Project name"),
    pattern: s.string().describe("Text pattern to search for in indexed files"),
    file_pattern: s.string().optional().describe("Glob pattern to restrict search scope"),
  },
  async execute(args: any, context: ToolContext) {
    const result = await invokeQuery("search_code", args, context);
    return result || "No matches found.";
  },
});
