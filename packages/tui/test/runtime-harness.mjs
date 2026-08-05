// Loads the IDE runtime module for reactivity tests.
//
// `components/runtime.jsx` contains JSX that Node cannot parse, so the single
// JSX component (`ClockProvider`) is replaced with its plain-JavaScript
// equivalent and the module is evaluated from a data URL. Solid itself is
// resolved to its real client build by `solid-client-loader.mjs`, which the
// test file registers before importing this harness.

import { readFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = await readFile(path.join(packageRoot, "components", "runtime.jsx"), "utf8")

const rewritten = source
  .replace(/from "\.\.\/lib\/([a-z-]+)\.js"/g, (_match, name) =>
    `from "${pathToFileURL(path.join(packageRoot, "lib", `${name}.js`)).href}"`,
  )
  // ClockProvider is the only JSX in this module and is never rendered by the
  // runtime tests; the replacement preserves its pass-through behaviour.
  .replace(
    /export function ClockProvider\(props\) \{[\s\S]*?\n\}/,
    "export function ClockProvider(props) {\n  return props.children\n}",
  )

if (/<[A-Za-z]/.test(rewritten)) {
  throw new Error("runtime harness: unexpected JSX remains after rewriting; update the harness")
}

export const {
  activeSessionID,
  createClock,
  createSessionStore,
  createSkin,
  openSession,
  useClock,
} = await import(`data:text/javascript;base64,${Buffer.from(rewritten, "utf8").toString("base64")}`)
