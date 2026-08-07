export const streamingCreate = {
  path: "packages/tui/src/routes/session/streaming.ts",
  content: `import { createEffect, createSignal, onCleanup } from "solid-js"
import type { CliRenderer } from "@opentui/core"

export type StreamingSettings = {
  enabled: boolean
  style: "adaptive" | "cinematic" | "instant"
  motion: "full" | "reduced"
  maxDelayMs: number
  reasoning: boolean
  tail: "subtle" | "off"
}

export const DEFAULT_STREAMING_SETTINGS: StreamingSettings = {
  enabled: true,
  style: "adaptive",
  motion: "full",
  maxDelayMs: 180,
  reasoning: false,
  tail: "subtle",
}

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined

export function normalizeStreamingSettings(input: unknown, animationsEnabled = true): StreamingSettings {
  const value = input && typeof input === "object" ? input as Partial<StreamingSettings> : {}
  const delay = Number(value.maxDelayMs)
  return {
    enabled: animationsEnabled && value.enabled !== false,
    style: value.style === "cinematic" || value.style === "instant" ? value.style : "adaptive",
    motion: value.motion === "reduced" ? "reduced" : "full",
    maxDelayMs: Number.isFinite(delay) ? Math.max(80, Math.min(500, Math.round(delay))) : 180,
    reasoning: value.reasoning === true,
    tail: value.tail === "off" ? "off" : "subtle",
  }
}

function graphemes(value: string) {
  if (!value) return []
  return segmenter ? Array.from(segmenter.segment(value), (item) => item.segment) : Array.from(value)
}

type RevealState = {
  source: string
  segments: string[]
  cursor: number
  initialized: boolean
  backlogSince: number
  pauseUntil: number
}

function initialState(source: string): RevealState {
  const segments = graphemes(source)
  return { source, segments, cursor: segments.length, initialized: false, backlogSince: 0, pauseUntil: 0 }
}

function updateState(state: RevealState, source: string, active: boolean, drain: boolean, animateInitial: boolean, settings: StreamingSettings, now: number): RevealState {
  const compatible = source.startsWith(state.source)
  let segments: string[]
  if (!state.source || !compatible || !state.segments.length) segments = graphemes(source)
  else if (source === state.source) segments = state.segments
  else {
    const last = state.segments.at(-1) ?? ""
    const boundary = Math.max(0, state.source.length - last.length)
    segments = [...state.segments.slice(0, -1), ...graphemes(source.slice(boundary))]
  }
  let cursor = Math.min(state.cursor, segments.length)
  if (!state.initialized) {
    cursor = animateInitial && active && settings.enabled && settings.style !== "instant" && settings.motion !== "reduced" ? 0 : segments.length
  } else if (!compatible || !settings.enabled || settings.style === "instant" || settings.motion === "reduced") {
    cursor = segments.length
  } else if (!active && !(drain && cursor < segments.length)) {
    cursor = segments.length
  }
  return {
    source,
    segments,
    cursor,
    initialized: true,
    backlogSince: cursor < segments.length ? state.backlogSince || now : 0,
    pauseUntil: compatible ? state.pauseUntil : 0,
  }
}

function inCodeBurst(state: RevealState) {
  const prefix = state.segments.slice(0, state.cursor).join("")
  const fences = (prefix.match(/\\x60\\x60\\x60/g) ?? []).length
  return fences % 2 === 1 || state.segments.length - state.cursor > 400
}

function budget(state: RevealState, settings: StreamingSettings, deltaTime: number, now: number) {
  const pending = state.segments.length - state.cursor
  if (pending <= 0) return 0
  const age = state.backlogSince ? Math.max(0, now - state.backlogSince) : 0
  if (age >= settings.maxDelayMs) return pending
  const frameMs = Math.max(8, Math.min(100, deltaTime || 33))
  const frames = Math.max(1, Math.floor((settings.maxDelayMs - age) / frameMs))
  const catchUp = Math.ceil(pending / frames)
  const base = settings.style === "cinematic" ? 1 : 2
  return Math.min(pending, Math.max(base, inCodeBurst(state) ? Math.max(8, catchUp) : catchUp))
}

type Controller = {
  pending(): boolean
  deadline(): number
  step(deltaTime: number): void
  flush(): void
}

export function createStreamingScheduler(renderer: CliRenderer) {
  const controllers = new Set<Controller>()
  let live = false
  let disposed = false
  let watchdog: ReturnType<typeof setTimeout> | undefined

  const drop = () => {
    if (!live) return
    live = false
    try { renderer.dropLive() } catch {}
  }
  const flush = () => {
    for (const controller of controllers) controller.flush()
    drop()
  }
  const wake = () => {
    if (disposed) return
    const pending = [...controllers].some((controller) => controller.pending())
    if (pending && !live) {
      try { renderer.requestLive(); live = true } catch { flush(); return }
    }
    if (!pending) drop()
    if (watchdog) clearTimeout(watchdog)
    const deadlines = [...controllers].filter((controller) => controller.pending()).map((controller) => controller.deadline())
    const delay = Math.min(600, Math.max(160, (deadlines.length ? Math.min(...deadlines) : 180) + 80))
    watchdog = pending ? setTimeout(flush, delay) : undefined
  }
  const frame = async (deltaTime: number) => {
    try {
      for (const controller of controllers) controller.step(deltaTime)
      wake()
    } catch {
      flush()
    }
  }
  renderer.setFrameCallback(frame)
  return {
    register(controller: Controller) {
      if (disposed) { controller.flush(); return () => {} }
      controllers.add(controller)
      wake()
      return () => { controllers.delete(controller); wake() }
    },
    wake,
    dispose() {
      if (disposed) return
      disposed = true
      if (watchdog) clearTimeout(watchdog)
      flush()
      controllers.clear()
      try { renderer.removeFrameCallback(frame) } catch {}
    },
  }
}

export function createStreamingText(input: {
  scheduler: ReturnType<typeof createStreamingScheduler>
  source: () => string
  active: () => boolean
  drain?: () => boolean
  animateInitial?: boolean
  settings: () => StreamingSettings
}) {
  let state = initialState(input.source())
  const [text, setText] = createSignal(state.source)
  const [pending, setPending] = createSignal(false)
  const publish = () => {
    setText(state.segments.slice(0, state.cursor).join(""))
    setPending(state.cursor < state.segments.length)
  }
  const controller: Controller = {
    pending: () => pending(),
    deadline: () => input.settings().maxDelayMs,
    step(deltaTime) {
      if (!pending()) return
      const settings = input.settings()
      const now = Date.now()
      if (state.pauseUntil && now < state.pauseUntil) return
      const count = budget(state, settings, deltaTime, now)
      const cursor = Math.min(state.segments.length, state.cursor + count)
      const revealed = state.segments.slice(state.cursor, cursor).join("")
      const punctuationPause = settings.style === "cinematic" && /[.!?…][\\s\\n]*$/.test(revealed) && cursor < state.segments.length
        ? Math.min(90, Math.max(24, Math.round(settings.maxDelayMs / 5)))
        : 0
      state = { ...state, cursor, pauseUntil: punctuationPause ? now + punctuationPause : 0 }
      if (state.cursor === state.segments.length) state.backlogSince = 0
      publish()
    },
    flush() {
      if (state.cursor === state.segments.length) return
      state = { ...state, cursor: state.segments.length, backlogSince: 0 }
      publish()
    },
  }
  const unregister = input.scheduler.register(controller)
  createEffect(() => {
    state = updateState(state, input.source(), input.active(), input.drain?.() === true, input.animateInitial === true, input.settings(), Date.now())
    publish()
    input.scheduler.wake()
  })
  onCleanup(() => { controller.flush(); unregister() })
  return { text, pending }
}
`,
}

