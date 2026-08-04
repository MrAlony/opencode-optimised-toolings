import { FsToolingPlugin } from "./packages/filesystem/index.js";
import { EnhancedTerminalPlugin } from "./packages/terminal/index.js";
import cbmPlugin from "./packages/cbm/dist/index.js";
import { WebToolingPlugin } from "./packages/web/index.js";
import { StealthToolingPlugin } from "./packages/stealth/index.js";

function combineHooks(parts) {
  const output = { tool: {} };
  const disposers = [];
  const beforeHooks = [];
  const afterHooks = [];
  for (const part of parts) {
    Object.assign(output.tool, part.tool ?? {});
    if (typeof part.dispose === "function") disposers.push(part.dispose);
    if (typeof part["tool.execute.before"] === "function") beforeHooks.push(part["tool.execute.before"]);
    if (typeof part["tool.execute.after"] === "function") afterHooks.push(part["tool.execute.after"]);
  }
  if (beforeHooks.length) output["tool.execute.before"] = async (...args) => { for (const hook of beforeHooks) await hook(...args); };
  if (afterHooks.length) output["tool.execute.after"] = async (...args) => { for (const hook of afterHooks) await hook(...args); };
  if (disposers.length) output.dispose = async () => { await Promise.allSettled(disposers.map((dispose) => dispose())); };
  return output;
}

export const OptimisedToolingsPlugin = async (input) => combineHooks(await Promise.all([
  FsToolingPlugin(input),
  EnhancedTerminalPlugin(input),
  cbmPlugin(input),
  WebToolingPlugin(input),
  StealthToolingPlugin(input),
]));

export default OptimisedToolingsPlugin;
