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
import { ClockProvider, createClock, createSkin, openSession } from "./components/runtime.jsx"
import { HomeDeck, PromptContext, StatusBar, WorkspaceInspector } from "./components/ide-surfaces.jsx"
import { ToolingStatusView } from "./components/tooling-status.jsx"
import { createProjectStore } from "./components/project-store.jsx"
import { Palette } from "./components/palette.jsx"
import { Workbench } from "./components/workbench.jsx"
import { ProjectAdd } from "./components/project-add.jsx"
import { Dock } from "./components/dock.jsx"
import { SettingsView } from "./components/settings.jsx"
import { applyManagedSettings, readManagedSettings } from "./lib/settings.js"
import { workbenchCommands } from "./lib/command-registry.js"

type Tokens = ReturnType<typeof createTokens>

const WORKBENCH_ROUTE = "alonix-workbench"
const SETTINGS_ROUTE = "alonix-settings"
const DOCK_KEY = "alonix_dock_open"

function readDockPreference(api: TuiPluginApi): boolean {
  try {
    return api.kv.get(DOCK_KEY, true) !== false
  } catch {
    return true
  }
}

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
    const projects = createProjectStore(api)
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
    const [workbenchView, setWorkbenchView] = createSignal<"activity" | "changes" | "plan">("activity")
    const [workbenchMode, setWorkbenchMode] = createSignal<"work" | "monitor">("work")
    // The dock is docked open by default: it is the primary navigation surface,
    // and the preference survives restarts.
    const [dockOpen, setDockOpen] = createSignal<boolean>(readDockPreference(api))
    return {
      tokens,
      clock,
      projects,
      toolingState,
      setToolingState,
      setRegistered,
      tooling,
      workbenchView,
      setWorkbenchView,
      workbenchMode,
      setWorkbenchMode,
      dockOpen,
      setDockOpen,
      disposeRoot,
    }
  })
  const { tokens, clock, projects, toolingState, setToolingState, setRegistered, tooling } = scope
  const { workbenchView, setWorkbenchView, workbenchMode, setWorkbenchMode, dockOpen, setDockOpen } = scope

  const toggleDock = () => {
    const next = !dockOpen()
    setDockOpen(next)
    try {
      api.kv.set(DOCK_KEY, next)
    } catch {
      // Persistence is best effort; the toggle still works this session.
    }
  }

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

  const openSwitcher = () => openPalette("")

  const openSettings = () => {
    try {
      api.route.navigate(SETTINGS_ROUTE)
    } catch {
      api.ui.toast({ variant: "warning", title: "Settings unavailable", message: "This host cannot open plugin routes." })
    }
  }

  const openWorkbench = () => {
    try {
      api.route.navigate(WORKBENCH_ROUTE)
    } catch {
      // The route is unavailable on an unpatched host; the switcher still works.
      openSwitcher()
    }
  }

  const openSessionTab = (sessionID: string) => {
    const row = projects.sessionRows().find((item) => item.id === sessionID)
    if (row) {
      projects.openTab({
        id: row.id,
        title: row.title,
        projectID: row.projectID,
        projectName: row.projectName,
        directory: row.directory,
      })
    }
    openSession(api, sessionID)
  }

  /** Controller handed to palette commands so they stay declarative. */
  const controller = {
    openWorkbench,
    openPalette: () => openPalette(),
    refresh: () => projects.refresh(),
    closeActiveTab: () => {
      const active = projects.workbench.activeID
      if (active) projects.closeTab(active)
    },
    togglePinActiveTab: () => {
      const active = projects.workbench.activeID
      if (active) projects.togglePinTab(active)
    },
    closeOtherTabs: () => projects.closeOtherTabs(),
    openActiveSession: () => {
      const active = projects.workbench.activeID
      if (active) openSession(api, active)
    },
    newSession: async () => openPalette("#"),
    chooseProjectForNewSession: () => openPalette("#"),
  }

  /**
   * Open a session's conversation. From the workbench this leaves the route,
   * which is what a user means by "show me the chat".
   */
  const openChat = (sessionID: string | null) => {
    if (sessionID) openSession(api, sessionID)
    else api.route.navigate("home")
  }

  /**
   * Prepare OpenCode's native home prompt for a folder.
   *
   * This deliberately does not call session.create. Native OpenCode creates the
   * session only after the first non-empty prompt is submitted, which prevents
   * folder clicks and cancelled drafts from littering the history.
   */
  const openSessionDraft = (directory?: string) => {
    const target = String(directory ?? "").trim()
    if (!target) {
      api.ui.toast({
        variant: "warning",
        title: "Folder unavailable",
        message: "This item has no usable directory. Open one of its existing chats instead.",
      })
      return false
    }
    const draftApi = (api as TuiPluginApi & { sessionDraft?: { open(directory: string): void } }).sessionDraft
    if (!draftApi || typeof draftApi.open !== "function") {
      // Portable fallback: keep the registered folder and return to OpenCode's
      // native new-chat screen without creating an empty session or touching
      // the installed binary. Exact folder targeting is an optional host
      // capability and will activate automatically on source-compatible builds.
      try {
        api.route.navigate("home")
      } catch {
        // The caller still retains the registered project in the portfolio.
      }
      api.ui.toast({
        variant: "info",
        title: "Folder saved",
        message: "Portable mode opened a native draft. The folder remains available in Alonix; no empty chat was created.",
      })
      return true
    }
    try {
      draftApi.open(target)
      return true
    } catch (error) {
      api.ui.toast({
        variant: "error",
        title: "Could not prepare the chat",
        message: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  const openProject = (project: { id?: string; worktree?: string }) => {
    if (project?.id) projects.selectProject(project)
    openSessionDraft(project?.worktree)
  }

  const openAddProject = () => {
    api.ui.dialog.setSize("large")
    api.ui.dialog.replace(() => (
      <ClockProvider clock={clock}>
        <ProjectAdd
          width={84}
          api={api}
          tokens={tokens}
          initialDirectory={(() => {
            try {
              return api.state.path?.worktree || api.state.path?.directory || ""
            } catch {
              return ""
            }
          })()}
          projects={() => projects.projectRows()}
          onClose={() => api.ui.dialog.clear()}
          onAdd={async (directory: string) => {
            projects.addProject(directory)
            if (!openSessionDraft(directory)) return
            api.ui.dialog.clear()
            api.ui.toast({
              variant: "success",
              title: "Folder ready",
              message: "Type your first message to create the chat.",
            })
          }}
        />
      </ClockProvider>
    ))
  }

  const openPalette = (initialQuery = "") => {
    // xlarge keeps titles readable; the palette sizes its columns to match.
    api.ui.dialog.setSize("xlarge")
    api.ui.dialog.replace(() => {
      const dimensions = useTerminalDimensions()
      return (
        <ClockProvider clock={clock}>
          <Palette
            tokens={tokens}
            dimensions={dimensions}
            size="xlarge"
            initialQuery={initialQuery}
            loading={() => projects.loading}
            sessions={() => projects.sessionRows()}
            projects={() => projects.projectRows()}
            commands={() =>
              workbenchCommands({
                tabCount: projects.workbench.tabs.length,
                activeSessionID: projects.workbench.activeID,
              })
            }
            onClose={() => api.ui.dialog.clear()}
            onRun={(action) => {
              api.ui.dialog.clear()
              if (action.kind === "session") {
                openSessionTab(action.targetID)
                return
              }
              if (action.kind === "project") {
                // A folder selection is a fresh-chat action. Previous chats are
                // separate session results and only open when chosen directly.
                openProject(action.project)
                return
              }
              action.run?.(controller)
            }}
          />
        </ClockProvider>
      )
    })
    projects.refresh()
  }

  // Full-screen workbench route. Registration is best effort: an unpatched or
  // older host simply keeps the dialog surfaces.
  try {
    const disposeRoute = api.route.register([
      {
        name: SETTINGS_ROUTE,
        render: () => (
          <ClockProvider clock={clock}>
            <SettingsView
              tokens={tokens}
              dockOpen={dockOpen}
              initial={readManagedSettings()}
              onSave={(draft: unknown) => applyManagedSettings(draft)}
              onClose={openWorkbench}
            />
          </ClockProvider>
        ),
      },
      {
        name: WORKBENCH_ROUTE,
        render: () => (
          <ClockProvider clock={clock}>
            <Workbench
              api={api}
              tokens={tokens}
              store={projects}
              // The dock occupies a sibling column; the workbench must size
              // itself against the remaining width.
              dockOpen={dockOpen}
              view={workbenchView}
              onView={setWorkbenchView}
              mode={workbenchMode}
              onMode={setWorkbenchMode}
              onAddProject={openAddProject}
              onSettings={openSettings}
              onPalette={() => openPalette()}
              onNewSession={() => openPalette("#")}
              onChooseProject={() => openPalette("#")}
              onOpenChat={openChat}
              onExit={() => openChat(projects.workbench.activeID)}
            />
          </ClockProvider>
        ),
      },
    ])
    if (typeof disposeRoute === "function") api.lifecycle.onDispose(disposeRoute)
  } catch {
    // route.register is plugin-context only; ignore otherwise.
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
              <HomeDeck api={api} tokens={tokens} store={projects} dimensions={dimensions} />
            </ClockProvider>
          )
        },
        sidebar_content(_ctx, props) {
          // Projects and sessions live in the left dock; this panel stays
          // focused on the current session so the two never duplicate.
          return (
            <ClockProvider clock={clock}>
              <WorkspaceInspector
                api={api}
                tokens={tokens}
                store={projects}
                sessionID={props.session_id}
                tooling={tooling()}
              />
            </ClockProvider>
          )
        },
        app_bottom() {
          return (
            <ClockProvider clock={clock}>
              <StatusBar api={api} tokens={tokens} store={projects} tooling={tooling()} />
            </ClockProvider>
          )
        },
        /*
          Left layout column, so the dock pushes the app aside instead of
          covering it, and the app reclaims the space when the dock is hidden.
          Present on the home screen and inside a session alike: this is the
          always-visible navigation surface.

          `app_left` is an optional verified host enhancement. On a host whose
          source changed, the slot simply does not render; the workbench,
          palette, registered folders, status bar, and native routes continue.
        */
        app_left() {
          return (
            <ClockProvider clock={clock}>
              <Dock
                api={api}
                tokens={tokens}
                store={projects}
                expanded={dockOpen}
                onToggle={toggleDock}
                onOpen={(session: { id: string; projectID?: string }) => {
                  if (session.projectID) projects.selectProject(session.projectID)
                  openSessionTab(session.id)
                }}
                onOpenProject={openProject}
                onHideProject={(project: { worktree?: string; name?: string }) => {
                  if (!project?.worktree) return
                  projects.hideProject(project.worktree)
                  api.ui.toast({
                    variant: "info",
                    title: `Removed ${project.name ?? "project"} from the list`,
                    message: "Sessions were not deleted. Add the folder again to bring it back.",
                  })
                }}
                onAddProject={openAddProject}
                onWorkbench={openWorkbench}
                onSettings={openSettings}
                onChooseProject={() => openPalette("#")}
                onNewSessionIn={(project: { worktree?: string }) => openSessionDraft(project?.worktree)}
              />
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
        name: "alonix-ide.palette",
        title: "Alonix palette (sessions, projects, actions)",
        category: "Workbench",
        namespace: "palette",
        slashName: "alonix",
        run: () => openPalette(),
      },
      {
        name: "alonix-ide.workbench",
        title: "Open the Alonix workbench",
        category: "Workbench",
        namespace: "palette",
        slashName: "alonix-workbench",
        run: openWorkbench,
      },
      {
        name: "alonix-ide.projects",
        title: "Switch project",
        category: "Workbench",
        namespace: "palette",
        slashName: "alonix-projects",
        run: () => openPalette("#"),
      },
      {
        name: "alonix-ide.project.add",
        title: "Add a project",
        category: "Workbench",
        namespace: "palette",
        slashName: "alonix-add-project",
        run: openAddProject,
      },
      {
        name: "alonix-ide.dock",
        title: "Show or hide the project sidebar",
        category: "Workbench",
        namespace: "palette",
        slashName: "alonix-sidebar",
        run: toggleDock,
      },
      {
        name: "alonix-ide.monitor",
        title: "Open the automatic live-work dashboard",
        category: "Workbench",
        namespace: "palette",
        slashName: "alonix-monitor",
        run: () => {
          setWorkbenchMode("monitor")
          openWorkbench()
        },
      },
      {
        name: "alonix-ide.sessions",
        title: "Alonix session switcher",
        category: "Session",
        namespace: "palette",
        slashName: "alonix-sessions",
        run: openSwitcher,
      },
      {
        name: "alonix-ide.settings",
        title: "Open Alonix settings",
        category: "Plugin",
        namespace: "palette",
        slashName: "alonix-settings",
        run: openSettings,
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
