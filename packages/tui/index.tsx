/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createRoot, createSignal } from "solid-js"
import {
  customTools,
  formatStateLog,
  indicatorFor,
  readStateSync,
  rootFromModule,
  statePathForRoot,
  toastForTransition,
} from "./lib/status.js"
import { createTokens } from "./lib/design.js"
import { BackgroundView } from "./components/background.jsx"
import { EditManyView } from "./components/edit-many.jsx"
import { ReadManyView } from "./components/read-many.jsx"
import { ReportView } from "./components/report.jsx"
import { ShellView } from "./components/shell.jsx"
import { DiscoveryView } from "./components/discovery.jsx"
import { WebView } from "./components/web.jsx"
import { StealthView } from "./components/stealth.jsx"
import { CbmView } from "./components/cbm.jsx"
import { ClockProvider, createClock, createSessionStore, createSkin } from "./components/runtime.jsx"
import { HomeDeck, PromptContext, StatusBar, WorkspaceInspector } from "./components/ide-surfaces.jsx"
import { SessionSwitcher } from "./components/session-switcher.jsx"
import { ToolingStatusView } from "./components/tooling-status.jsx"

type Tokens = ReturnType<typeof createTokens>

type RenderProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: unknown
}

type RendererView = (props: RenderProps & { skin: Tokens }) => JSX.Element

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

/**
 * Transcript renderers keep the established `skin` prop contract. The IDE
 * design tokens are a superset of the previous skin keys, so activity surfaces
 * inherit the new palette without changing their own code.
 */
function toolSkin(tokens: Tokens) {
  return {
    ...tokens,
    panel: tokens.raised,
    surface: tokens.surface,
    surfaceHover: tokens.hover,
    inset: tokens.inset,
    section: tokens.faint,
    successSurfaceHover: tokens.successSurfaceHover,
    errorSurfaceHover: tokens.errorSurfaceHover,
    warningSurfaceHover: tokens.warningSurfaceHover,
    accentSurfaceHover: tokens.accentSurfaceHover,
  }
}

const tui: TuiPlugin = async (api, options) => {
  if (options?.enabled === false) return

  const root = rootFromModule(import.meta.url)
  const statePath = statePathForRoot(root)
  const motion = options?.animations !== false

  // Make generic custom-tool output visible even before the patched binary exists.
  try {
    api.kv.set("generic_tool_output_visibility", true)
  } catch {
    // KV is not namespaced; failure is harmless.
  }

  const registration: RendererRegistration = {
    available: false,
    registered: 0,
    failed: [],
  }

  // All plugin-level reactive state lives in one explicit root: this function is
  // async, so no ambient Solid owner is guaranteed when it runs, and memos
  // created without an owner would never be disposed. The root is torn down with
  // the plugin lifecycle.
  const scope = createRoot((disposeRoot) => {
    const tokens = createSkin(api, { motion })
    const clock = createClock(motion)
    const store = createSessionStore(api)
    const [toolingState, setToolingState] = createSignal(readStateSync(statePath))
    const [registered, setRegistered] = createSignal(0)
    const tooling = createMemo(() => {
      const state = toolingState()
      const active = registered()
      return {
        state,
        // Live renderer registration is stronger evidence of the running binary
        // than the state file, which another process owns.
        indicator: indicatorFor(state, { renderersRegistered: active }),
        registration: { ...registration, registered: active },
      }
    })
    return { tokens, clock, store, toolingState, setToolingState, setRegistered, tooling, disposeRoot }
  })
  const { tokens, clock, store, toolingState, setToolingState, setRegistered, tooling } = scope

  // Register rich renderers through the patched core's api.toolRenderers.
  const extended = api as TuiPluginApi & {
    toolRenderers?: { register(name: string, renderer: (props: RenderProps) => JSX.Element): void | (() => void) }
  }
  const registry = extended.toolRenderers
  registration.available = Boolean(registry && typeof registry.register === "function")
  if (registry && typeof registry.register === "function") {
    for (const name of customTools) {
      try {
        const View = rendererFor(name)
        const dispose = registry.register(name, (props) => <View skin={toolSkin(tokens())} {...props} />)
        if (typeof dispose === "function") api.lifecycle.onDispose(dispose)
        registration.registered += 1
      } catch {
        registration.failed.push(name)
      }
    }
    setRegistered(registration.registered)
  }

  const openSwitcher = () => {
    api.ui.dialog.setSize("large")
    api.ui.dialog.replace(() => {
      const dimensions = useTerminalDimensions()
      return (
        <ClockProvider clock={clock}>
          <SessionSwitcher
            api={api}
            tokens={tokens}
            store={store}
            dimensions={dimensions}
            onClose={() => api.ui.dialog.clear()}
          />
        </ClockProvider>
      )
    })
    store.refresh()
  }

  try {
    api.slots.register({
      order: 20,
      slots: {
        home_prompt_right() {
          return (
            <ClockProvider clock={clock}>
              <PromptContext api={api} tokens={tokens} />
            </ClockProvider>
          )
        },
        session_prompt_right(_ctx, props) {
          return (
            <ClockProvider clock={clock}>
              <PromptContext api={api} tokens={tokens} sessionID={props.session_id} />
            </ClockProvider>
          )
        },
        home_bottom() {
          const dimensions = useTerminalDimensions()
          return (
            <ClockProvider clock={clock}>
              <HomeDeck api={api} tokens={tokens} store={store} dimensions={dimensions} />
            </ClockProvider>
          )
        },
        sidebar_content(_ctx, props) {
          return (
            <ClockProvider clock={clock}>
              <WorkspaceInspector
                api={api}
                tokens={tokens}
                store={store}
                sessionID={props.session_id}
                tooling={tooling()}
              />
            </ClockProvider>
          )
        },
        app_bottom() {
          return (
            <ClockProvider clock={clock}>
              <StatusBar api={api} tokens={tokens} store={store} tooling={tooling()} />
            </ClockProvider>
          )
        },
      },
    })
  } catch {
    // slots.register is plugin-context only; ignore otherwise.
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: "alonix-ide.sessions",
        title: "Alonix session switcher",
        category: "Session",
        namespace: "palette",
        slashName: "alonix-sessions",
        run: openSwitcher,
      },
      {
        name: "alonix-toolings.status",
        title: "Tooling status",
        category: "Plugin",
        namespace: "palette",
        slashName: "alonix-toolings",
        run() {
          api.ui.dialog.setSize("large")
          api.ui.dialog.replace(() => (
            <ClockProvider clock={clock}>
              <ToolingStatusView tokens={tokens} tooling={tooling()} log={formatStateLog(toolingState())} />
            </ClockProvider>
          ))
        },
      },
    ],
    bindings: [],
  })

  // Live patch-progress toasts, one per transition, from the same poller.
  let previous: unknown = null
  const poll = setInterval(() => {
    const state = readStateSync(statePath)
    setToolingState(state)
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
  api.lifecycle.onDispose(() => {
    clearInterval(poll)
    scope.disposeRoot()
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "sparkly-alonix-toolings",
  tui,
}

export default plugin
