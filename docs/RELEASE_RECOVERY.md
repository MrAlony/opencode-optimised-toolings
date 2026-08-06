# Release and recovery

## Normal releases

`opencode-optimised-toolings` uses npm trusted publishing. The npm package must trust:

- Provider: GitHub Actions
- Owner: `MrAlony`
- Repository: `opencode-optimised-toolings`
- Workflow: `publish.yml`
- Environment: `npm-release`

After the initial package bootstrap, `.github/workflows/publish.yml` exchanges GitHub's short-lived OIDC identity directly with npm. No npm token is stored in GitHub or required by normal releases. Annotated `v*` tags are the immutable release source, and the workflow verifies the tag version against `package.json` before publishing.

## Required recovery controls

Maintain all of the following so no single credential loss can orphan releases:

1. npm account 2FA or passkey enabled, with recovery codes stored offline in two independent secure locations.
2. At least one additional trusted npm maintainer account with publish access.
3. At least two GitHub repository administrators able to manage Actions environments and repository settings.
4. The `npm-release` GitHub environment protected by required reviewers.
5. Local clones and GitHub annotated release tags retained as rebuildable source checkpoints.

## Bootstrap token

A brand-new npm package cannot configure trusted publishing until the package exists. The first publish may therefore require a temporary granular npm token with only Read/Write access and Bypass 2FA. After the package's trusted publisher is configured and one OIDC release is proven, revoke the bootstrap token immediately.

Never commit npm tokens, `.npmrc` credentials, OTPs, recovery codes, or package secrets.

## Registry-loss fallback

Installed releases continue to work without registry access because runtime state is user-owned under `~/.config/opencode/alonix/`. If npm package ownership becomes irrecoverable despite the controls above, the annotated Git tag can be rebuilt and published under a recovery package name; only the single plugin spec must change.
