import test from "node:test"
import assert from "node:assert/strict"

import { installTerminalModeRecovery, restoreTerminalModes, terminalRecoveryProtocol } from "../lib/terminal-recovery.js"

function rendererFixture() {
  const calls = []
  const renderer = {
    rendererPtr: { id: 1 },
    isDestroyed: false,
    lib: {
      restoreTerminalModes(pointer) { calls.push(["restore", pointer]) },
    },
    requestRender() { calls.push(["render"]) },
    prependInputHandler(handler) { calls.push(["prepend", handler]); this.handler = handler },
    removeInputHandler(handler) { calls.push(["remove", handler]); if (this.handler === handler) this.handler = null },
  }
  return { renderer, calls }
}

test("every focus-in restores tracked terminal modes even without a prior blur", () => {
  const fx = rendererFixture()
  const dispose = installTerminalModeRecovery(fx.renderer)
  const handler = fx.renderer.handler

  assert.equal(handler(terminalRecoveryProtocol.focusIn), false)
  assert.equal(handler(terminalRecoveryProtocol.focusIn), false)
  assert.equal(fx.calls.filter(([name]) => name === "restore").length, 2)
  assert.equal(fx.calls.filter(([name]) => name === "render").length, 2)

  dispose()
  assert.equal(fx.renderer.handler, null)
  assert.equal(fx.calls.filter(([name]) => name === "remove").length, 1)
})

test("the recovery hook never consumes focus, keyboard, paste, or mouse input", () => {
  const fx = rendererFixture()
  installTerminalModeRecovery(fx.renderer)

  for (const input of ["\x1b[O", "a", "\x1b[200~paste\x1b[201~", "\x1b[<0;1;1M"]) {
    assert.equal(fx.renderer.handler(input), false)
  }
  assert.equal(fx.calls.some(([name]) => name === "restore"), false)
})

test("missing native support and destroyed renderers degrade safely", () => {
  assert.equal(restoreTerminalModes(null), false)
  assert.equal(restoreTerminalModes({ isDestroyed: true }), false)
  assert.equal(restoreTerminalModes({ rendererPtr: {}, lib: {} }), false)
  assert.doesNotThrow(() => installTerminalModeRecovery(null)())
})

test("disposal is idempotent", () => {
  const fx = rendererFixture()
  const dispose = installTerminalModeRecovery(fx.renderer)
  dispose()
  dispose()
  assert.equal(fx.calls.filter(([name]) => name === "remove").length, 1)
})
