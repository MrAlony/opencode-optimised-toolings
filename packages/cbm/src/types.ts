// Type-only file — Zod v4 schemas from @opencode-ai/plugin/tool are defined inline in tool files.

export interface SearchGraphArgs {
  project: string;
  name_pattern?: string;
  label?: string;
  file_pattern?: string;
  semantic_query?: string;
  limit?: number;
  offset?: number;
}

export interface TracePathArgs {
  project: string;
  function_name: string;
  direction?: "inbound" | "outbound" | "both";
  max_depth?: number;
}

export interface QueryGraphArgs {
  project: string;
  query: string;
}

export interface GetGraphSchemaArgs {
  project: string;
}

export interface SearchCodeArgs {
  project: string;
  pattern: string;
  file_pattern?: string;
}

export interface DetectChangesArgs {
  project: string;
}

export interface GetArchitectureArgs {
  project: string;
}

export interface GetCodeSnippetArgs {
  project: string;
  name: string;
}

export interface IndexRepositoryArgs {
  repo_path: string;
}

export interface ListProjectsArgs {
  [key: string]: never;
}

export interface DeleteProjectArgs {
  project: string;
}

export interface IndexStatusArgs {
  project: string;
}

export interface ManageAdrArgs {
  action: "create" | "read" | "update" | "delete" | "list";
  project: string;
  id?: string;
  title?: string;
  status?: "proposed" | "accepted" | "deprecated" | "superseded";
  context?: string;
  decision?: string;
  consequences?: string;
}

export interface IngestTrace {
  source: string;
  target: string;
  method?: string;
  timestamp?: string;
}

export interface IngestTracesArgs {
  project: string;
  traces: IngestTrace[];
}
