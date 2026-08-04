import { tool } from "@opencode-ai/plugin/tool";
import { invokeCbm } from "../cbm.js";
import { getGitRoot } from "../state.js";
import type { ToolContext } from "@opencode-ai/plugin/tool";

const s = tool.schema;
const activeIndexes = new Map<string, Promise<string>>();

export const indexRepository = tool({
  description: "Index a repository into the knowledge graph. Required before any query tool works.",
  args: {
    repo_path: s.string().describe("Absolute path to the repository to index"),
    mode: s.enum(["fast", "moderate", "full"]).optional().default("fast").describe("Indexing depth. fast is bounded and skips semantic/similarity edges."),
  },
  async execute(args: any, context: ToolContext) {
    let path: string;
    try {
      path = getGitRoot(args.repo_path as string);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `STOP. Invalid Git repository: ${msg}`;
    }
    const existing = activeIndexes.get(path);
    if (existing) return `Indexing is already running for ${path}. Wait for that bounded operation to finish instead of starting a duplicate.`;

    const operation = invokeCbm("index_repository", { repo_path: path, mode: args.mode ?? "fast" }, { signal: context.abort });
    activeIndexes.set(path, operation);
    try {
      return await operation;
    } catch (err) {
      return `STOP. Indexing failed or was terminated safely. Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (activeIndexes.get(path) === operation) activeIndexes.delete(path);
    }
  },
});

export const listProjects = tool({
  description: "List all indexed projects with node and edge counts.",
  args: {},
  async execute(_args: any, context: ToolContext) {
    const result = await invokeCbm("list_projects", {}, { signal: context.abort });
    return result || "No projects indexed yet. Use cbm_index_repository first.";
  },
});

export const deleteProject = tool({
  description: "Remove a project and all its graph data from the index.",
  args: {
    project: s.string().describe("Project name to delete"),
  },
  async execute(args: any, context: ToolContext) {
    const result = await invokeCbm("delete_project", args, { signal: context.abort });
    return result || "Project deleted.";
  },
});

export const indexStatus = tool({
  description: "Check the indexing status of a project.",
  args: {
    project: s.string().describe("Project name"),
  },
  async execute(args: any, context: ToolContext) {
    const result = await invokeCbm("index_status", args, { signal: context.abort });
    return result || "Status unavailable.";
  },
});
