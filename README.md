# OpenCode Optimised Toolings

A portable, shareable distribution of the custom OpenCode tools used in this environment:

- **Filesystem:** adaptive batched reads, strict safe multi-file edits, structured search and exploration.
- **Terminal:** bounded foreground commands with safe same-call recovery for proven no-execution failures, plus background startup/readiness evidence and confirmed lifecycle cleanup.
- **CBM:** indexed architecture, symbol/call-chain investigation, freshness/structure repair, ADRs and runtime traces.
- **Web:** multi-backend batched search plus an SSRF-aware `web_fetch_many` replacement for the built-in fetch tool.
- **Stealth:** native OpenCode Tor/Patchright tools, no MCP server, cookie-authenticated dedicated Tor process.
- **SearXNG:** loopback-only local search service with generated local secret and owned PID lifecycle.
- **Guidance:** production-oriented global AGENTS and Kilo Implementer configuration.
- **Self-patching:** the unified plugin detects an unpatched OpenCode binary, rebuilds the exact installed version with rich tool renderers, swaps the binary, and restarts automatically once — and repeats after OpenCode self-updates.

## Quick setup

Requirements: Node.js 20+, npm, Python 3.11+, and a Tor executable for stealth operations.

```powershell
npm run setup
npm run services -- start
npm test
npm run test:live
npm run install:opencode
npm run doctor
```

Then fully quit and restart OpenCode. Plugins and global configuration are loaded only at startup. `npm run test:live` executes a non-destructive acceptance check through every unified tool and cleans its temporary fixture.

`npm run setup` creates ignored `config/secrets.local.json`; add your own paid search keys there only if desired. Search defaults to local SearXNG and DuckDuckGo, so paid keys are optional. Never commit `secrets.local.json`.

## Self-patching contract

`packages/selfpatch` plus the TUI companion (`packages/tui`) implement the automatic patch lifecycle:

1. On launch the plugin compares the running OpenCode binary against the bundled anchor patch set (`packages/selfpatch/patches/<version>/`). A matching patched SHA-256 means nothing to do.
2. Unpatched or updated binary → the plugin downloads the exact-version source archive, applies the SHA-verified anchor patches (renderer registry + `api.toolRenderers`), rebuilds with the workspace-local Bun, stages the patched binary, and schedules a detached swap helper.
3. OpenCode restarts itself once and resumes the session (`--continue`). Progress is visible in the sidebar, via toasts, and through the `toolings` status tool.
4. Future OpenCode self-updates change the binary hash, so the plugin re-patches automatically.

Safeguards: version-specific manifests with source fingerprints, fail-closed behavior on unknown versions (the official binary keeps running), validation-before-write patching, an idempotent per-version patch marker, a pipeline lock, and `OPENCODE_TOOLINGS_NO_EXIT=1` to disable the automatic restart exit. Running under a node/bun dev runtime is detected and skipped (`dev-mode`).

## Web contract

The installer disables and denies built-in `webfetch` and registers `web_fetch_many`. The replacement fetches up to ten URLs with one adaptive shared output budget, DNS-pinned connections, redirect revalidation, private-network blocking by default, bounded bodies/timeouts/retries, caching, fingerprints, and HTML/JSON/XML/PDF/text extraction. Use `allow_private=true` only for deliberate local-service access.

`web_search` supports frequent legitimate research. Batch independent questions, use additional calls for new or dependent questions, and avoid only unchanged consecutive duplicate requests.

## Stealth contract

`stealth_fetch_many`, `stealth_search_many`, `stealth_rotate_tor`, and `stealth_status` are native plugin tools. Tor starts on dedicated ports 19050/19051 by default, uses cookie authentication, waits for bootstrap, and is stopped only if this package launched it. Configure Tor in local secrets or place it on PATH.

## Service lifecycle

```powershell
npm run services -- status
npm run services -- start
npm run services -- stop
npm run services -- restart
```

The manager refuses to terminate unrelated or unverifiable port owners.

## Safe configuration migration

`npm run install:opencode`:

1. Backs up the existing global `opencode.json` and guidance.
2. Preserves provider, model, UI, DCP, and unrelated plugin configuration.
3. Replaces only legacy custom-tool plugin paths with this repository's root plugin.
4. Removes the old stealth MCP entry.
5. Disables built-in webfetch and allows the native replacement tools.
6. Records rollback state locally.
7. Backs up and merges the global `tui.json`, registering the unified TUI companion (`packages/tui/index.tsx`). Uninstall restores the TUI backup or removes only the unified entry.

Use `npm run uninstall:opencode` to restore the prior config/guidance backups. Re-running the installer is idempotent and preserves the first valid pre-migration backup rather than replacing it with an already-migrated file.

## Sharing

Share the repository without `node_modules`, virtual environments, generated settings, runtime state, local backups, or `config/secrets.local.json`. Run `npm run verify:shareable` before publishing. A friend runs the quick setup commands and supplies their own optional keys/Tor path.

SearXNG source remains under its upstream AGPL-3.0 license in `services/searxng/LICENSE`. Package-specific upstream licenses and notices remain with copied packages.
