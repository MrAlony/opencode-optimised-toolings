#!/usr/bin/env node
import { startSearx, statusSearx, stopSearx } from "./lib/services.mjs";
const action = process.argv[2] || "status";
try { const result = action === "start" ? await startSearx() : action === "stop" ? await stopSearx() : action === "restart" ? (await stopSearx(), await startSearx()) : action === "status" ? await statusSearx() : null; if (!result) throw new Error("Usage: npm run services -- [start|stop|restart|status]"); console.log(JSON.stringify(result, null, 2)); } catch (error) { console.error(`SERVICE ${action.toUpperCase()} FAILED: ${error.message}`); process.exitCode = 1; }
