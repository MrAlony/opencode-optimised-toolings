/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
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
import { DiscoveryView } from "./components/discovery.jsx"
import { WebView } from "./components/web.jsx"
import { StealthView } from "./components/stealth.jsx"
import { CbmView } from "./components/cbm.jsx"
import { NativeHomeWorkspace, NativePromptContext, NativeWorkspaceInspector } from "./components/native-ide.jsx"

const palette = {
  panel: "#242424",
  border: "#4a4a4a",
  text: "#f0f0f0",
  muted: "#a5a5a5",
  accent: "#5f87ff",
  success: "#5faf5f",
  error: "#d75f5f",
  warning: "#d7af5f",
  surface: "#202124",
  surfaceHover: "#292b30",
  successSurface: "#1f2822",
  successSurfaceHover: "#26342a",
  errorSurface: "#2b2022",
  errorSurfaceHover: "#38272a",
  warningSurface: "#2b271e",
  warningSurfaceHover: "#393225",
  accentSurface: "#202631",
  accentSurfaceHover: "#283247",
  inset: "#191a1d",
  section: "#8296b8",
}

function ink(map, name, fallback) {
  return map?.[name] ?? fallback
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
    warning: ink(map, "warning", palette.warning),
    surface: ink(map, "backgroundElement", ink(map, "backgroundPanel", palette.surface)),
    surfaceHover: ink(map, "backgroundMenu", palette.surfaceHover),
    successSurface: ink(map, "backgroundSuccess", palette.successSurface),
    successSurfaceHover: ink(map, "backgroundSuccessHover", palette.successSurfaceHover),
    errorSurface: ink(map, "backgroundError", palette.errorSurface),
    errorSurfaceHover: ink(map, "backgroundErrorHover", palette.errorSurfaceHover),
    warningSurface: ink(map, "backgroundWarning", palette.warningSurface),
    warningSurfaceHover: ink(map, "backgroundWarningHover", palette.warningSurfaceHover),
    accentSurface: ink(map, "backgroundPrimary", palette.accentSurface),
    accentSurfaceHover: ink(map, "backgroundPrimaryHover", palette.accentSurfaceHover),
    inset: ink(map, "background", palette.inset),
    section: palette.section,
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
  if (tool === "alonix-read-many") return ReadManyView
  if (tool === "alonix-edit-many") return EditManyView
  if (tool === "alonix-shell") return ShellView
  if (tool === "alonix-background-process") return BackgroundView
  if (tool === "alonix-search" || tool === "alonix-explore") return DiscoveryView
  if (tool === "alonix-web-search" || tool === "alonix-web-fetch-many") return WebView
  if (tool.startsWith("alonix-stealth-")) return StealthView
  if (tool.startsWith("alonix-index-")) return CbmView
  return ReportView
}

type RendererRegistration = {
  available: boolean
  registered: number
  failed: string[]
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
    api.slots.register({
      order: 20,
      slots: {
        home_prompt_right() {
          return <NativePromptContext api={api} skin={skin} />
        },
        session_prompt_right(ctx) {
          return <NativePromptContext api={api} skin={skin} sessionID={ctx.session_id} />
        },
        home_bottom() {
          return <NativeHomeWorkspace api={api} skin={skin} />
        },
        sidebar_content(ctx) {
          const toolingState = readStateSync(statePath)
          return (
            <NativeWorkspaceInspector
              api={api}
              skin={skin}
              sessionID={ctx.session_id}
              tooling={{ state: toolingState, indicator: indicatorFor(toolingState), registration }}
            />
          )
        },
      },
    })
  } catch {
    // slots.register is plugin-context only; ignore otherwise.
  }

  // Command: alonix-toolings status details dialog.
  api.keymap.registerLayer({
    commands: [
      {
        name: "alonix-toolings.status",
        title: "Tooling status",
        category: "Plugin",
        namespace: "palette",
        slashName: "alonix-toolings",
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
  id: "sparkly-alonix-toolings",
  tui,
}

export default plugin
