# oc-cbm

An OpenCode plugin wrapping Codebase-Memory-MCP with a deliberately small, high-information tool surface. The plugin combines related graph operations so agents receive architecture, symbols, relationships, source, and impact context in a few user-visible tool calls instead of chaining many narrow calls.

## Public tools

- `alonix-index-project` — list, index, check status, or delete indexed projects. Creating or explicitly reindexing requires a direct user request and `user_authorized=true`.
- `alonix-index-context` — fixed repository baseline containing architecture, graph schema, and current change blast radius.
- `alonix-index-investigate` — fixed investigation package containing architecture, structured graph search, indexed-code search, automatic relevant source snippets, and a call-chain trace. Optional read-only Cypher can add information but cannot remove mandatory sections.
- `alonix-index-memory` — grouped ADR and runtime-trace maintenance.

The underlying CBM capabilities remain available internally, but agents are not presented with fourteen separate micro-tools.

## Recommended workflow

1. `alonix-index-project(action="list")`
2. If absent, use filesystem tools unless the user explicitly requested indexing. Only with that request: `alonix-index-project(action="index", repo_path="...", mode="fast", user_authorized=true)`.
3. `alonix-index-context(project="...")` for the baseline of an already indexed repository.
4. `alonix-index-investigate(project="...", query="full feature or bug intent")` for focused work.
5. Move to implementation and verification instead of restarting broad filesystem exploration.

## Installation

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/oc-cbm/dist/index.js"],
  "skills": {
    "paths": ["/absolute/path/to/oc-cbm/SKILL.md"]
  }
}
```

Build with `npm install` and `npm run build`, then restart OpenCode.

## Operational safety

- Query deadline: 30 seconds (`OC_CBM_QUERY_TIMEOUT_MS`)
- Query results verify both the indexed-root fingerprint and the graph/source file inventory before presenting architecture as current. A structural mismatch triggers at most two bounded in-call refresh attempts; persistent mismatches fail closed with exact missing or removed paths instead of returning stale graph evidence.
- Structural verification mirrors backend directory exclusions, including dependency/generated directories and directories literally named `tools`. The active consolidated implementation lives at `src/consolidated.ts`, outside that backend-reserved directory.
- Stale, unknown-baseline, or otherwise unverified existing indexes automatically run one bounded fast refresh before the requested query. Context, investigation, and memory never create an index for an unknown project.
- Concurrent requests for the same canonical root share one refresh operation; stale graph data is never used as a fallback after refresh failure.
- Missing source roots are separated in project listings and never deleted automatically.
- Git and non-Git directories can be indexed; Git blast-radius analysis is explicitly `not_applicable` for non-Git roots.
- Index deadline: 180 seconds (`OC_CBM_INDEX_TIMEOUT_MS`)
- Install deadline: 60 seconds (`OC_CBM_INSTALL_TIMEOUT_MS`)
- OpenCode cancellation terminates the complete child process tree.
- Duplicate concurrent indexing of one canonical Git worktree is rejected.
- `fast` indexing is the default; `moderate` and `full` require explicit selection.
- Output sections are bounded to prevent accidental context flooding.
- Optional Cypher is restricted to read-only clauses.
- Processing is local; no API keys are required.

## Requirements

- OpenCode 1.x
- Existing source directories for indexing; Git is required only for Git change detection
- Internet access only for the first automatic CBM binary download
