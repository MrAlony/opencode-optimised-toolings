#!/usr/bin/env node
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { developmentDeployment } from "../packages/shared/deployment.js"
import { runSelfPatch } from "../packages/selfpatch/lib/pipeline.js"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
try {
  const result = await developmentDeployment(root, { reconcileHost: runSelfPatch })
  if (!result.status.ok) throw new Error(`deployment remains inconsistent: ${JSON.stringify(result.status.checks)}`)
  console.log(`INSTALL SUCCESS: direct checkout reconciled through ${result.status.files.deployment}. Fully quit and restart OpenCode.`)
} catch (error) {
  console.error(`INSTALL FAILED: ${error?.message ?? error}`)
  process.exitCode = 1
}
