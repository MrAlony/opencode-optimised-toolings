import test from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  bunCacheEntries,
  entryTargets,
  looksLikeBrokenInstall,
  packageRootFromFile,
  packagesFromBuildLog,
  parseUnresolvedImports,
  verifyPackage,
  verifyPackages,
} from "../lib/integrity.js"

// The exact failure the user hit: a truncated zod install.
const WORKSPACE_INSTALL_LOG = `
error: Could not resolve: "solid-js". Maybe you need to "bun install"?
    at C:\\work\\packages\\tui\\src\\app.tsx:22:123
error: Could not resolve: "@opentui/core". Maybe you need to "bun install"?
    at C:\\work\\packages\\tui\\src\\renderer.ts:4:20
error: Could not resolve: "effect". Maybe you need to "bun install"?
    at C:\\work\\packages\\opencode\\src\\index.ts:8:12
`

const ZOD_LOG = `Loaded models.dev snapshot
building opencode-windows-x64
2 | export * from "./helpers/parseUtil.js";
                  ^
error: Could not resolve: "./helpers/parseUtil.js"
    at C:\\work\\runtime\\src\\opencode-1.18.13\\node_modules\\.bun\\zod@3.25.76\\node_modules\\zod\\v3\\external.js:2:15

5 | export * from "./types.js";
                  ^
error: Could not resolve: "./types.js"
    at C:\\work\\runtime\\src\\opencode-1.18.13\\node_modules\\.bun\\zod@3.25.76\\node_modules\\zod\\v3\\external.js:5:15
`

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "alonix-integrity-"))
}

test("unresolved imports are extracted with their importing file", () => {
  const failures = parseUnresolvedImports(ZOD_LOG)
  assert.equal(failures.length, 2)
  assert.equal(failures[0].specifier, "./helpers/parseUtil.js")
  assert.match(failures[0].file, /zod[\\/]v3[\\/]external\.js$/, "line/column must be stripped")
  assert.equal(failures[1].specifier, "./types.js")
})

test("a clean log yields no failures", () => {
  assert.deepEqual(parseUnresolvedImports("building opencode\ndone"), [])
  assert.deepEqual(parseUnresolvedImports(""), [])
  assert.deepEqual(parseUnresolvedImports(undefined), [])
  assert.equal(looksLikeBrokenInstall("error: Expected ';' at line 4"), false)
})

test("an interrupted workspace install is classified without blaming source files as packages", () => {
  assert.equal(packagesFromBuildLog(WORKSPACE_INSTALL_LOG).length, 0)
  assert.equal(looksLikeBrokenInstall(WORKSPACE_INSTALL_LOG), true)
  assert.equal(looksLikeBrokenInstall('error: Could not resolve: "solid-js"'), false)
})

test("the owning package is resolved from a nested install path", () => {
  const owner = packageRootFromFile(
    "C:/work/node_modules/.bun/zod@3.25.76/node_modules/zod/v3/external.js",
  )
  assert.equal(owner.name, "zod")
  assert.ok(owner.dir.endsWith("node_modules/zod"), owner.dir)
  // The deepest node_modules wins, not the outer one.
  assert.ok(owner.dir.includes(".bun/zod@3.25.76"))
})

test("scoped packages consume both path segments", () => {
  const owner = packageRootFromFile("/app/node_modules/@scope/pkg/dist/index.js")
  assert.equal(owner.name, "@scope/pkg")
  assert.ok(owner.dir.endsWith("node_modules/@scope/pkg"))
})

test("paths without node_modules resolve to nothing", () => {
  assert.equal(packageRootFromFile("/app/src/index.js"), null)
  assert.equal(packageRootFromFile(""), null)
  assert.equal(packageRootFromFile(undefined), null)
})

test("the build log is reduced to one entry per broken package", () => {
  const packages = packagesFromBuildLog(ZOD_LOG)
  assert.equal(packages.length, 1, "two failures in one package must not produce two entries")
  assert.equal(packages[0].name, "zod")
  assert.deepEqual(packages[0].missing, ["./helpers/parseUtil.js", "./types.js"])
  assert.equal(looksLikeBrokenInstall(ZOD_LOG), true)
})