export const streamingReplacements = [
  {
    name: "streaming presentation import",
    search: `import { getPluginToolRenderer, hasPluginToolRenderer, pluginToolRendererVersion } from "../../plugin/tool-renderers"
import { DialogRetryAction } from "../../component/dialog-retry-action"`,
    replace: `import { getPluginToolRenderer, hasPluginToolRenderer, pluginToolRendererVersion } from "../../plugin/tool-renderers"
import { createStreamingScheduler, createStreamingText, normalizeStreamingSettings, type StreamingSettings } from "./streaming"
import { DialogRetryAction } from "../../component/dialog-retry-action"`,
  },
  {
    name: "session context streaming surface",
    search: `  diffWrapMode: () => "word" | "none"
  providers: () => ReadonlyMap<string, Provider>`,
    replace: `  diffWrapMode: () => "word" | "none"
  streamingSettings: () => StreamingSettings
  streamingScheduler: ReturnType<typeof createStreamingScheduler>
  providers: () => ReadonlyMap<string, Provider>`,
  },
  {
    name: "reactive streaming preferences",
    search: `  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)`,
    replace: `  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const streamingSettings = createMemo(() => normalizeStreamingSettings(kv.get("alonix_streaming", {}), animationsEnabled()))
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)`,
  },
  {
    name: "shared streaming frame scheduler",
    search: `  const keymap = useOpencodeKeymap()
  const dialog = useDialog()
  const renderer = useRenderer()
`,
    replace: `  const keymap = useOpencodeKeymap()
  const dialog = useDialog()
  const renderer = useRenderer()
  const streamingScheduler = createStreamingScheduler(renderer)
  onCleanup(() => streamingScheduler.dispose())
`,
  },
  {
    name: "streaming context values",
    search: `          diffWrapMode,
          providers,`,
    replace: `          diffWrapMode,
          streamingSettings,
          streamingScheduler,
          providers,`,
  },
  {
    name: "reasoning source",
    search: `  const content = createMemo(() => {
    // OpenRouter encrypts some reasoning blocks; drop the placeholder.
    return props.part.text.replace("[REDACTED]", "").trim()
  })`,
    replace: `  const source = createMemo(() => props.part.text.replace("[REDACTED]", ""))`,
  },
  {
    name: "reasoning visual stream",
    search: `  const isDone = createMemo(() => props.part.time.end !== undefined)
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")`,
    replace: `  const isDone = createMemo(() => props.part.time.end !== undefined)
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")
  const stream = createStreamingText({
    scheduler: ctx.streamingScheduler,
    source,
    animateInitial: true,
    active: () => !isDone() && ctx.streamingSettings().reasoning && (!inMinimal() || expanded()),
    drain: () => isDone() && ctx.streamingSettings().reasoning && (!inMinimal() || expanded()),
    settings: ctx.streamingSettings,
  })
  const content = createMemo(() => stream.text().trim())`,
  },
  {
    name: "reasoning markdown finalization",
    search: `              streaming={true}
              syntaxStyle={syntax()}
              content={summary().body}`,
    replace: `              streaming={!isDone() || stream.pending()}
              syntaxStyle={syntax()}
              content={summary().body}`,
  },
  {
    name: "assistant text visual stream",
    search: `function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  return (
    <Show when={props.part.text.trim()}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3} marginTop={1} flexShrink={0}>
        <markdown
          syntaxStyle={syntax()}
          streaming={true}
          internalBlockMode="top-level"
          content={props.part.text.trim()}
          tableOptions={{ style: "grid" }}
          conceal={ctx.conceal()}
          fg={theme.markdownText}
          bg={theme.background}
        />
      </box>
    </Show>
  )
}`,
    replace: `function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const done = createMemo(() => props.message.time.completed !== undefined)
  const partDone = createMemo(() => props.part.time?.end !== undefined)
  const stream = createStreamingText({
    scheduler: ctx.streamingScheduler,
    source: () => props.part.text,
    animateInitial: true,
    active: () => !partDone() && !done(),
    drain: () => partDone() && !props.message.error,
    settings: ctx.streamingSettings,
  })
  const content = createMemo(() => stream.text())
  const activeTail = createMemo(() => stream.pending() && ctx.streamingSettings().tail === "subtle")
  return (
    <Show when={content().trim()}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3} marginTop={1} flexShrink={0}>
        <markdown
          syntaxStyle={syntax()}
          streaming={!done() || stream.pending()}
          internalBlockMode="top-level"
          content={content()}
          tableOptions={{ style: "grid" }}
          conceal={ctx.conceal()}
          fg={activeTail() ? theme.text : theme.markdownText}
          bg={theme.background}
        />
      </box>
    </Show>
  )
}`,
  },
]
