/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import {
  customTools,
  formatStateLog,
  indicatorFor,
  readStateSync,
  rootFromModule,
  statePathForRoot,
  toastForTransition,
} from "./lib/status.js"
import { BackgroundView } from "./components/background.jsx"
import { EditManyView } from "./components/edit-many.jsx"
import { ReadManyView } from "./components/read-many.jsx"
import { ReportView } from "./components/report.jsx"
import { ShellView } from "./components/shell.jsx"

const palette = {
  panel: "#242424",
  border: "#4a4a4a",
  text: "#f0f0f0",
  muted: "#a5a5a5",
  accent: "#5f87ff",
  success: "#5faf5f",
  error: "#d75f5f",
}

function ink(map, name, fallback) {
  const value = map?.[name]
  return typeof value === "string" ? value : fallback
}

function skinOf(theme) {
  const map = theme?.current ?? {}
  return {
    panel: ink(map, "backgroundMenu", ink(map, "backgroundPanel", palette.panel)),
    border: ink(map, "border", palette.border),
    text: ink(map, "text", palette.text),
    muted: ink(map, "textMuted", palette.muted),
    accent: ink(map, "primary", palette.accent),
    success: ink(map, "success", palette.success),
    error: ink(map, "error", palette.error),
  }
}

type Skin = ReturnType<typeof skinOf>

type RenderProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: unknown
}

type RendererView = (props: RenderProps & { skin: Skin }) => JSX.Element

function rendererFor(tool: string): RendererView {
  if (tool === "fs_read_many") return ReadManyView
  if (tool === "fs_edit_many") return EditManyView
  if (tool === "shell") return ShellView
  if (tool === "background_process") return BackgroundView
  return ReportView
}

type RendererRegistration = {
  available: boolean
  registered: number
  failed: string[]
}

function statusSlot(statePath: string, registration: RendererRegistration): TuiSlotPlugin {
  return {
    order: 50,
    slots: {
      sidebar_content(ctx) {
        const state = readStateSync(statePath)
        const indicator = indicatorFor(state)
        const skin = skinOf(ctx.theme)
        const color = indicator.level === "error" ? skin.error : indicator.level === "warn" ? skin.accent : indicator.level === "ok" ? skin.success : skin.text
        return (
          <box
            border
            borderColor={skin.border}
            backgroundColor={skin.panel}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            flexDirection="column"
            gap={1}
          >
            <text fg={color}>
              <b>Tooling</b>
            </text>
            <text fg={skin.muted}>{indicator.text}</text>
            {registration.available ? (
              <text fg={registration.failed.length ? skin.accent : skin.success}>
                Rich renderers registered: {registration.registered}/{customTools.length}
              </text>
            ) : (
              <text fg={skin.error}>Rich renderer API unavailable in this TUI runtime</text>
            )}
            {registration.failed.length ? <text fg={skin.error}>Failed: {registration.failed.join(", ").slice(0, 140)}</text> : null}
            {state.lastError ? <text fg={skin.error}>{String(state.lastError).slice(0, 140)}</text> : null}
          </box>
        )
      },
    },
  }
}

const tui: TuiPlugin = async (api, options) => {
  if (options?.enabled === false) return

  const root = rootFromModule(import.meta.url)
  const statePath = statePathForRoot(root)

  // Make generic custom-tool output visible even before the patched binary exists.
  try {
    api.kv.set("generic_tool_output_visibility", true)
  } catch {
    // KV is not namespaced; failure is harmless.
  }

  // Register rich renderers through the patched core's api.toolRenderers.
  const skin = { ...skinOf(api.theme), motion: options?.animations !== false }
  const extended = api as TuiPluginApi & {
    toolRenderers?: { register(name: string, renderer: (props: RenderProps) => JSX.Element): void | (() => void) }
  }
  const registry = extended.toolRenderers
  const registration: RendererRegistration = {
    available: Boolean(registry && typeof registry.register === "function"),
    registered: 0,
    failed: [],
  }
  if (registry && typeof registry.register === "function") {
    for (const name of customTools) {
      try {
        const View = rendererFor(name)
        const dispose = registry.register(name, (props) => <View skin={skin} {...props} />)
        if (typeof dispose === "function") api.lifecycle.onDispose(dispose)
        registration.registered += 1
      } catch {
        registration.failed.push(name)
      }
    }
  }

  try {
    api.slots.register(statusSlot(statePath, registration))
  } catch {
    // slots.register is plugin-context only; ignore otherwise.
  }

  // Command: toolings status details dialog.
  api.keymap.registerLayer({
    commands: [
      {
        name: "toolings.status",
        title: "Tooling status",
        category: "Plugin",
        namespace: "palette",
        slashName: "toolings",
        run() {
          const state = readStateSync(statePath)
          const skin = skinOf(api.theme)
          api.ui.dialog.setSize("large")
          api.ui.dialog.replace(() => (
            <box paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
              <text fg={skin.text}>
                <b>Sparkly tooling status</b>
              </text>
              <text fg={skin.muted}>{formatStateLog(state)}</text>
            </box>
          ))
        },
      },
    ],
    bindings: [],
  })

  // Live patch-progress toasts, one per transition.
  let previous: unknown = null
  const poll = setInterval(() => {
    const state = readStateSync(statePath)
    const toast = toastForTransition(previous, state)
    previous = state
    if (toast) {
      try {
        api.ui.toast(toast)
      } catch {
        // toasts are best-effort
      }
    }
  }, 750)
  api.lifecycle.onDispose(() => clearInterval(poll))
}

const plugin: TuiPluginModule & { id: string } = {
  id: "sparkly-toolings",
  tui,
}

export default plugin
