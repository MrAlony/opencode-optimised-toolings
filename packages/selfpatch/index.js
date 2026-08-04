import path from "node:path"
import { fileURLToPath } from "node:url"
import { readState, stateSummary, writeState } from "./lib/state.js"
import { runSelfPatch } from "./lib/pipeline.js"
import { scheduleRestart } from "./lib/restart.js"

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
}

/**
 * Server-side half of the unified plugin.
 *
 * On plugin load it detects the running OpenCode binary; if the binary is not
 * the patched build it downloads the exact-version source, applies the bundled
 * anchor patches, rebuilds, swaps the binary, and restarts OpenCode once.
 * Progress and errors are continuously written to the shared state file that
 * the TUI companion renders. Tool outputs are never modified.
 */
export async function SelfPatchPlugin() {
  const root = repoRoot()
  let started = false

  function ensureStarted() {
    if (started) return
    started = true
    void (async () => {
      try {
        const result = await runSelfPatch(root)
        if (result && result.patchedPath && result.officialPath) {
          await writeState(root, { status: "swapping", progressPercent: 95, stepLabel: "Swapping binaries and restarting OpenCode" })
          await scheduleRestart(root, {
            officialPath: result.officialPath,
            patchedPath: result.patchedPath,
            cwd: process.cwd(),
          })
          await writeState(root, { status: "restarting", progressPercent: 100, stepLabel: "Session continues after restart" })
          // Give the TUI a moment to show the restart notice, then hand off.
          // OPENCODE_TOOLINGS_NO_EXIT=1 disables the exit (tests and non-interactive runtimes).
          if (process.env.OPENCODE_TOOLINGS_NO_EXIT === "1") return
          const parsedDelay = Number(process.env.OPENCODE_TOOLINGS_EXIT_DELAY_MS)
          setTimeout(() => process.exit(0), Number.isFinite(parsedDelay) && parsedDelay > 0 ? parsedDelay : 1200)
        }
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
