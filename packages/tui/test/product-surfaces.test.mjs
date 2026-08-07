import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const components = path.resolve(here, "../components")
const repository = path.resolve(here, "../../..")
const read = (file) => fs.readFileSync(file, "utf8")
const protectedRenderers = new Set(["background.jsx", "cbm.jsx", "discovery.jsx", "report.jsx", "shell.jsx"])

test("all non-renderer Alonix text follows native OpenCode selection behavior", () => {
  const offenders = fs.readdirSync(components).filter((name) => name.endsWith(".jsx") && !protectedRenderers.has(name)).filter((name) => read(path.join(components, name)).includes("selectable={false}"))
  assert.deepEqual(offenders, [], "custom IDE text must remain mouse-selectable by default")
})

test("Delivery Hub owns delivery intelligence and excludes real-time telemetry", () => {
  const operations = read(path.join(components, "operations.jsx"))
  const model = read(path.join(repository, "packages/tui/lib/command-center.js"))
  for (const label of ["Unified project tasks", "Review queue", "Unresolved work", "Decisions & memory", "Cross-chat change overlaps", "Recent completed outcomes", "Project health"]) assert.match(operations, new RegExp(label))
  assert.match(operations, /commandCenterModel/)
  assert.match(model, /reviewed/)
  assert.match(model, /collisions/)
  assert.doesNotMatch(operations, /liveActivity|useClock|Working now|Recent chats/)
})

test("Mission Control owns only current intervention and scalable supervision", () => {
  const monitor = read(path.join(components, "monitor.jsx"))
  const model = read(path.join(repository, "packages/tui/lib/mission-control.js"))
  assert.match(monitor, /Live Agents Mission Control/)
  for (const label of ["Needs you", "Working", "Stalled", "Overlaps", "FocusPanel", "AgentTableRow"]) assert.match(monitor, new RegExp(label))
  assert.match(monitor, /agentWindow/)
  assert.match(model, /MISSION_STALL_MS/)
  assert.match(model, /fileOwners/)
  assert.doesNotMatch(monitor, /Review queue|Decisions & memory|Recent completed outcomes|commandCenterModel/)
})

test("delivery state is Alonix-owned KV and never mutates host sessions", () => {
  const store = read(path.join(components, "project-store.jsx"))
  const index = read(path.join(repository, "packages/tui/index.tsx"))
  assert.match(store, /DELIVERY_STATE_KEY = "alonix_delivery_state"/)
  assert.match(store, /markReviewed\(sessionID\)/)
  assert.match(store, /addDecision\(input\)/)
  assert.match(store, /removeDecision\(id\)/)
  assert.match(index, /Add project decision/)
  assert.doesNotMatch(store, /session\.(create|update|delete|fork)\(/)
})

test("Alonix sidebar contributes exceptions without duplicating native sidebar sections", () => {
  const source = read(path.join(components, "ide-surfaces.jsx"))
  const start = source.indexOf("export function WorkspaceInspector")
  const end = source.indexOf("export function StatusBar")
  const inspector = source.slice(start, end)
  assert.match(inspector, /Needs your attention/)
  assert.match(inspector, /Alonix capability/)
  for (const duplicate of ["title=\"Sessions\"", "title=\"Plan\"", "title=\"Changes\"", "title=\"Context\"", "title=\"Environment\""]) assert.equal(inspector.includes(duplicate), false, `duplicate sidebar panel remained: ${duplicate}`)
  assert.doesNotMatch(inspector, /todos\.slice|files\.slice/)
  const nativeTodo = read(path.join(repository, "runtime/src/opencode-1.18.15/packages/tui/src/feature-plugins/sidebar/todo.tsx"))
  const nativeFiles = read(path.join(repository, "runtime/src/opencode-1.18.15/packages/tui/src/feature-plugins/sidebar/files.tsx"))
  assert.match(nativeTodo, /<For each=\{list\(\)\}>/)
  assert.match(nativeFiles, /<For each=\{list\(\)\}>/)
})
