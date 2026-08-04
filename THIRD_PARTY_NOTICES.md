# Third-party notices

This repository aggregates independently licensed components. Their original license files and notices remain in their package/service directories.

- **SearXNG** (`services/searxng`): GNU Affero General Public License v3.0 or later. See `services/searxng/LICENSE` and upstream source headers.
- **OpenCode plugin SDK and npm/Python dependencies**: installed from their respective package registries under the licenses declared by each dependency.
- **CBM backend integration**: the wrapper invokes the separately installed `codebase-memory-mcp` command and does not bundle that external executable.
- **Tor**: not bundled by default. Users provide a Tor executable or portable distribution under its own license.
- **Patchright/Chromium**: installed locally by `npm run setup`; browser/runtime artifacts are not committed.

Do not remove upstream copyright or license files when redistributing this repository.
