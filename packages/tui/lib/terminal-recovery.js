// Windows Terminal / ConPTY can silently drop DEC private modes while a
// terminal window or tab changes focus. OpenTUI 0.4.x restores them only when
// it observed the matching blur first, but Windows does not always deliver that
// sequence. Replaying the renderer's tracked active modes on every focus-in is
// idempotent and matches the upstream OpenTUI correction.

const FOCUS_IN = "\x1b[I"

export function restoreTerminalModes(renderer) {
  if (!renderer || renderer.isDestroyed) return false
  try {
    const lib = renderer.lib
    if (typeof lib?.restoreTerminalModes !== "function" || !renderer.rendererPtr) return false
    lib.restoreTerminalModes(renderer.rendererPtr)
    renderer.requestRender?.()
    return true
  } catch {
    return false
  }
}

/**
 * Install before OpenTUI's own focus parser. Returning false preserves native
 * focus dispatch, key handling, and plugin listeners; this hook only repairs
 * terminal protocol state.
 */
export function installTerminalModeRecovery(renderer) {
  if (!renderer || typeof renderer.prependInputHandler !== "function") return () => {}
  const handler = (sequence) => {
    if (sequence === FOCUS_IN) restoreTerminalModes(renderer)
    return false
  }
  renderer.prependInputHandler(handler)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try { renderer.removeInputHandler?.(handler) } catch {}
  }
}

export const terminalRecoveryProtocol = Object.freeze({ focusIn: FOCUS_IN })
