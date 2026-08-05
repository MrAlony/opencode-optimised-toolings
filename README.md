# OpenCode Optimised Toolings

A portable, shareable distribution of the custom OpenCode tools used in this environment:

- **Filesystem:** adaptive batched reads, strict safe multi-file edits, structured search and exploration.
- **Terminal:** bounded foreground commands with safe same-call recovery for proven no-execution failures, plus background startup/readiness evidence and confirmed lifecycle cleanup.
- **CBM:** indexed architecture, symbol/call-chain investigation, freshness/structure repair, ADRs and runtime traces.
- **Web:** multi-backend batched search plus an SSRF-aware `alonix-web-fetch-many` replacement for the built-in fetch tool.
- **Stealth:** native OpenCode Tor/Patchright tools, no MCP server, cookie-authenticated dedicated Tor process.
- **SearXNG:** loopback-only local search service with generated local secret and owned PID lifecycle.
- **Guidance:** production-oriented global AGENTS and Kilo Implementer configuration.
- **Terminal-native TUI:** compact interactive tool activities with progressive disclosure, keyboard/mouse operation, bounded detail views, lifecycle-safe pending motion, and stable prompt/transcript geometry.
- **Self-healing activation:** adding the root plugin is sufficient. On load it idempotently registers the TUI companion, detects an unpatched OpenCode binary, rebuilds the exact installed version with rich tool renderers, and swaps the binary in place — no running instance is ever stopped or restarted; everything activates on the next launch and repairs itself after OpenCode updates.

## Quick setup

Requirements for a cloned/file plugin: Node.js 20+, installed package dependencies, Python 3.11+, and a Tor executable for stealth operations. Once dependencies exist, adding `file:///path/to/opencode-optimised-toolings/index.js` to OpenCode's normal `plugin` list is enough to register the companion and start self-repair.

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

`packages/selfpatch` plus the TUI companion (`packages/tui`) implement the automatic patch lifecycle. The root server plugin is the only required OpenCode registration; `npm run install:opencode` is an optional migration helper for permissions, guidance, and legacy configuration.

1. On root plugin load, the plugin atomically and idempotently adds the companion to the user's `tui.json` while preserving unrelated TUI settings and plugins. Invalid existing configuration is never overwritten.
2. On launch the plugin compares the running OpenCode binary against the bundled anchor patch set (`packages/selfpatch/patches/<version>/`). A matching patched SHA-256 means nothing to do.
3. Unpatched, updated, or manifest-stale binary → the plugin downloads the exact-version source archive, applies the SHA-verified anchor patches (renderer registry, public API types, scoped plugin forwarding, transcript dispatch, and a non-shrinking native transcript layout boundary), rebuilds with the workspace-local Bun, and installs the patched executable in place while preserving the original backup.
4. Running OpenCode processes are never stopped or restarted. Fully quit and relaunch OpenCode when the sidebar reports that the patched binary was installed; the next process loads the current renderer manifest.
5. The companion reports actual renderer registration (`16/16`) separately from binary status. Tool calls render as concise activity rows by default, expose bounded details through mouse or Enter/Space, expand failures automatically, and future OpenCode self-updates or patch-manifest revisions trigger a provenance-verified rebuild automatically.

Safeguards: version-specific manifests with source fingerprints, fail-closed behavior on unknown versions, validation-before-write patching, separate source and built-artifact provenance markers, post-install SHA-256 verification with rollback, lifecycle-safe renderer unregistration, a pipeline lock, and dependency hydration without third-party lifecycle scripts. Running under a node/bun dev runtime is detected and skipped (`dev-mode`).

## Web contract

The installer disables and denies built-in `webfetch` and registers `alonix-web-fetch-many`. The replacement fetches up to ten URLs with one adaptive shared output budget, DNS-pinned connections, redirect revalidation, private-network blocking by default, bounded bodies/timeouts/retries, caching, fingerprints, and HTML/JSON/XML/PDF/text extraction. Use `allow_private=true` only for deliberate local-service access.

`alonix-web-search` supports frequent legitimate research. Batch independent questions, use additional calls for new or dependent questions, and avoid only unchanged consecutive duplicate requests.

## Stealth contract

`alonix-stealth-fetch-many`, `alonix-stealth-search-many`, `alonix-stealth-rotate-tor`, and `alonix-stealth-status` are native plugin tools. Tor starts on dedicated ports 19050/19051 by default, uses cookie authentication, waits for bootstrap, and is stopped only if this package launched it. Configure Tor in local secrets or place it on PATH.

## Service lifecycle

```powershell
npm run services -- status
npm run services -- start
npm run services -- stop
npm run services -- restart
```

The manager refuses to terminate unrelated or unverifiable port owners.

## Safe configuration migration

Optional `npm run install:opencode` migration helper:

1. Backs up the existing global `opencode.json` and guidance.
2. Preserves provider, model, UI, DCP, and unrelated plugin configuration.
3. Replaces only legacy custom-tool plugin paths with this repository's root plugin.
4. Removes the old stealth MCP entry.
5. Disables built-in webfetch and allows the native replacement tools.
6. Records rollback state locally.
7. Backs up and merges the global `tui.json`, registering the unified TUI companion (`packages/tui/index.tsx`). Uninstall restores the TUI backup or removes only the unified entry.

Use `npm run uninstall:opencode` to restore the prior config/guidance backups. Re-running the installer is idempotent and preserves the first valid pre-migration backup rather than replacing it with an already-migrated file.

## Sharing

Share the repository without `node_modules`, virtual environments, generated settings, runtime state, local backups, or `config/secrets.local.json`. Run `npm run verify:shareable` before publishing. A friend installs package dependencies, adds only the root `index.js` plugin to OpenCode, and supplies their own optional keys/Tor path; companion registration and binary repair then self-heal automatically.

SearXNG source remains under its upstream AGPL-3.0 license in `services/searxng/LICENSE`. Package-specific upstream licenses and notices remain with copied packages.