test("entry targets cover main, module, and nested exports", () => {
  const targets = entryTargets({
    main: "./index.cjs",
    module: "./index.js",
    types: "./index.d.ts",
    exports: {
      ".": { types: "./index.d.cts", import: "./index.js", require: "./index.cjs" },
      "./v3": { import: "./v3/index.js", require: "./v3/index.cjs" },
      "./v4/locales/*": { import: "./v4/locales/*" },
      "./package.json": "./package.json",
    },
  })
  assert.ok(targets.includes("./index.js"))
  assert.ok(targets.includes("./v3/index.js"))
  assert.ok(targets.includes("./v3/index.cjs"))
  assert.ok(!targets.some((t) => t.includes("*")), "wildcards are not checkable")
  assert.ok(!targets.includes("./index.d.ts"), "type declarations do not break a build")
  assert.ok(!targets.includes("./package.json"))
})

test("entry targets tolerate an absent or malformed manifest", () => {
  assert.deepEqual(entryTargets(null), [])
  assert.deepEqual(entryTargets({}), [])
  assert.deepEqual(entryTargets({ exports: null }), [])
  assert.doesNotThrow(() => entryTargets({ exports: { ".": { import: 5 } } }))
})

test("a complete package verifies and a truncated one does not", async () => {
  const dir = await tempDir()
  try {
    const pkg = path.join(dir, "zod")
    await fs.mkdir(path.join(pkg, "v3"), { recursive: true })
    await fs.writeFile(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "zod", main: "./index.js", exports: { "./v3": { import: "./v3/index.js" } } }),
    )
    await fs.writeFile(path.join(pkg, "index.js"), "")

    // v3/index.js is still missing: exactly the reported corruption.
    const broken = await verifyPackage(pkg)
    assert.equal(broken.ok, false)
    assert.deepEqual(broken.missing, ["./v3/index.js"])

    await fs.writeFile(path.join(pkg, "v3", "index.js"), "")
    const fixed = await verifyPackage(pkg)
    assert.equal(fixed.ok, true)
    assert.equal(fixed.name, "zod")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a package with no package.json is reported as broken, not crashed", async () => {
  const dir = await tempDir()
  try {
    const result = await verifyPackage(path.join(dir, "ghost"))
    assert.equal(result.ok, false)
    assert.match(result.reason, /package\.json/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("verifyPackages aggregates only the broken ones", async () => {
  const dir = await tempDir()
  try {
    const good = path.join(dir, "good")
    await fs.mkdir(good, { recursive: true })
    await fs.writeFile(path.join(good, "package.json"), JSON.stringify({ name: "good", main: "./i.js" }))
    await fs.writeFile(path.join(good, "i.js"), "")

    const bad = path.join(dir, "bad")
    await fs.mkdir(bad, { recursive: true })
    await fs.writeFile(path.join(bad, "package.json"), JSON.stringify({ name: "bad", main: "./missing.js" }))

    assert.equal((await verifyPackages([good])).ok, true)
    const result = await verifyPackages([good, bad])
    assert.equal(result.ok, false)
    assert.equal(result.broken.length, 1)
    assert.equal(result.broken[0].name, "bad")

    assert.equal((await verifyPackages([])).ok, true)
    assert.equal((await verifyPackages(null)).ok, true)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("bun cache entries match both plain and versioned directories", async () => {
  const dir = await tempDir()
  try {
    for (const name of ["zod", "zod@3.25.76@@@1", "zod-to-ts", "unrelated"]) {
      await fs.mkdir(path.join(dir, name), { recursive: true })
    }
    const entries = (await bunCacheEntries(dir, "zod")).map((entry) => path.basename(entry)).sort()
    assert.deepEqual(entries, ["zod", "zod@3.25.76@@@1"], "zod-to-ts must not be swept up")

    await fs.mkdir(path.join(dir, "@scope", "pkg@1.0.0@@@1"), { recursive: true })
    const scoped = await bunCacheEntries(dir, "@scope/pkg")
    assert.equal(scoped.length, 1)

    assert.deepEqual(await bunCacheEntries(dir, "absent"), [])
    assert.deepEqual(await bunCacheEntries(path.join(dir, "nope"), "zod"), [])
    assert.deepEqual(await bunCacheEntries(null, "zod"), [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
