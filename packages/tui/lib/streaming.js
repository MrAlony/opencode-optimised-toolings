export const STREAMING_KV_KEY = "alonix_streaming"

export const DEFAULT_STREAMING_SETTINGS = Object.freeze({
  enabled: true,
  style: "adaptive",
  motion: "full",
  maxDelayMs: 180,
  reasoning: false,
  tail: "subtle",
})

const STYLE = new Set(["adaptive", "cinematic", "instant"])
const MOTION = new Set(["full", "reduced"])
const TAIL = new Set(["subtle", "off"])

export function normalizeStreamingSettings(input = {}) {
  const value = input && typeof input === "object" ? input : {}
  const delay = Number(value.maxDelayMs)
  return {
    enabled: value.enabled !== false,
    style: STYLE.has(value.style) ? value.style : DEFAULT_STREAMING_SETTINGS.style,
    motion: MOTION.has(value.motion) ? value.motion : DEFAULT_STREAMING_SETTINGS.motion,
    maxDelayMs: Number.isFinite(delay) ? Math.max(80, Math.min(500, Math.round(delay))) : DEFAULT_STREAMING_SETTINGS.maxDelayMs,
    reasoning: value.reasoning === true,
    tail: TAIL.has(value.tail) ? value.tail : DEFAULT_STREAMING_SETTINGS.tail,
  }
}

export function readStreamingSettings(kv) {
  try {
    return normalizeStreamingSettings(kv?.get?.(STREAMING_KV_KEY, DEFAULT_STREAMING_SETTINGS))
  } catch {
    return { ...DEFAULT_STREAMING_SETTINGS }
  }
}

export function writeStreamingSettings(kv, input) {
  const next = normalizeStreamingSettings(input)
  const previous = readStreamingSettings(kv)
  const changed = JSON.stringify(previous) !== JSON.stringify(next)
  if (changed) kv?.set?.(STREAMING_KV_KEY, next)
  return { value: next, changed }
}

const segmenter = typeof Intl?.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null

export function segmentGraphemes(value) {
  const text = String(value ?? "")
  if (!text) return []
  if (!segmenter) return Array.from(text)
  return Array.from(segmenter.segment(text), (item) => item.segment)
}

function appendSegments(state, source) {
  if (!state.source) return segmentGraphemes(source)
  if (source === state.source) return state.segments
  if (!source.startsWith(state.source)) return segmentGraphemes(source)
  if (!state.segments.length) return segmentGraphemes(source)
  const last = state.segments.at(-1) ?? ""
  const boundary = Math.max(0, state.source.length - last.length)
  return [...state.segments.slice(0, -1), ...segmentGraphemes(source.slice(boundary))]
}

export function createRevealState(source = "") {
  const text = String(source ?? "")
  const segments = segmentGraphemes(text)
  return {
    source: text,
    segments,
    cursor: segments.length,
    initialized: false,
    backlogSince: 0,
    replacement: false,
    pauseUntil: 0,
  }
}

export function visibleText(state) {
  return state.segments.slice(0, state.cursor).join("")
}

export function revealPending(state) {
  return state.cursor < state.segments.length
}

function animationAllowed(active, settings) {
  return active === true && settings.enabled && settings.style !== "instant" && settings.motion !== "reduced"
}

export function updateRevealState(current, source, options = {}) {
  const text = String(source ?? "")
  const settings = normalizeStreamingSettings(options.settings)
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const state = current ?? createRevealState(text)
  const compatible = text.startsWith(state.source)
  const segments = appendSegments(state, text)
  let cursor = Math.min(state.cursor, segments.length)
  let replacement = false

  if (!state.initialized) {
    cursor = options.animateInitial === true && animationAllowed(options.active, settings) ? 0 : segments.length
  } else if (!compatible) {
    // Reverts, retries, server transforms, and cross-process replacements are
    // authoritative. Never animate stale text across an incompatible source.
    cursor = segments.length
    replacement = true
  } else if (!animationAllowed(options.active, settings)) {
    const draining = options.drain === true && state.initialized && compatible && cursor < segments.length
    if (!draining) cursor = segments.length
  }

  const pending = cursor < segments.length
  return {
    source: text,
    segments,
    cursor,
    initialized: true,
    backlogSince: pending ? state.backlogSince || now : 0,
    replacement,
    pauseUntil: compatible ? state.pauseUntil ?? 0 : 0,
  }
}

