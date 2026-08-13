import path from "node:path"
import { isDevelopmentCheckout } from "../../shared/paths.js"
import { developmentTuiSpec } from "../../bootstrap/index.js"
import { developmentDeployment, readDeployment, reconcileDeployment } from "../../shared/deployment.js"
import { publicPackageSpecs } from "../../shared/generation.js"

export function openCodeConfigDirectory(env = process.env) {
  return env.OPENCODE_CONFIG_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", ".config", "opencode")
}

export function tuiCompanionSpec(root) {
  return developmentTuiSpec(root)
}

export async function ensureTuiCompanion(root, options = {}) {
  const common = { env: options.env, configDir: options.configDirectory }
  const record = isDevelopmentCheckout(root) ? null : await readDeployment(common)
  const configSpecs = record?.desired?.root && path.resolve(record.desired.root) === path.resolve(root)
    ? {
        server: record.desired.serverSpec,
        tui: Object.hasOwn(record.desired, "tuiConfigSpec") ? record.desired.tuiConfigSpec : record.desired.tuiSpec,
        pointer: record.desired.tuiSpec,
        desiredTui: record.desired.tuiSpec,
      }
    : publicPackageSpecs()
  const result = isDevelopmentCheckout(root)
    ? await developmentDeployment(root, common)
    : await reconcileDeployment(root, { ...common, configSpecs })
  return {
    changed: result.activation.changed,
    configPath: result.activation.files.find((file) => /tui\.json$/i.test(file)) ?? path.join(options.configDirectory ?? openCodeConfigDirectory(options.env), "tui.json"),
    spec: result.status.desired.tuiSpec,
    generation: result.generation.root,
    restartRequired: result.activation.changed,
    replaced: null,
    deployment: result.status,
  }
}
