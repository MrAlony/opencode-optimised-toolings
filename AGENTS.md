# Repository Agent Rules

## Deployment control plane

The only supported deployment-management interface is `npm run toolings -- status|doctor|reconcile`. Installed users declare only `opencode-optimised-toolings@latest` in `opencode.json`; `tui.json` must contain no Alonix entry. The canonical internal desired state is `~/.config/opencode/alonix/deployment.json`; the TUI bridge, `.sparkly-toolings-tui.json`, immutable generations, and host-patch state are derived implementation details. Never edit or activate those outputs independently. Use `reconcile --source=checkout` for direct-local validation; candidate/update/release tooling must call the same reconciler.

## Release policy: local-only, no runners

This repository must not depend on GitHub Actions, GitHub-hosted runners, self-hosted runners, or any other CI runner for building, testing, packaging, publishing, or recovering an npm release.

Mandatory rules for every human or AI agent:

1. Never create, restore, enable, dispatch, or rely on a publishing workflow under `.github/workflows/`.
2. Never configure a self-hosted runner for this repository.
3. Never require an npm trusted-publisher/OIDC workflow as the only release path.
4. Publish only from a clean local checkout using `npm run release:local -- --tag vX.Y.Z`.
5. The release command must build from the exact annotated Git tag, not from mutable working-tree files.
6. Keep npm account 2FA enabled. Let npm perform its native passkey/security-key challenge directly; never commit, log, echo, pass through AI chat, or store authentication material.
7. Never publish an untagged version, move or delete an existing release tag, reuse an npm version, or bypass package-content/integrity checks.
8. Preserve all prior tags and releases. Corrections require a new semantic version.
9. Keep the package runtime-only allowlist and clean-consumer verification intact.
10. After publishing, verify npm registry integrity and installation from a clean temporary consumer before migrating live OpenCode configuration.

GitHub is the source mirror and release archive. npm is the installation/update registry. Local deterministic release tooling performs the build and publication work.

See `docs/RELEASE_RECOVERY.md` for the complete procedure and security model.

## Mandatory validation promotion workflow

Every runtime, TUI, plugin-loading, configuration, updater, self-patch, or user-visible interaction change must move through these stages in order. No AI or human agent may skip a stage:

1. **Direct local checkout validation first.** During active development, global OpenCode server and TUI entries must point directly to this checkout's `index.js` and `packages/tui/index.tsx`. The user validates the mutable working tree in the real application before packaging work begins.
2. **Immutable installed candidate second.** Only after the user confirms direct-local behavior may an agent pack the exact working tree, provision an isolated immutable generation, and atomically activate one candidate package-root declaration in `opencode.json` with backups. `tui.json` must contain no Alonix entry; the verified host bridge resolves the same package's `./tui` export internally.
3. **Explicit release approval last.** Commit, tag, push, GitHub Release creation, npm publication, registry migration, or live `@latest`/exact-version activation requires a new explicit user approval after the candidate is confirmed.
4. A passing automated suite is necessary but never substitutes for direct-local and installed-candidate runtime validation.
5. Never silently switch a development session from direct local checkout to a candidate or published package. State the promotion and preserve rollback backups.
6. If candidate behavior differs from direct local behavior, stop release work and treat that as a packaging/runtime parity defect. Do not publish, tag a correction, or ask the user to accept the discrepancy.

The required promotion sequence is therefore: **local checkout -> user confirmation -> immutable candidate -> user confirmation -> Git/GitHub/npm release**.
