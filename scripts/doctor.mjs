#!/usr/bin/env node
process.argv.splice(2, process.argv.length - 2, "doctor")
await import("./toolings.mjs")
