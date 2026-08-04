---
name: oc-cbm
description: Consolidated codebase intelligence through Codebase-Memory-MCP. Use for repository architecture, symbols, call chains, impact analysis, source discovery, and indexed code investigation. Prefer this over repeated filesystem explore/grep calls when a project is indexed.
---

# oc-cbm

Use CBM before broad filesystem crawling whenever the repository may already be indexed. The public tools intentionally return fixed high-information packages so architecture and relationship context cannot be omitted to save tokens.

## Workflow

1. Call `cbm_project` with `action="list"`.
2. If the repository is absent, do not create an index unless the user explicitly requested indexing or reindexing it. Only then call `cbm_project` with `action="index"`, its absolute `repo_path`, normally `mode="fast"`, and `user_authorized=true`.
3. Call `cbm_context` once for architecture, graph schema, and change blast radius on an already indexed project.
4. Call `cbm_investigate` once with the complete feature, bug, behavior, or symbol intent.
5. Use the returned architecture, symbol matches, indexed text matches, source snippets, and call chain together. Move to implementation or only the precise remaining gap.

## Tools

### `cbm_project`

Grouped index management: `list`, `index`, `status`, and `delete`. New index creation is explicit, bounded, and requires both a direct user request and `user_authorized=true`. Never start duplicate indexing. Query tools may automatically repair only an already indexed project.

### `cbm_context`

Always returns all of:

- architecture, languages, packages, entry points, routes, hotspots, and clusters;
- graph labels, edge types, and properties;
- source-fingerprint and graph/source structural freshness evidence;
- current uncommitted-change blast radius and risk information when the root is a Git worktree, or an explicit not-applicable result otherwise.

The agent cannot request a reduced subset.

### `cbm_investigate`

Always returns all of:

- architecture baseline;
- structured graph/semantic symbol search;
- indexed-code search;
- up to three automatically selected source snippets;
- inbound and outbound call-chain context for a supplied or discovered function.

An optional read-only Cypher query adds a section but never replaces the mandatory package. Put the full task intent into `query`; do not make several tiny investigations that could have been one.

### `cbm_memory`

Groups ADR CRUD and runtime-trace ingestion. Use it to preserve architectural decisions or enrich static relationships with observed runtime calls.

## Enforcement guidance

- Two filesystem discovery calls in one session should trigger checking CBM.
- Three or more broad explore/grep calls are a failure when the project is indexed.
- CBM optimization changes how information is gathered, never how much requested work is completed.
- After CBM identifies exact files, use one batched filesystem read for the precise source needed to edit or verify.

## Limits

- Static analysis may miss reflection, runtime-generated code, or highly dynamic dispatch.
- Git and non-Git source directories can be indexed. Git is required only for Git change detection.
- On first use after installing this version, an already indexed project with an unknown baseline self-refreshes once. Later stale or unverified existing indexes also self-refresh before queries; concurrent callers share the same bounded refresh. These query paths never create a new project index.
- If refresh or post-refresh verification fails, the requested graph query does not run against stale data.
- Use `moderate` or `full` indexing only when deeper semantic/similarity edges justify the extra work.
