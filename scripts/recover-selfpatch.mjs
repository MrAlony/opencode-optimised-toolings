#!/usr/bin/env node
// Recovery for a stuck/failed self-patch: reset the pipeline state and install
// an already-built patched binary over the official one in place. No process
// is ever stopped, killed, or restarted — running OpenCode instances keep
// their mapped image, and the patched binary activates on the next launch.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { patchedBinaryPath } from "../packages/selfpatch/lib/state.js"
import { detectBinary } from "../packages/selfpatch/lib/detect.js"
import { installPatchedBinary } from "../packages/selfpatch/lib/restart.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtime = path.join(root, "runtime")
const lock = path.join(runtime, "pipeline.lock")
const stateFile = path.join(runtime, "selfpatch-state.json")

console.log("Resetting self-patch state...")
rmSync(lock, { force: true })
mkdirSync(runtime, { recursive: true })
writeFileSync(
  stateFile,
  JSON.stringify(
    {
      status: "idle",
      stepLabel: "Waiting for the self-patch controller",
      progressPercent: 0,
      lastError: null,
      logTail: "",
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  ) + "\n",
  "utf8"
)

const bin = detectBinary()
if (bin && !bin.devMode && bin.path) {
  const patched = patchedBinaryPath(root, bin.version)
  if (existsSync(patched)) {
    const result = await installPatchedBinary({ officialPath: bin.path, patchedPath: patched })
    if (result.alreadyPatched) {
      console.log(`Official binary v${bin.version} is already the patched build; nothing to do.`)
    } else {
      console.log(`Installed the patched binary v${bin.version} over ${bin.path} (original kept at .toolings-backup).`)
    }
    writeFileSync(
      stateFile,
      JSON.stringify(
        {
          status: "built",
          progressPercent: 100,
          stepLabel: "Patched binary installed — restart OpenCode to activate",
          version: bin.version,
          binaryPath: bin.path,
          patchedSha256: result.patchedSha,
          renderersActive: false,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n",
      "utf8"
    )
  } else {
    console.log("No patched binary available yet; the next OpenCode launch will build and install it automatically.")
  }
} else {
  console.log("Running under a dev runtime or no OpenCode binary detected; nothing to install.")
}

console.log("Recovery complete. Restart OpenCode at your convenience to activate the patched binary.")
