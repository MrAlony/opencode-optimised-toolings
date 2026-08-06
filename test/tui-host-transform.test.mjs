import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const bunCandidates = process.platform === "win32"
  ? [
      join(repositoryRoot, "node_modules", "@oven", "bun-windows-x64", "bin", "bun.exe"),
      join(repositoryRoot, "node_modules", "@oven", "bun-windows-x64-baseline", "bin", "bun.exe"),
      join(repositoryRoot, "node_modules", "bun", "bin", "bun.exe"),
    ]
  : [join(repositoryRoot, "node_modules", "bun", "bin", "bun")]
const bun = bunCandidates.find((file) => {
  try { return existsSync(file) && (process.platform !== "win32" || statSync(file).size > 1_000_000) } catch { return false }
}) ?? bunCandidates.at(-1)

function runProbe(files) {
  const script = `
    import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure";
    import { pathToFileURL } from "node:url";
    ensureRuntimePluginSupport();
    const results=[];
    for (const file of ${JSON.stringify(files)}) {
      try {
        const loaded=await import(pathToFileURL(file).href+"?host-transform="+Date.now());
        results.push({file,ok:true,result:loaded.probe()});
      } catch (error) {
        results.push({file,ok:false,error:error?.message??String(error)});
      }
    }
    console.log(JSON.stringify(results));
  `
  return new Promise((done) => {
    const child = spawn(bun, ["--eval", script], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("close", (code) => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
      let value = null
      try { value = JSON.parse(line ?? "null") } catch {}
      done({ code, value, stdout, stderr })
    })
  })
}

test("OpenCode host transform executes generated TUI source only when the package source is outside node_modules", async () => {
  const root = mkdtempSync(join(tmpdir(), "alonix-host-transform-"))
  try {
    const source = `
      import { createSignal } from "solid-js";
      export function probe() {
        const [value, setValue] = createSignal(1);
        setValue(2);
        const view = <text>{value()}</text>;
        return { value: value(), viewType: typeof view };
      }
    `
    const transformed = join(root, "generation", "opencode-optimised-toolings", "probe.tsx")
    const excluded = join(root, "generation", "node_modules", "opencode-optimised-toolings", "probe.tsx")
    mkdirSync(dirname(transformed), { recursive: true })
    mkdirSync(dirname(excluded), { recursive: true })
    writeFileSync(transformed, source, "utf8")
    writeFileSync(excluded, source, "utf8")

    const outcome = await runProbe([transformed, excluded])
    assert.equal(outcome.code, 0, outcome.stderr || outcome.stdout)
    // The transformed module reaches OpenTUI's JSX runtime. This isolated probe
    // intentionally has no renderer, so execution stops at that host boundary.
    assert.equal(outcome.value?.[0]?.ok, false, JSON.stringify(outcome.value))
    assert.match(outcome.value?.[0]?.error ?? "", /No renderer found/i)
    // The same source under node_modules is excluded by OpenTUI's Solid source
    // filter and falls through to Bun's default React JSX transform instead.
    assert.equal(outcome.value?.[1]?.ok, false, "node_modules source unexpectedly received the host Solid JSX transform")
    assert.match(outcome.value?.[1]?.error ?? "", /react\/jsx|React|jsx-dev-runtime/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
