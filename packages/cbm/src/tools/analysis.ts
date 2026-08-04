import { tool } from "@opencode-ai/plugin/tool";
import { invokeQuery } from "./guard.js";
import type { ToolContext } from "@opencode-ai/plugin/tool";

const s = tool.schema;

export const detectChanges = tool({
  description: "Map uncommitted git diff to affected symbols with blast radius and risk classification.",
  args: {
    project: s.string().describe("Project name"),
  },
  async execute(args: any, context: ToolContext) {
    const result = await invokeQuery("detect_changes", args, context);
    return result || "No changes detected or project not indexed.";
  },
});

export const getArchitecture = tool({
  description: "Get a comprehensive codebase overview: languages, packages, entry points, routes, hotspots, clusters, and ADRs.",
  args: {
    project: s.string().describe("Project name"),
  },
  async execute(args: any, context: ToolContext) {
    const result = await invokeQuery("get_architecture", args, context);
    return result || "Architecture data not available.";
  },
});

export const getCodeSnippet = tool({
  description: "Read source code for a specific function, class, or method by its qualified name.",
  args: {
    project: s.string().describe("Project name"),
    name: s.string().describe("Qualified symbol name (e.g. project.package.Module.func)"),
  },
  async execute(args: any, context: ToolContext) {
    const result = await invokeQuery("get_code_snippet", args, context);
    return result || "Symbol not found. Use search_graph to discover qualified names.";
  },
});