function codeBurst(state) {
  const tail = state.segments.slice(Math.max(0, state.cursor - 8), Math.min(state.segments.length, state.cursor + 160)).join("")
  const fences = (state.source.slice(0, state.segments.slice(0, state.cursor).join("").length).match(/```/g) ?? []).length
  return fences % 2 === 1 || tail.includes("```") || state.segments.length - state.cursor > 400
}

export function revealBudget(state, options = {}) {
  const settings = normalizeStreamingSettings(options.settings)
  const pending = Math.max(0, state.segments.length - state.cursor)
  if (!pending) return 0
  if (settings.style === "instant" || settings.motion === "reduced" || settings.enabled === false) return pending
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const frameMs = Math.max(8, Math.min(100, Number(options.deltaMs) || 33))
  const age = state.backlogSince ? Math.max(0, now - state.backlogSince) : 0
  if (age >= settings.maxDelayMs) return pending
  const remainingFrames = Math.max(1, Math.floor((settings.maxDelayMs - age) / frameMs))
  const catchUp = Math.ceil(pending / remainingFrames)
  const base = settings.style === "cinematic" ? 1 : 2
  const accelerated = codeBurst(state) ? Math.max(8, catchUp) : catchUp
  return Math.max(1, Math.min(pending, Math.max(base, accelerated)))
}

export function advanceRevealState(current, options = {}) {
  if (!revealPending(current)) return current
  const settings = normalizeStreamingSettings(options.settings)
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  if (current.pauseUntil && now < current.pauseUntil) return current
  const count = revealBudget(current, { ...options, settings })
  const cursor = Math.min(current.segments.length, current.cursor + count)
  const revealed = current.segments.slice(current.cursor, cursor).join("")
  const punctuationPause = settings.style === "cinematic" && /[.!?…][\s\n]*$/.test(revealed) && cursor < current.segments.length
    ? Math.min(90, Math.max(24, Math.round(settings.maxDelayMs / 5)))
    : 0
  return {
    ...current,
    cursor,
    pauseUntil: punctuationPause ? now + punctuationPause : 0,
    backlogSince: cursor < current.segments.length ? current.backlogSince : 0,
  }
}

export function createStreamingScheduler(renderer, options = {}) {
  const controllers = new Set()
  let live = false
  let disposed = false
  let watchdog = null
  const watchdogMs = Number.isFinite(Number(options.watchdogMs)) ? Math.max(10, Number(options.watchdogMs)) : null

  const drop = () => {
    if (!live) return
    live = false
    try { renderer?.dropLive?.() } catch {}
  }

  const flushAll = () => {
    for (const controller of controllers) {
      try { controller.flush() } catch {}
    }
    drop()
  }

  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog)
    if (![...controllers].some((item) => item.pending())) return
    const deadlines = [...controllers].filter((item) => item.pending()).map((item) => Number(item.deadline?.())).filter(Number.isFinite)
    const delay = watchdogMs ?? Math.min(600, Math.max(160, (deadlines.length ? Math.min(...deadlines) : 180) + 80))
    watchdog = setTimeout(() => {
      watchdog = null
      flushAll()
    }, delay)
  }

  const wake = () => {
    if (disposed) return
    const pending = [...controllers].some((item) => item.pending())
    if (pending && !live) {
      try {
        renderer?.requestLive?.()
        live = true
      } catch {
        flushAll()
        return
      }
    }
    if (!pending) drop()
    armWatchdog()
  }

  const frame = async (deltaTime) => {
    if (disposed) return
    try {
      for (const controller of controllers) controller.step(deltaTime)
      wake()
    } catch {
      // Presentation failure must never hide authoritative content or write it
      // to logs. Flush every active tail and return to normal rendering.
      flushAll()
    }
  }

  try { renderer?.setFrameCallback?.(frame) } catch {}

  return {
    register(controller) {
      if (disposed) {
        controller.flush()
        return () => {}
      }
      controllers.add(controller)
      wake()
      return () => {
        controllers.delete(controller)
        wake()
      }
    },
    wake,
    flushAll,
    activeCount() {
      return [...controllers].filter((item) => item.pending()).length
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (watchdog) clearTimeout(watchdog)
      watchdog = null
      flushAll()
      controllers.clear()
      try { renderer?.removeFrameCallback?.(frame) } catch {}
    },
  }
}

export function createStreamingController(scheduler, onChange, options = {}) {
  let state = createRevealState(options.initial ?? "")
  let settings = normalizeStreamingSettings(options.settings)
  const now = typeof options.now === "function" ? options.now : Date.now
  let disposed = false
  const notify = () => onChange?.(visibleText(state), revealPending(state), state)
  const controller = {
    pending: () => !disposed && revealPending(state),
    deadline: () => settings.maxDelayMs,
    update(source, updateOptions = {}) {
      if (disposed) return
      settings = normalizeStreamingSettings(updateOptions.settings ?? settings)
      state = updateRevealState(state, source, {
        ...updateOptions,
        animateInitial: updateOptions.animateInitial ?? options.animateInitial,
        now: Number.isFinite(updateOptions.now) ? updateOptions.now : now(),
        settings,
      })
      notify()
      scheduler?.wake?.()
    },
    step(deltaTime) {
      if (disposed || !revealPending(state)) return
      state = advanceRevealState(state, { settings, deltaMs: deltaTime, now: now() })
      notify()
    },
    flush() {
      if (disposed && !revealPending(state)) return
      if (revealPending(state)) state = { ...state, cursor: state.segments.length, backlogSince: 0 }
      notify()
    },
    snapshot: () => ({ ...state, segments: [...state.segments] }),
    dispose() {
      if (disposed) return
      controller.flush()
      disposed = true
      unregister()
    },
  }
  const unregister = scheduler?.register?.(controller) ?? (() => {})
  notify()
  return controller
}
