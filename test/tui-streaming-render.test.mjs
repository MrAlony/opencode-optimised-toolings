import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const hostTuiRoot = resolve(repositoryRoot, "runtime/src/opencode-1.18.15/packages/tui")
const streamingModule = resolve(hostTuiRoot, "src/routes/session/streaming.ts")
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

function runProbe(probe) {
  return new Promise((done) => {
    const bootstrap = `
      import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure";
      import { pathToFileURL } from "node:url";
      ensureRuntimePluginSupport();
      try {
        const loaded = await import(pathToFileURL(${JSON.stringify(probe)}).href + "?streaming-render=" + Date.now());
        console.log(JSON.stringify({ ok: true, result: await loaded.probe() }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error?.stack ?? error?.message ?? String(error) }));
        process.exitCode = 1;
      }
    `
    const child = spawn(bun, ["--conditions=browser", "--eval", bootstrap], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
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

test("generated host streaming paints progressive grapheme prefixes through OpenTUI markdown", async () => {
  assert.equal(existsSync(streamingModule), true, `generated streaming module is missing: ${streamingModule}`)
  const root = mkdtempSync(join(hostTuiRoot, ".alonix-streaming-render-"))
  const probe = join(root, "probe.tsx")
  const source = "Streaming Unicode 👨‍👩‍👧‍👦 e\u0301\n\n```ts\nconst café = true\n```"
  try {
    writeFileSync(probe, `
      import { createSignal, onCleanup } from "solid-js";
      import { SyntaxStyle } from "@opentui/core";
      import { testRender, useRenderer } from "@opentui/solid";
      import { createStreamingScheduler, createStreamingText, DEFAULT_STREAMING_SETTINGS } from ${JSON.stringify(pathToFileURL(streamingModule).href)};

      const authoritative = ${JSON.stringify(source)};
      let controls;

      function App() {
        const renderer = useRenderer();
        const syntax = SyntaxStyle.fromStyles({});
        const scheduler = createStreamingScheduler(renderer);
        const [source, setSource] = createSignal("");
        const [active, setActive] = createSignal(true);
        const [drain, setDrain] = createSignal(false);
        const settings = () => ({ ...DEFAULT_STREAMING_SETTINGS, maxDelayMs: 500 });
        const stream = createStreamingText({ scheduler, source, active, drain, animateInitial: true, settings });
        controls = { setSource, setActive, setDrain, text: stream.text, pending: stream.pending };
        onCleanup(() => { scheduler.dispose(); syntax.destroy(); });
        return <box width="100%" flexShrink={0}>
          <markdown
            syntaxStyle={syntax}
            content={stream.text()}
            streaming={active() || stream.pending()}
            conceal={false}
            fg="#ffffff"
            bg="#000000"
            internalBlockMode="top-level"
          />
        </box>;
      }

      export async function probe() {
        const setup = await testRender(() => <App />, { width: 90, height: 16, targetFps: 30, maxFps: 30 });
        const records = [];
        const capture = () => records.push({ text: controls.text(), frame: setup.captureCharFrame() });
        setup.renderer.on("frame", capture);
        try {
          await setup.renderOnce();
          controls.setSource(authoritative);
          await Promise.resolve();
          await Promise.resolve();
          for (let pass = 0; pass < 20; pass++) {
            await setup.renderOnce();
            const prefixes = new Set(records
              .filter((item) => item.text.length > 0 && item.text.length < authoritative.length && item.frame.includes(item.text.split("\\n")[0]))
              .map((item) => item.text));
            if (prefixes.size >= 3) break;
          }
          controls.setActive(false);
          controls.setDrain(true);
          await Promise.resolve();
          await Promise.resolve();
          for (let pass = 0; pass < 80 && controls.pending(); pass++) await setup.renderOnce();
          await setup.renderOnce();
          capture();
          const progressive = [...new Map(records
            .filter((item) => item.text.length > 0 && item.text.length < authoritative.length && item.frame.includes(item.text.split("\\n")[0]))
            .map((item) => [item.text, item])).values()];
          return {
            authoritative,
            finalText: controls.text(),
            finalFrame: setup.captureCharFrame(),
            painted: {
              code: records.some((item) => item.frame.includes("const café = true")),
              replacement: records.some((item) => item.frame.includes("�")),
            },
            progressive: progressive.slice(0, 12),
          };
        } finally {
          setup.renderer.off("frame", capture);
          setup.renderer.destroy();
        }
      }
    `, "utf8")

    const outcome = await runProbe(probe)
    assert.equal(outcome.code, 0, outcome.stderr || outcome.stdout)
    assert.equal(outcome.value?.ok, true, outcome.value?.error || outcome.stderr || outcome.stdout)
    const result = outcome.value.result
    assert.equal(result.finalText, source)
    assert.ok(result.progressive.length >= 3, JSON.stringify(result.progressive))
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    const boundaries = new Set([0])
    let offset = 0
    for (const item of segmenter.segment(source)) {
      offset += item.segment.length
      boundaries.add(offset)
    }
    for (let index = 0; index < result.progressive.length; index++) {
      const text = result.progressive[index].text
      if (index > 0) assert.ok(text.length > result.progressive[index - 1].text.length)
      assert.ok(source.startsWith(text))
      assert.equal(boundaries.has(text.length), true, `painted prefix split a grapheme at ${text.length}`)
    }
    assert.equal(result.painted.code, true)
    assert.equal(result.painted.replacement, false)
    assert.match(result.finalFrame, /const café = true/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
