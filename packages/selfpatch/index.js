import path from "node:path"
import { fileURLToPath } from "node:url"
import { readState, stateSummary, writeState } from "./lib/state.js"
import { runSelfPatch } from "./lib/pipeline.js"
import { ensureTuiCompanion } from "./lib/tui-registration.js"
import { runtimeHealth } from "../shared/generation.js"

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
}

/**
 * Server-side half of the unified plugin.
 *
 * On plugin load it first ensures the rich TUI companion is registered in the
 * user's TUI config, then detects the running OpenCode binary. If the binary is
 * not the enhanced build it downloads the installed version's source, selects
 * an exact or byte-verified compatible capability profile, rebuilds, and installs
 * the enhanced binary over the official one. If host capabilities changed, the
 * official binary and the portable plugin continue unchanged. Interactive
 * OpenCode processes are never stopped. Dedicated `opencode serve` processes
 * are retired only when the host-controller identity changes or a mismatched
 * artifact is quarantined, preventing a new client window from reusing a
 * withdrawn in-memory server. Progress and errors are continuously
 * written to the shared state file that the TUI companion renders. Tool
 * outputs are never modified.
 */
export async function SelfPatchPlugin() {
  const root = repoRoot()
  let started = false
  let tuiRegistration
  try {
    tuiRegistration = await ensureTuiCompanion(root)
  } catch (error) {
    // Maintenance diagnostics belong in structured status, never painted over
    // the active terminal. Portable tools remain available and the next launch
    // retries registration.
    tuiRegistration = { error: error?.message ?? String(error), changed: false, restartRequired: false }
  }

  function ensureStarted() {
    if (started) return
    started = true
    void (async () => {
      try {
        // runSelfPatch only installs a binary after strict source-capability
        // verification. OpenCode updates and incompatible official binaries are
        // never blocked or replaced; portable plugin behavior stays available.
        await runSelfPatch(root)
      } catch (error) {
        await writeState(root, {
          status: "portable",
          progressPercent: 0,
          stepLabel: "Plugin active in portable mode; optional host enhancement failed",
          renderersActive: false,
          lastError: error?.message ?? String(error),
        }).catch(() => {})
      }
    })()
  }

  // Run the self-patch pipeline immediately on plugin load so the shared
  // state file reflects the actual runtime before any tool call or TUI poll.
  // The pipeline is idempotent and update-safe: source-incompatible versions,
  // dev-mode, no-opencode, and already-enhanced binaries never modify the host.
  ensureStarted()

  return {
    tool: {
      "alonix-toolings": {
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
          const runtime = runtimeHealth(process.env, root)
          const short = (value) => typeof value === "string" ? value.slice(0, 16) : "unknown"
          return [
            `Enhancement status: ${state.status}`,
            `OpenCode version: ${state.version ?? "unknown"}`,
            `Plugin active: yes`,
            `Runtime parity: ${runtime.exact ? "exact" : `not proven (${runtime.reason})`}`,
            runtime.server ? `Server loaded: v${runtime.server.version ?? "unknown"} · source ${short(runtime.server.sourceFingerprint)} · dependencies ${short(runtime.server.dependencyFingerprint)}` : "Server loaded: attestation unavailable",
            runtime.tui ? `TUI loaded: v${runtime.tui.version ?? "unknown"} · ${runtime.tui.status}/${runtime.tui.stage ?? "unknown"} · source ${short(runtime.tui.sourceFingerprint)} · dependencies ${short(runtime.tui.dependencyFingerprint)}` : "TUI loaded: attestation unavailable",
            `Optional host enhancements: ${state.renderersActive ? "active" : "inactive; portable plugin features remain available"}`,
            state.compatibilityProfile ? `Compatibility profile: v${state.compatibilityProfile} (${state.compatibilityMode ?? "verified"})` : null,
            tuiRegistration.error
              ? `TUI companion registration: failed — ${tuiRegistration.error}`
              : `TUI companion registration: ${tuiRegistration.changed ? "added; restart required" : "present"}${tuiRegistration.configPath ? ` (${tuiRegistration.configPath})` : ""}`,
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
