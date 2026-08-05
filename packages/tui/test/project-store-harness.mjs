// Loads the cross-project store for reactivity tests.
//
// `components/project-store.jsx` carries the JSX pragma for consistency with the
// other components but contains no JSX, so only its relative `../lib/*.js`
// imports need absolute URLs before evaluation from a data URL. Solid resolves
// to its real client build via `solid-client-loader.mjs`, which the test file
// registers before importing this harness.

import { readFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = await readFile(path.join(packageRoot, "components", "project-store.jsx"), "utf8")

const rewritten = source.replace(
  /from "\.\.\/lib\/([a-z-]+)\.js"/g,
  (_match, name) => `from "${pathToFileURL(path.join(packageRoot, "lib", `${name}.js`)).href}"`,
)

if (/<[A-Za-z][\s\S]*?\/?>/.test(rewritten.replace(/^\s*\/\/.*$/gm, ""))) {
  throw new Error("project-store harness: unexpected JSX found; update the harness")
}

export const { createProjectStore } = await import(
  `data:text/javascript;base64,${Buffer.from(rewritten, "utf8").toString("base64")}`
)
