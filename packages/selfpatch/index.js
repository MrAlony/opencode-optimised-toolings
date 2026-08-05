import path from "node:path"
import { fileURLToPath } from "node:url"
import { readState, stateSummary, writeState } from "./lib/state.js"
import { runSelfPatch } from "./lib/pipeline.js"

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
}

/**
 * Server-side half of the unified plugin.
 *
 * On plugin load it detects the running OpenCode binary; if the binary is not
 * the patched build it downloads the exact-version source, applies the bundled
 * anchor patches, rebuilds, and installs the patched binary over the official
 * one in place — no running instance is stopped and nothing restarts by
 * itself; the user restarts OpenCode at their convenience and the next launch
 * reports the patched binary as active. Progress and errors are continuously
 * written to the shared state file that the TUI companion renders. Tool
 * outputs are never modified.
 */
export async function SelfPatchPlugin() {
  const root = repoRoot()
  let started = false

  function ensureStarted() {
    if (started) return
    started = true
    void (async () => {
      try {
        // runSelfPatch installs the patched binary over the official one in
        // place and leaves every running instance untouched; the user restarts
        // OpenCode at their convenience to activate it.
        await runSelfPatch(root)
      } catch (error) {
        await writeState(root, {
          status: "error",
          progressPercent: 0,
          stepLabel: "Self-patch failed; running the official binary",
          lastError: error?.message ?? String(error),
        }).catch(() => {})
      }
    })()
  }

  // Run the self-patch pipeline immediately on plugin load so the shared
  // state file reflects the actual runtime before any tool call or TUI poll.
  // The pipeline is idempotent: dev-mode, no-opencode, unsupported versions,
  // and already-patched binaries all short-circuit without touching the binary.
  ensureStarted()

  return {
    tool: {
      toolings: {
        description:
          "Reports the Sparkly tooling self-patch state: status, OpenCode version, progress, errors, and whether rich tool renderers are active.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["status"], description: "What to do. Only status is supported." },
          },
          additionalProperties: false,
        },
        execute: async () => {
          ensureStarted()
          const state = await readState(root)
          return [
            `Self-patch status: ${state.status}`,
            `OpenCode version: ${state.version ?? "unknown"}`,
            `Patched binary active: ${state.status === "ok" ? "yes" : "no"}`,
            `Rich tool renderers: ${state.renderersActive ? "active" : "inactive (needs the patched binary)"}`,
            state.progressPercent > 0 ? `Progress: ${state.progressPercent}% — ${state.stepLabel}` : `Step: ${state.stepLabel}`,
            state.lastError ? `Last error: ${state.lastError}` : null,
          ]
            .filter(Boolean)
            .join("\n") + (state.logTail ? `\n\nRecent build output:\n${state.logTail}` : "")
        },
      },
    },
    dispose: () => {
      started = true
    },
  }
}

export { stateSummary }
