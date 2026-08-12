import path from "node:path"
import { isDevelopmentCheckout } from "../../shared/paths.js"
import { developmentTuiSpec } from "../../bootstrap/index.js"
import { developmentDeployment, reconcileDeployment } from "../../shared/deployment.js"

export function openCodeConfigDirectory(env = process.env) {
  return env.OPENCODE_CONFIG_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", ".config", "opencode")
}

export function tuiCompanionSpec(root) {
  return developmentTuiSpec(root)
}

export async function ensureTuiCompanion(root, options = {}) {
  const common = { env: options.env, configDir: options.configDirectory }
  const result = isDevelopmentCheckout(root)
    ? await developmentDeployment(root, common)
    : await reconcileDeployment(root, common)
  return {
    changed: result.activation.changed,
    configPath: result.activation.files.find((file) => /tui\.json$/i.test(file)) ?? path.join(options.configDirectory ?? openCodeConfigDirectory(options.env), "tui.json"),
    spec: result.generation.specs.tui,
    generation: result.generation.root,
    restartRequired: result.activation.changed,
    replaced: null,
    deployment: result.status,
  }
}
