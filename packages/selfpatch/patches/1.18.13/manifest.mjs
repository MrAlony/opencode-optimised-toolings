// Anchor patch manifest for OpenCode v1.18.13.
// Adds a plugin-registered tool-renderer registry consulted by the transcript
// ToolPart before the GenericTool fallback, plus the public api.toolRenderers
// registration surface. The registry is reactive: ToolPart display re-evaluates
// whenever renderers register, so parts mounted during early/reconnected
// render paths are not stuck as "generic". It also reconciles the actively viewed
// transcript across OpenCode processes and recovers persisted pending or running
// tool parts when a new session-loop generation proves their former in-memory
// runner no longer exists.
export const manifest = {
  version: "1.18.13",
  create: [
    {
      path: "packages/tui/src/plugin/tool-renderers.ts",
      content: `import type { JSX } from "@opentui/solid"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"

export type PluginToolRenderProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: ToolPart
}

export type PluginToolRenderer = (props: PluginToolRenderProps) => JSX.Element

const registry = new Map<string, { token: symbol; renderer: PluginToolRenderer }[]>()
const [registryVersion, bumpRegistryVersion] = createSignal(0)

export function pluginToolRendererVersion(): number {
  return registryVersion()
}

export function registerPluginToolRenderer(tool: string, renderer: PluginToolRenderer) {
  if (!tool || typeof tool !== "string") {
    throw new Error(\`registerPluginToolRenderer: invalid tool name \${JSON.stringify(tool)}\`)
  }
  if (typeof renderer !== "function") {
    throw new Error(\`registerPluginToolRenderer: renderer for \"\${tool}\" must be a function\`)
  }
  const token = Symbol(tool)
  const entries = registry.get(tool) ?? []
  registry.set(tool, [...entries, { token, renderer }])
  bumpRegistryVersion((prev) => prev + 1)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const current = registry.get(tool)
    if (!current) return
    const next = current.filter((entry) => entry.token !== token)
    if (next.length) registry.set(tool, next)
    else registry.delete(tool)
    bumpRegistryVersion((prev) => prev + 1)
  }
}

export function hasPluginToolRenderer(tool: string): boolean {
  void registryVersion()
  return (registry.get(tool)?.length ?? 0) > 0
}

export function getPluginToolRenderer(tool: string): PluginToolRenderer | undefined {
  void registryVersion()
  return registry.get(tool)?.at(-1)?.renderer
}

export function pluginToolRendererNames(): string[] {
  void registryVersion()
  return [...registry.keys()]
}
`,
    },
  ],
  files: [
    {
      path: "packages/tui/src/routes/session/index.tsx",
      beforeSha256: "98dc5efb0302f3b54a774005983f7e9aeb5c6b38368ce1f2f565a37fb94228d5",
      replacements: [
        {
          name: "registry import",
          search: `import { usePluginRuntime } from "../../plugin/runtime"
import { DialogRetryAction } from "../../component/dialog-retry-action"`,
          replace: `import { usePluginRuntime } from "../../plugin/runtime"
import { getPluginToolRenderer, hasPluginToolRenderer, pluginToolRendererVersion } from "../../plugin/tool-renderers"
import { DialogRetryAction } from "../../component/dialog-retry-action"`,
        },
        {
          name: "toolDisplay registry lookup",
          search: `export function toolDisplay(tool: string) {
  return toolDisplays.has(tool) ? tool : "generic"
}`,
          replace: `export function toolDisplay(tool: string) {
  if (toolDisplays.has(tool)) return tool
  if (hasPluginToolRenderer(tool)) return "plugin"
  return "generic"
}`,
        },
        {
          name: "ToolPart plugin branch",
          search: `        <Match when={display() === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={true}>`,
          replace: `        <Match when={display() === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={display() === "plugin"}>
          <PluginTool {...toolprops} />
        </Match>
        <Match when={true}>`,
        },
        {
          name: "PluginTool component",
          search: `      </BlockTool>
    </Show>
  )
}

function InlineTool(props: {`,
          replace: `      </BlockTool>
    </Show>
  )
}

function PluginTool(props: ToolProps) {
  const renderer = createMemo(() => getPluginToolRenderer(props.tool))
  return (
    <Show when={renderer()} fallback={<GenericTool {...props} />}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} flexShrink={0}>
        {renderer()!({ input: props.input, metadata: props.metadata, tool: props.tool, output: props.output, part: props.part })}
      </box>
    </Show>
  )
}

function InlineTool(props: {`,
        },
        {
          name: "reactive ToolPart display memo",
          search: `function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const display = createMemo(() => toolDisplay(props.part.tool))`,
          replace: `function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const display = createMemo(() => {
    void pluginToolRendererVersion()
    return toolDisplay(props.part.tool)
  })`,
        },
        {
          name: "active transcript cross-process reconciliation",
          search: `      editor.reconnect(result.data.directory)
      await sync.session.sync(sessionID)
      if (route.sessionID === sessionID && scroll) scroll.scrollBy(100_000)
    })().catch((error) => {`,
          replace: `      editor.reconnect(result.data.directory)
      await sync.session.sync(sessionID, { force: true })
      if (route.sessionID === sessionID && scroll) scroll.scrollBy(100_000)
    })().catch((error) => {`,
        },
        {
          name: "adaptive visible transcript refresh loop",
          search: `  })

  let lastSwitch: string | undefined = undefined
  event.on("message.part.updated", (evt) => {`,
          replace: `  })

  // Events are process-local on some OpenCode deployments. Reconcile only the
  // visible transcript from persisted session storage: fast while work is in
  // progress, slow while idle. sync() preserves live deltas that race the fetch.
  createEffect(() => {
    const sessionID = route.sessionID
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (delay: number) => {
      if (disposed) return
      timer = setTimeout(async () => {
        try {
          await sync.session.sync(sessionID, { force: true, transcriptOnly: true })
        } catch {
          // Keep the current transcript and retry; transient remote failures must
          // never throw the user out of an already-open chat.
        }
        if (disposed || route.sessionID !== sessionID) return
        schedule(sync.session.status(sessionID) === "working" ? 1250 : 5000)
      }, delay)
    }
    schedule(1250)
    onCleanup(() => {
      disposed = true
      if (timer) clearTimeout(timer)
    })
  })

  let lastSwitch: string | undefined = undefined
  event.on("message.part.updated", (evt) => {`,
        },
      ],
    },
    {
      path: "packages/tui/src/context/sync.tsx",
      beforeSha256: "648147d2abee2e01a467eacaf3abf78018ef184e2902ecaa6e3f2242484a8431",
      replacements: [
        {
          name: "forceable race-safe session reconciliation",
          search: `        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const syncing = syncingSessions.get(sessionID)
          if (syncing) return syncing
          const tracker = { messages: new Set<string>(), parts: new Set<string>() }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const [session, messages, todo, diff] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              sdk.client.session.messages({ sessionID, limit: 100 }),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.diff({ sessionID }),
            ])`,
          replace: `        async sync(
          sessionID: string,
          options: { force?: boolean; transcriptOnly?: boolean } = {},
        ) {
          if (fullSyncedSessions.has(sessionID) && !options.force) return
          const syncing = syncingSessions.get(sessionID)
          if (syncing) return syncing
          const tracker = { messages: new Set<string>(), parts: new Set<string>() }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const [session, messages, todo, diff] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              sdk.client.session.messages({ sessionID, limit: 100 }),
              options.transcriptOnly
                ? Promise.resolve({ data: store.todo[sessionID] ?? [] })
                : sdk.client.session.todo({ sessionID }),
              options.transcriptOnly
                ? Promise.resolve({ data: store.session_diff[sessionID] ?? [] })
                : sdk.client.session.diff({ sessionID }),
            ])`,
        },
        {
          name: "remove stale message part records during reconciliation",
          search: `                for (const message of removed) delete draft.part[message.id]
                draft.message[sessionID] = visible`,
          replace: `                for (const message of removed) delete draft.part[message.id]
                for (const message of currentMessages) {
                  if (!visibleIDs.has(message.id) && !tracker.messages.has(message.id)) delete draft.part[message.id]
                }
                draft.message[sessionID] = visible`,
        },
      ],
    },
    {
      path: "packages/plugin/src/tui.ts",
      beforeSha256: "3b0ccca22ebf8558afb9dc055505c7c503930f2f622d1db8c3fb9ca3e9278e8c",
      replacements: [
        {
          name: "public tool renderer types",
          search: `export type TuiDispose = () => void | Promise<void>`,
          replace: `export type TuiToolRenderProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: Part
}

export type TuiToolRenderer = (props: TuiToolRenderProps) => JSX.Element

export type TuiToolRenderers = {
  register: (tool: string, renderer: TuiToolRenderer) => () => void
}

export type TuiDispose = () => void | Promise<void>`,
        },
        {
          name: "public api toolRenderers property",
          search: `  renderer: CliRenderer
  slots: TuiSlots`,
          replace: `  renderer: CliRenderer
  toolRenderers: TuiToolRenderers
  slots: TuiSlots`,
        },
        {
          name: "public deferred session draft api",
          search: `  route: {
    register: (routes: TuiRouteDefinition[]) => () => void
    navigate: (name: string, params?: Record<string, unknown>) => void
    readonly current: TuiRouteCurrent
  }
  ui: {`,
          replace: `  route: {
    register: (routes: TuiRouteDefinition[]) => () => void
    navigate: (name: string, params?: Record<string, unknown>) => void
    readonly current: TuiRouteCurrent
  }
  /** Prepare the native home prompt for a directory; no session exists until submit. */
  sessionDraft: {
    open: (directory: string) => void
  }
  ui: {`,
        },
        {
          // Declares the left layout column added to app.tsx below, so a
          // plugin can render a dock that pushes the app aside instead of
          // floating above it.
          name: "app_left slot type",
          search: `export type TuiHostSlotMap = {
  app: {}
  app_bottom: {}`,
          replace: `export type TuiHostSlotMap = {
  app: {}
  /** Left-hand layout column; content here pushes the app aside. */
  app_left: {}
  app_bottom: {}`,
        },
      ],
    },
    {
      path: "packages/opencode/src/plugin/tui/runtime.ts",
      beforeSha256: "f454bc0c2ec61d5cf605f4c65b2223692cd6731f501fd64a4a762a8868c69e70",
      replacements: [
        {
          name: "scoped deferred session draft forwarding",
          search: `    mode: createScopedMode(api.mode, scope),
    route,
    ui: api.ui,`,
          replace: `    mode: createScopedMode(api.mode, scope),
    route,
    sessionDraft: api.sessionDraft,
    ui: api.ui,`,
        },
        {
          name: "scoped tool renderer forwarding",
          search: `    event,
    renderer: api.renderer,
    slots,`,
          replace: `    event,
    renderer: api.renderer,
    toolRenderers: {
      register(tool, renderer) {
        return scope.track(api.toolRenderers.register(tool, renderer))
      },
    },
    slots,`,
        },
      ],
    },
    {
      path: "packages/opencode/src/session/prompt.ts",
      beforeSha256: "79519fc90f6cac8ee992a7d772474e257758bcff44a2fe3b402bb1803ef72c3e",
      replacements: [
        {
          name: "orphaned unfinished tool recovery helper",
          search: `function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}`,
          replace: `function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

function recoverOrphanedToolParts(messages: SessionV1.WithParts[], now: number) {
  const recovered: SessionV1.ToolPart[] = []
  const next = messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "tool" || (part.state.status !== "pending" && part.state.status !== "running")) return part
      const state = part.state
      const updated = {
        ...part,
        state: {
          status: "error",
          error: "Tool execution interrupted before completion",
          input: state.input,
          metadata: {
            ...(state.status === "running" ? state.metadata : undefined),
            interrupted: true,
            recovered: true,
          },
          time: {
            start: state.status === "running" ? state.time.start : now,
            end: now,
          },
        },
      } satisfies SessionV1.ToolPart
      recovered.push(updated)
      return updated
    }),
  }))
  return { messages: next, recovered }
}`,
        },
        {
          name: "recover unfinished tools at new runner boundary",
          search: `          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)`,
          replace: `          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )

          // SessionRunState executes this effect only for a newly owning runner.
          // On its first iteration, unfinished persisted parts therefore belong to
          // a generation whose in-memory finalizer can no longer complete them.
          if (step === 0) {
            const recovery = recoverOrphanedToolParts(msgs, Date.now())
            if (recovery.recovered.length > 0) {
              yield* Effect.forEach(recovery.recovered, (part) => sessions.updatePart(part), {
                concurrency: "unbounded",
                discard: true,
              })
              yield* Effect.logWarning("recovered orphaned unfinished tools", {
                "session.id": sessionID,
                count: recovery.recovered.length,
                calls: recovery.recovered.map((part) => ({ tool: part.tool, callID: part.callID })),
              })
              msgs = recovery.messages
            }
          }

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)`,
        },
      ],
    },
    {
      // A left dock must occupy layout space rather than float above the
      // transcript: an absolutely positioned panel covers the content it is
      // meant to sit beside. Wrapping the root in a row and giving plugins an
      // `app_left` slot lets the dock push the app aside, and collapse back to
      // nothing when it renders empty.
      path: "packages/tui/src/app.tsx",
      beforeSha256: "c0715487889226993d4d6f3938880aad999704ca89211dcd70cbf77ec5b1e3d7",
      replacements: [
        {
          name: "root row wrapper",
          search: `      <Show when={ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Switch>`,
          replace: `      <Show when={ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="row">
          <box flexShrink={0}>
            <pluginRuntime.Slot name="app_left" />
          </box>
          <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column">
          <Switch>`,
        },
        {
          name: "root row wrapper close",
          search: `          {plugin()}
        </box>
        <box flexShrink={0}>
          <pluginRuntime.Slot name="app_bottom" />
        </box>`,
          replace: `          {plugin()}
          </box>
        </box>
        <box flexShrink={0}>
          <pluginRuntime.Slot name="app_bottom" />
        </box>`,
        },
      ],
    },
    {
      path: "packages/tui/src/plugin/adapters.tsx",
      beforeSha256: "ecff9bb3a2d1acf0f4ee6d1dacf213ee059d88fa22cedced8cafa51dfb4eb353",
      replacements: [
        {
          name: "tool-renderers and session-draft imports",
          search: `export { createPluginRoutes, createTuiApi } from "./api"`,
          replace: `export { createPluginRoutes, createTuiApi } from "./api"
import { registerPluginToolRenderer } from "./tool-renderers"
import { setHomeSessionDestination } from "../routes/home/session-destination"`,
        },
        {
          name: "api.sessionDraft surface",
          search: `    route: {
      register(list) {
        return input.routes.register(list)
      },
      navigate(name, params) {
        routeNavigate(input.route, name, params)
      },
      get current() {
        return routeCurrent(input.route)
      },
    },
    ui: {`,
          replace: `    route: {
      register(list) {
        return input.routes.register(list)
      },
      navigate(name, params) {
        routeNavigate(input.route, name, params)
      },
      get current() {
        return routeCurrent(input.route)
      },
    },
    sessionDraft: {
      open(directory) {
        const target = directory.trim()
        if (!target) throw new Error("A directory is required to prepare a session draft")
        setHomeSessionDestination(target)
        routeNavigate(input.route, "home")
      },
    },
    ui: {`,
        },
        {
          name: "api.toolRenderers surface",
          search: `    renderer: input.renderer,
    slots: {`,
          replace: `    renderer: input.renderer,
    toolRenderers: {
      register(tool, renderer) {
        return registerPluginToolRenderer(tool, renderer)
      },
    },
    slots: {`,
        },
      ],
    },
    {
      path: "packages/tui/src/routes/home/session-destination.tsx",
      beforeSha256: "6bd539d6ce6ece6bb0b5b94e186fe8b06ad06559fa97dae17ea52bf3f14ecc90",
      replacements: [
        {
          name: "session draft cleanup import",
          search: `  createMemo,
  createSignal,
  useContext,`,
          replace: `  createMemo,
  createSignal,
  onCleanup,
  useContext,`,
        },
        {
          name: "host-owned persistent home destination",
          search: `const HomeSessionDestinationContext = createContext<Context>()

export function HomeSessionDestinationProvider(props: ParentProps) {
  const sync = useSync()
  const paths = useTuiPaths()
  const [selected, setDestination] = createSignal<HomeSessionDestination>()`,
          replace: `const HomeSessionDestinationContext = createContext<Context>()
const [selected, setDestination] = createSignal<HomeSessionDestination>()

/** Prepare the native home prompt without creating a session. */
export function setHomeSessionDestination(directory: string) {
  const target = directory.trim()
  if (!target) throw new Error("A directory is required to prepare a session draft")
  setDestination({ type: "directory", directory: target, subdirectory: false })
}

export function HomeSessionDestinationProvider(props: ParentProps) {
  const sync = useSync()
  const paths = useTuiPaths()
  // A cancelled draft must not leak its folder into a later native New session.
  onCleanup(() => setDestination(undefined))`,
        },
      ],
    },
  ],
}
