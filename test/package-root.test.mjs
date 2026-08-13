import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { candidatePackageSpecs, generationSpecs, validateGeneration } from "../packages/shared/generation.js"
import { isDevelopmentCheckout } from "../packages/shared/paths.js"

test("package root discovery skips nested workspace package manifests", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-package-root-"))
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "opencode-optimised-toolings", version: "4.0.2" }))
    const nested = join(root, "packages", "tui")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@sparkly/toolings-tui", version: "2.0.0" }))
    const entry = join(nested, "index.tsx")
    writeFileSync(entry, "export default {}\n")
    const { packageRootFrom } = await import("../packages/shared/paths.js")
    assert.equal(packageRootFrom(pathToFileURL(entry).href), resolve(root))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("generation specs point both direct entries into one transformable package root", () => {
  const root = resolve("C:/runtime/generations/v4.0.2--1234567890abcdef/opencode-optimised-toolings")
  const specs = generationSpecs(root)
  assert.match(specs.server, /opencode-optimised-toolings\/index\.js$/)
  assert.match(specs.tui, /opencode-optimised-toolings\/packages\/tui\/index\.tsx$/)
  assert.equal(specs.server.includes("tui-loader"), false)
  assert.equal(specs.tui.includes("/node_modules/"), false)
})

test("candidate specs expose one package root and keep the TUI declaration internal", () => {
  const root = resolve("C:/runtime/generations/v4.0.2--1234567890abcdef/opencode-optimised-toolings")
  const specs = candidatePackageSpecs(root)
  assert.match(specs.server, /opencode-optimised-toolings$/)
  assert.equal(specs.tui, null)
  assert.equal(specs.pointer, specs.server)
  assert.equal(specs.desiredTui, specs.server)
})

test("a marked transformable generation is installed rather than a development checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-generation-mode-"))
  try {
    const generation = join(root, "v4.0.2--1234567890abcdef")
    const packageRoot = join(generation, "opencode-optimised-toolings")
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(generation, ".alonix-generation.json"), JSON.stringify({ version: "4.0.2" }))
    assert.equal(isDevelopmentCheckout(packageRoot), false)
    assert.equal(isDevelopmentCheckout(join(root, "checkout")), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("generation validation fails closed for incomplete packages", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-generation-invalid-"))
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "opencode-optimised-toolings", version: "4.0.2" }))
    const result = await validateGeneration(root, "4.0.2")
    assert.equal(result.valid, false)
    assert.match(result.reason, /^missing-/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
