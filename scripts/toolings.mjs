#!/usr/bin/env node
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { deploymentStatus, deploymentSummary, developmentDeployment, discoverConfiguredDeployment, readDeployment, reconcileDeployment } from "../packages/shared/deployment.js"
import { runSelfPatch } from "../packages/selfpatch/lib/pipeline.js"

const checkout = resolve(fileURLToPath(new URL("..", import.meta.url)))
const [command = "status", ...args] = process.argv.slice(2)
const json = args.includes("--json")
const sourceArg = args.find((value) => value.startsWith("--source="))?.slice("--source=".length) ?? "desired"

try {
  if (command === "status" || command === "doctor") {
    const status = await deploymentStatus()
    console.log(json ? JSON.stringify(status, null, 2) : deploymentSummary(status))
    if (command === "doctor" && !status.ok) process.exitCode = 1
  } else if (command === "reconcile") {
    const record = await readDeployment()
    const discovered = sourceArg === "checkout" || record?.desired?.root ? null : await discoverConfiguredDeployment()
    if (sourceArg !== "checkout" && !record?.desired?.root && !discovered?.valid) {
      throw new Error(`No canonical deployment exists and the configured runtime cannot be adopted safely (${discovered?.reason ?? "unknown"}). Use --source=checkout only for direct-local development.`)
    }
    const root = sourceArg === "checkout" ? checkout : resolve(record?.desired?.root ?? discovered.root)
    const result = sourceArg === "checkout"
      ? await developmentDeployment(root, { reconcileHost: runSelfPatch })
      : await reconcileDeployment(root, { generation: discovered?.validation, reconcileHost: runSelfPatch })
    console.log(json ? JSON.stringify(result, null, 2) : deploymentSummary(result.status))
    if (!result.status.ok) process.exitCode = 1
  } else {
    throw new Error(`Unknown command ${command}. Use: toolings status|doctor|reconcile [--source=checkout|desired] [--json]`)
  }
} catch (error) {
  console.error(`TOOLINGS ${command.toUpperCase()} FAILED: ${error?.message ?? error}`)
  process.exitCode = 1
}
