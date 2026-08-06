# Local release and recovery

## Non-negotiable release model

This repository uses a deterministic local release pipeline. GitHub Actions, GitHub-hosted runners, self-hosted runners, and external CI runners are not part of the build or publication path.

GitHub stores reviewed source, annotated tags, and release history. npm distributes the installable package. The local release command performs all testing, building, packaging, 2FA publication, and registry verification from the exact immutable tag.

Repository agents must follow `AGENTS.md`. In particular, they must never add or depend on a publishing workflow or move/delete an existing tag.

## Normal release procedure

1. Complete implementation and verification in the working tree.
2. Update the package version using semantic versioning.
3. Commit and push `main`.
4. Create and push a new annotated tag whose `vX.Y.Z` exactly matches `package.json`.
5. From a secure local terminal, run:

```powershell
npm run release:local -- --tag vX.Y.Z --publish
```

The command:

- requires a clean checkout;
- requires an annotated tag contained in `origin/main`;
- reads package source from `git archive <tag>`, never from mutable working-tree files;
- refuses to reuse an npm version;
- installs from the lockfile with lifecycle scripts disabled;
- runs the complete test matrix and generated-asset build locally;
- builds and audits the runtime-only npm tarball;
- rejects tests, runtime state, virtual environments, backups, secrets, and obsolete Python worker files;
- installs the tarball into a clean temporary consumer;
- verifies exactly 17 current public tools and rejects legacy `many` IDs;
- delegates authentication to npm's native passkey/security-key flow without handling credentials itself;
- publishes the exact verified tarball with public access;
- verifies npm registry integrity and shasum against the local artifact.

Use `--verify-only` instead of `--publish` to execute every pre-publication check without changing npm.

## Security properties

- npm account 2FA remains mandatory. npm performs the native passkey/security-key challenge directly; the release script never receives, logs, or persists authentication material.
- npm's registry integrity and shasum are compared with the exact locally verified tarball after publication.
- The annotated Git tag is the immutable source checkpoint and cannot be moved or reused.
- Package contents are controlled by the runtime-only `files` allowlist and tested from a clean consumer.
- Local secrets, npm credentials, passkeys, OTPs, recovery codes, generated runtime state, and private user configuration are never included.
- Existing npm versions are immutable; fixes always receive a new semantic version and tag.

Local publication does not produce GitHub OIDC provenance because that attestation describes a supported cloud CI identity. This repository deliberately avoids runner dependency. Runtime code, npm integrity, 2FA protections, immutable tagged source, and clean-consumer behavior are unaffected; the local release pipeline provides independent tag-to-tarball and tarball-to-registry verification.

## Required recovery controls

1. Keep npm account 2FA/passkey enabled and store recovery codes offline in two independent secure locations.
2. Maintain at least one additional trusted npm maintainer account with publish access.
3. Maintain at least two GitHub repository administrators.
4. Retain local clones and GitHub annotated tags as rebuildable source checkpoints.
5. Never commit `.npmrc` credentials, npm tokens, OTPs, passkeys, recovery codes, or package secrets.

## Failure handling

- Failure before `npm publish` leaves the registry unchanged. Fix the cause and rerun the same tag.
- If npm accepted the package but post-publication verification failed, do not republish or move the tag. Inspect the immutable registry version and publish a corrected new version if necessary.
- If npm is unavailable, wait and rerun locally. Do not create a runner workflow as a workaround.
- If package ownership becomes irrecoverable, rebuild from the annotated tag and publish under a recovery package name; only the single OpenCode plugin spec must change.
