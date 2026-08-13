import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { readDeployment, reconcileDeployment } from "../shared/deployment.js"
import { validateGeneration } from "../shared/generation.js"
import { packageRootFrom, packageVersion } from "../shared/paths.js"

async function internalTuiRoot(transportRoot) {
  const version = packageVersion(transportRoot)
  const record = await readDeployment()
  const desired = record?.desired
  if (desired?.version === version && desired?.root) {
    const validation = await validateGeneration(desired.root, version)
    if (validation.valid) return validation.root
  }
  const reconciled = await reconcileDeployment(transportRoot, { publicPackage: true })
  return reconciled.generation.root
}

const plugin = {
  id: "sparkly-alonix-toolings-bootstrap",
  async tui(api, options) {
    const transportRoot = packageRootFrom(import.meta.url)
    const root = await internalTuiRoot(transportRoot)
    const loaded = await import(`${pathToFileURL(join(root, "packages", "tui", "index.tsx")).href}?generation=${encodeURIComponent(root)}`)
    const target = loaded.default
    if (!target || typeof target.tui !== "function") throw new Error("Provisioned Alonix generation has no TUI plugin factory")
    return target.tui(api, options)
  },
}

export default plugin
