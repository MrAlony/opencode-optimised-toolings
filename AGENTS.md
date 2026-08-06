# Repository Agent Rules

## Release policy: local-only, no runners

This repository must not depend on GitHub Actions, GitHub-hosted runners, self-hosted runners, or any other CI runner for building, testing, packaging, publishing, or recovering an npm release.

Mandatory rules for every human or AI agent:

1. Never create, restore, enable, dispatch, or rely on a publishing workflow under `.github/workflows/`.
2. Never configure a self-hosted runner for this repository.
3. Never require an npm trusted-publisher/OIDC workflow as the only release path.
4. Publish only from a clean local checkout using `npm run release:local -- --tag vX.Y.Z`.
5. The release command must build from the exact annotated Git tag, not from mutable working-tree files.
6. Keep npm account 2FA enabled. Enter the one-time code only into the local hidden prompt; never commit, log, echo, or store it.
7. Never publish an untagged version, move or delete an existing release tag, reuse an npm version, or bypass package-content/integrity checks.
8. Preserve all prior tags and releases. Corrections require a new semantic version.
9. Keep the package runtime-only allowlist and clean-consumer verification intact.
10. After publishing, verify npm registry integrity and installation from a clean temporary consumer before migrating live OpenCode configuration.

GitHub is the source mirror and release archive. npm is the installation/update registry. Local deterministic release tooling performs the build and publication work.

See `docs/RELEASE_RECOVERY.md` for the complete procedure and security model.
