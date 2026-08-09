import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const root = new URL("..", import.meta.url)
async function source(path) { return readFile(new URL(path, root), "utf8") }

test("activity rows preserve Solid reactivity and remount details on every expansion", async () => {
  const kit = await source("components/kit.jsx")
  assert.match(kit, /export function Activity\(props\)/)
  assert.doesNotMatch(kit, /function Activity\(\{[^)]*status/)
  assert.match(kit, /typeof props\.details === "function"/)
  assert.match(kit, /open\(\).*props\.details\(\)/s)
  const activityBody = kit.slice(kit.indexOf("export function Activity"), kit.indexOf("export function ItemRow"))
  assert.doesNotMatch(activityBody, /props\.children/)
  assert.match(kit, /focusable=\{expandable\(\)\}/)
  assert.match(kit, /stopPropagation/)
  assert.match(kit, /marginTop=\{props\.compact \? 0 : 1\}/)
  assert.match(kit, /paddingTop=\{1\}/)
  assert.match(kit, /paddingBottom=\{1\}/)
  assert.match(kit, /backgroundColor=\{statusSurface\(props\.status, props\.skin, active\(\)\)\}/)
})

test("failed tool calls remain collapsed until the user explicitly opens them", async () => {
  const kit = await source("components/kit.jsx")
  const activity = kit.slice(kit.indexOf("export function Activity"), kit.indexOf("export function ItemRow"))
  assert.match(activity, /createSignal\(Boolean\(props\.openDefault\)\)/, "explicit defaults remain supported")
  assert.match(activity, /setOpen\(\(value\) => !value\)/, "pointer and keyboard toggles remain supported")
  assert.doesNotMatch(activity, /props\.status === "FAILED"[\s\S]*setOpen\(true\)/, "an execution failure must never expand its own details")
  assert.doesNotMatch(activity, /failureOpened/, "failure-triggered expansion state must not exist")
})

test("structured result status wins over stale running lifecycle while execution errors remain authoritative", async () => {
  const kit = await source("components/kit.jsx")
  assert.match(kit, /lifecycle\.phase === "error".*return "FAILED"/s)
  assert.match(kit, /if \(resultStatus\) return resultStatus/)
  assert.match(kit, /export function statusPending/)
  assert.match(kit, /<b>\{props\.label\}<\/b><span.*> · <\/span>\{props\.summary\}/s)
})

test("all tool families have dedicated inspectors and compact item previews", async () => {
  const index = await source("index.tsx")
  for (const view of ["ReadView", "EditView", "ShellView", "BackgroundView", "DiscoveryView", "WebView", "StealthView", "CbmView"]) assert.match(index, new RegExp(view))
  for (const file of ["read.jsx", "edit.jsx", "shell.jsx", "background.jsx", "discovery.jsx", "web.jsx", "stealth.jsx", "cbm.jsx"]) {
    const body = await source(`components/${file}`)
    assert.match(body, /<Activity/)
    assert.match(body, /preview=/)
    assert.ok(body.includes("details={() =>") || body.includes("details={details}"), `missing details factory in ${file}`)
    assert.doesNotMatch(body, /<box\s+border/)
  }
})

test("expanded inspectors lead with understandable outcomes before technical provenance", async () => {
  const kit = await source("components/kit.jsx")
  assert.match(kit, /export function OutcomeOverview/)
  assert.match(kit, /What this means/)
  for (const file of ["read.jsx", "edit.jsx", "shell.jsx", "background.jsx", "discovery.jsx", "web.jsx", "stealth.jsx", "cbm.jsx", "report.jsx"]) {
    const body = await source(`components/${file}`)
    assert.match(body, /<OutcomeOverview/)
  }
  const read = await source("components/read.jsx")
  assert.match(read, /Returned targets/)
  assert.match(read, /Unavailable targets/)
  assert.match(read, /Not returned/)
  assert.match(read, /title="Provenance"/)
  assert.match(read, /Request an exact omitted range/)
})

test("expanded inspectors use separated status-aware cards and bounded content panes", async () => {
  const kit = await source("components/kit.jsx")
  assert.match(kit, /export function InspectorCard/)
  assert.match(kit, /export function ContentPane/)
  assert.match(kit, /props\.nested \? props\.skin\.surface : props\.skin\.inset/)
  assert.match(kit, /pending=\{props\.pending === true\}/)
  assert.doesNotMatch(kit.slice(kit.indexOf("export function InspectorCard"), kit.indexOf("export function ContentPane")), /tone === "RUNNING"/)
  assert.match(kit, /export function PreviewList/)
  assert.match(kit, /props\.limit \?\? 6/)
  assert.match(kit, /export function InspectorUnavailable/)
  assert.match(kit, /export function RawEvidence/)
  assert.match(kit, /props\.limit \?\? 12/)
  const edit = await source("components/edit.jsx")
  assert.match(edit, /Intended transaction/)
  assert.match(edit, /Rejected safely/)
  assert.match(edit, /Transaction safety/)
  const web = await source("components/web.jsx")
  assert.match(web, /backend attempts/)
  assert.match(web, /Extracted content/)
  assert.match(web, /<InspectorCard/)
  assert.match(web, /nested>/)
  const editNested = await source("components/edit.jsx")
  assert.match(editNested, /Exact replacement.*nested>/s)
  for (const file of ["read.jsx", "edit.jsx", "shell.jsx", "background.jsx", "discovery.jsx", "web.jsx", "stealth.jsx", "cbm.jsx"]) {
    const body = await source(`components/${file}`)
    assert.match(body, /<InspectorCard/)
  }
})

test("pending batch inspectors never present an unhydrated input frame as a real zero-item plan", async () => {
  const batch = await source("lib/batch.js")
  assert.match(batch, /export function inputPlanAvailable/)
  assert.match(batch, /export function pendingPlanSummary/)
  assert.match(batch, /return `\$\{singular\} input pending`/)
  for (const file of ["read.jsx", "edit.jsx", "shell.jsx", "background.jsx", "web.jsx", "stealth.jsx", "discovery.jsx", "cbm.jsx"]) {
    const body = await source(`components/${file}`)
    assert.match(body, /planReady/)
    assert.match(body, /input pending/)
  }
  const shell = await source("components/shell.jsx")
  assert.doesNotMatch(shell, /: `\$\{batch\(\)\.plannedCount\} command/)
  assert.match(shell, /Waiting for OpenCode to attach the validated command input/)
  const discovery = await source("components/discovery.jsx")
  assert.doesNotMatch(discovery, /\? String\(props\.input\?\.file_pattern \?\? "files"\)/)
  const cbm = await source("components/cbm.jsx")
  assert.doesNotMatch(cbm, /\?\? "indexed evidence"/)
})

test("known tool families preserve plans and degrade bounded completed output without false renderer defects", async () => {
  for (const file of ["read.jsx", "edit.jsx", "shell.jsx", "background.jsx", "web.jsx", "stealth.jsx", "discovery.jsx", "cbm.jsx"]) {
    const body = await source(`components/${file}`)
    assert.match(body, /InspectorDegraded/)
    assert.match(body, /lifecycle\(\)\.phase === "error"/)
    assert.match(body, /statusPending\(status\(\)\)/)
    assert.doesNotMatch(body, /lifecycle\(\)\.error \|\|/)
  }
  const kit = await source("components/kit.jsx")
  assert.match(kit, /export function ToolOutputEvidence/)
  const evidence = await source("lib/evidence.js")
  assert.match(evidence, /export function diagnosticEvidenceLines/)
  for (const signal of ["ADVISORY", "ESCALATION", "RECOVERY", "TECHNICAL STATUS", "OUTPUT BUDGET", "EDIT CONTEXT"]) assert.match(evidence, new RegExp(signal))
  assert.match(kit, /import \{ diagnosticEvidenceLines \}/)
  for (const file of ["read.jsx", "edit.jsx", "shell.jsx", "background.jsx", "discovery.jsx", "web.jsx", "stealth.jsx", "cbm.jsx", "report.jsx"]) {
    const body = await source(`components/${file}`)
    assert.match(body, /evidence=\{props\.output\}/, `${file} must preserve the original tool output`)
  }
  const batch = await source("lib/batch.js")
  assert.match(batch, /export function reconcileBatch/)
  assert.match(batch, /detailAvailable: false/)
  assert.match(batch, /plannedCount: requested\.length/)
  const read = await source("components/read.jsx")
  assert.match(read, /label="Read"/)
  assert.doesNotMatch(read, /Read \$\{items\(\)\.length\} targets/)
  const editParser = await source("lib/edit.js")
  assert.match(editParser, /declared.*consistency/s)
})

test("rich inspectors remain additive and preserve finalized tool diagnostics", async () => {
  const kit = await source("components/kit.jsx")
  assert.match(kit, /Original tool output preserved/)
  assert.match(kit, /Advisories and diagnostic signals/)
  assert.match(kit, /Original output · beginning/)
  assert.match(kit, /Original output · ending/)
  assert.match(kit, /props\.details\(\).*ToolOutputEvidence/s)
  assert.match(kit, /limit=\{48\}/)
})

test("status surfaces remain subtle theme-aware secondary cues", async () => {
  const index = await source("index.tsx")
  for (const token of ["successSurface", "errorSurface", "warningSurface", "accentSurface", "inset"]) assert.match(index, new RegExp(token))
  const kit = await source("components/kit.jsx")
  assert.match(kit, /statusSurface/)
  assert.match(kit, /StatusGlyph/)
  assert.match(kit, /statusLabel/)
})

test("plugin renderer host participates in native transcript layout", async () => {
  const manifest = await readFile(new URL("../selfpatch/patches/1.18.13/manifest.mjs", root), "utf8")
  assert.match(manifest, /alwaysSeparate\.add\(el\)/)
  assert.match(manifest, /flexShrink=\{0\}/)
})

test("IDE enriches only additive presentation slots and never replaces host chrome", async () => {
  const index = await source("index.tsx")
  const start = index.indexOf("api.slots.register({")
  const slots = index.slice(start, index.indexOf("api.keymap.registerLayer", start))
  for (const slot of ["home_prompt_right", "session_prompt_right", "home_bottom", "sidebar_content", "app_bottom"]) {
    assert.equal((slots.match(new RegExp(slot, "g")) ?? []).length, 1, `${slot} must be registered exactly once`)
  }
  // Replacing these would take over native behaviour rather than enriching it.
  assert.doesNotMatch(slots, /home_logo|"home_prompt"|"session_prompt"|mode="replace"|mode="single_winner"/)
})

test("slot renderers read session context from the slot props argument", async () => {
  const index = await source("index.tsx")
  // The host calls slots as (ctx, props); session_id lives on props.
  assert.match(index, /session_prompt_right\(_ctx, props\)/)
  assert.match(index, /sidebar_content\(_ctx, props\)/)
  assert.match(index, /sessionID=\{props\.session_id\}/)
  assert.doesNotMatch(index, /ctx\.session_id/)
})

test("IDE surfaces are presentation-only and delegate navigation to the host router", async () => {
  for (const file of ["components/ide-surfaces.jsx", "components/ide-kit.jsx", "components/session-switcher.jsx"]) {
    const body = await source(file)
    assert.doesNotMatch(body, /keymap\.registerLayer|mode\.push|route\.register|slots\.register/, `${file} must not own host wiring`)
    assert.doesNotMatch(body, /session\.(create|update|delete|fork)\(/, `${file} must not mutate sessions`)
  }
  // Navigation goes through one audited helper that uses the public router.
  const runtime = await source("components/runtime.jsx")
  assert.match(runtime, /export function openSession/)
  assert.match(runtime, /api\.route\.navigate\("session", \{ sessionID \}\)/)
})

test("the prompt insert yields to the host's own agent and model labels", async () => {
  const surfaces = await source("components/ide-surfaces.jsx")
  const start = surfaces.indexOf("export function PromptContext")
  const body = surfaces.slice(start, surfaces.indexOf("function toneColor", start))

  // The host shares this row with the agent/model labels and gives it no width
  // reservation. flexShrink={0} makes the host's labels compress and wrap the
  // model name instead, which is the defect this pins.
  assert.doesNotMatch(body, /flexShrink=\{0\}/, "the insert must shrink before the host's labels do")
  assert.match(body, /flexShrink=\{1\}/)
  assert.match(body, /minWidth=\{0\}/)
  assert.match(body, /wrapMode="none"/)

  // It must stay a single node: extra elements reintroduce width competition.
  assert.equal((body.match(/<text/g) ?? []).length, 1, "the insert must be exactly one text node")
  assert.doesNotMatch(body, /<box/, "a box would claim layout space in the shared row")

  // It renders only what the status bar cannot show, and only when there is room.
  assert.match(body, /props\.sessionID && percent\(\) !== null && roomy\(\)/)
  assert.doesNotMatch(body, /contextLine|snapshot\(\)\.project|snapshot\(\)\.branch/, "duplicated status-bar data must not compete for prompt width")
})

test("design tokens are theme-reactive rather than captured once at load", async () => {
  const index = await source("index.tsx")
  const runtime = await source("components/runtime.jsx")
  assert.match(runtime, /export function createSkin/)
  assert.match(runtime, /createMemo\(\(\) => \{/)
  assert.match(runtime, /api\?\.theme\?\.current/)
  // Tokens must be passed as an accessor so surfaces re-render on theme change.
  assert.match(index, /tokens=\{tokens\}/)
  assert.doesNotMatch(index, /const skin = \{ \.\.\.skinOf/)
})

test("Delivery Hub and Mission Control have distinct product responsibilities", async () => {
  const workbench = await source("components/workbench.jsx")
  const operations = await source("components/operations.jsx")
  const monitor = await source("components/monitor.jsx")
  assert.match(workbench, /OperationsWorkspace/)
  assert.doesNotMatch(workbench, /tabsWithSlots|ActivityPanel|SessionView|DetailPane/)
  assert.match(operations, /commandCenterModel/)
  assert.match(operations, /\.tasks\.slice\(0, 20\)/)
  assert.match(operations, /\.review\.slice\(0, 12\)/)
  assert.match(operations, /\.unresolved\.slice\(0, 12\)/)
  assert.match(operations, /Project Delivery Hub/)
  assert.match(operations, /Decisions & memory/)
  assert.doesNotMatch(operations, /liveActivity|useClock|Working now|Recent chats/)
  assert.match(monitor, /missionControlModel/)
  assert.match(monitor, /liveActivity/)
  assert.match(monitor, /AgentTableRow/)
  assert.doesNotMatch(monitor, /Review queue|Decisions & memory|Recent completed outcomes/)
})

test("animation runs on one shared clock that idles when unobserved", async () => {
  const runtime = await source("components/runtime.jsx")
  assert.match(runtime, /export function createClock/)
  assert.match(runtime, /subscribers\(\) > 0/)
  assert.match(runtime, /clearInterval\(timer\)/)
  // Surfaces subscribe through the hook instead of creating their own timers.
  for (const file of ["components/ide-kit.jsx", "components/ide-surfaces.jsx", "components/session-switcher.jsx"]) {
    const body = await source(file)
    assert.doesNotMatch(body, /setInterval|setTimeout/, `${file} must use the shared clock`)
  }
})

test("the legacy session store remains event-driven, single-flighted, and failure-tolerant", async () => {
  const runtime = await source("components/runtime.jsx")
  assert.match(runtime, /session\.updated/)
  assert.match(runtime, /session\.deleted/)
  assert.match(runtime, /if \(inFlight\)/)
  assert.match(runtime, /queued = true/)
  assert.match(runtime, /clearTimeout\(debounce\)/)
  // A failed refresh must keep the previous list instead of blanking the UI.
  assert.match(runtime, /setStore\("error"/)
  assert.doesNotMatch(runtime, /catch[\s\S]{0,120}setStore\("sessions", \[\]\)/)
  const index = await source("index.tsx")
  assert.doesNotMatch(index, /createSessionStore/, "visible IDE surfaces use the cross-project portfolio store")
})

test("the switcher uses native search with keyboard navigation, quick slots, and pinning", async () => {
  const switcher = await source("components/session-switcher.jsx")
  assert.match(switcher, /<TextInput/)
  assert.match(switcher, /onInput=\{\(value\)/)
  assert.doesNotMatch(switcher, /applyKeyToQuery/, "native input owns text editing")
  assert.match(switcher, /moveIndex/)
  assert.match(switcher, /scrollWindow/)
  assert.match(switcher, /groupSessions/)
  assert.match(switcher, /store\.togglePin/)
  assert.match(switcher, /\^\[1-9\]\$/)
  assert.match(switcher, /onKeyDown=\{handleKey\}/)
  const index = await source("index.tsx")
  assert.match(index, /alonix-ide\.sessions/)
  assert.match(index, /slashName: "alonix-sessions"/)
  assert.match(index, /const openSwitcher = \(\) => openPalette\(""\)/, "all chat switching uses the portfolio-aware palette")
})

test("plugin reactive state owns an explicit root and is disposed with the plugin", async () => {
  const index = await source("index.tsx")
  assert.match(index, /createRoot\(\(disposeRoot\) =>/)
  assert.match(index, /scope\.disposeRoot\(\)/)
  assert.match(index, /clearInterval\(poll\)/)
  assert.match(index, /scope\.stopDockHydration\(\)/)
  // Exactly one long-lived status poller drives status surfaces and toasts;
  // the other bounded intervals only wait for host KV hydration and clean up.
  assert.equal((index.match(/const poll = setInterval/g) ?? []).length, 1)
  assert.match(index, /dockHydrationTimer = setInterval/)
})
