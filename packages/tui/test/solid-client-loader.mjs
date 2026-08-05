// Node resolves `solid-js` and `solid-js/store` to their SSR builds, where
// signals and stores never update. That would make reactive assertions silently
// vacuous, so runtime tests load through this resolver to get the real client
// builds — and one shared instance across the whole module graph.

import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

const CLIENT_BUILDS = new Map([
  ["solid-js", path.join(repoRoot, "node_modules", "solid-js", "dist", "solid.js")],
  ["solid-js/store", path.join(repoRoot, "node_modules", "solid-js", "store", "dist", "store.js")],
])

export async function resolve(specifier, context, next) {
  const target = CLIENT_BUILDS.get(specifier)
  if (target) return { url: pathToFileURL(target).href, shortCircuit: true }
  return next(specifier, context)
}
