import { test } from "node:test"
import assert from "node:assert/strict"
import { parseShellCommands } from "../lib/shell.js"

const REPORT = `TERMINAL RESULT: SUCCESS

WHAT HAPPENED: 2 command(s) succeeded and 0 failed, timed out, or were aborted.

BATCH PLAN: 2 command(s) executed; mode=parallel.
Terminal batch: 2 command(s), mode=parallel

=== COMMAND 1: list files ===
Outcome: exit 0
Duration: 1243ms
Working directory: C:\\repo
Command: node script.js
--- CAPTURED OUTPUT ---
hello world
--- TECHNICAL STATUS ---
status: exit 0
duration_ms: 1243

=== COMMAND 2: failing step ===
Outcome: exit 1
Meaning: The command failed.
Duration: 300ms
--- CAPTURED OUTPUT ---
some error output
`

test("parseShellCommands extracts both commands", () => {
  const commands = parseShellCommands(REPORT)
  assert.equal(commands.length, 2)
  assert.equal(commands[0].num, 1)
  assert.equal(commands[0].label, "list files")
  assert.equal(commands[1].label, "failing step")
})

test("parseShellCommands captures exit, duration, meaning and body", () => {
  const [first, second] = parseShellCommands(REPORT)
  assert.equal(first.exit, 0)
  assert.equal(first.duration, "1243ms")
  assert.deepEqual(first.body, ["hello world"])
  assert.equal(second.exit, 1)
  assert.equal(second.meaning, "The command failed.")
  assert.deepEqual(second.body, ["some error output"])
})

test("parseShellCommands ignores non-command text", () => {
  assert.deepEqual(parseShellCommands("no commands here"), [])
})
