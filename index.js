import { FsToolingPlugin } from "./packages/filesystem/index.js";
import { EnhancedTerminalPlugin } from "./packages/terminal/index.js";
import cbmPlugin from "./packages/cbm/dist/index.js";
import { WebToolingPlugin } from "./packages/web/index.js";
import { StealthToolingPlugin } from "./packages/stealth/index.js";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SelfPatchPlugin } from "./packages/selfpatch/index.js";
import { applyRuntimeDefaults, migrateInstalledConfig } from "./packages/bootstrap/index.js";
import { packageRootFrom } from "./packages/shared/paths.js";
import { schedulePackageUpdate } from "./packages/bootstrap/update.js";
import { ensureAndActivateGeneration, runtimeAttestation, writeServerLifecycle } from "./packages/shared/generation.js";

function combineHooks(parts) {
  const output = { tool: {} };
  const disposers = [];
  const configHooks = [];
  const beforeHooks = [];
  const afterHooks = [];
  for (const part of parts) {
    Object.assign(output.tool, part.tool ?? {});
    if (typeof part.dispose === "function") disposers.push(part.dispose);
    if (typeof part.config === "function") configHooks.push(part.config);
    if (typeof part["tool.execute.before"] === "function") beforeHooks.push(part["tool.execute.before"]);
    if (typeof part["tool.execute.after"] === "function") afterHooks.push(part["tool.execute.after"]);
  }
  if (configHooks.length) output.config = async (config) => { for (const hook of configHooks) await hook(config); };
  if (beforeHooks.length) output["tool.execute.before"] = async (...args) => { for (const hook of beforeHooks) await hook(...args); };
  if (afterHooks.length) output["tool.execute.after"] = async (...args) => { for (const hook of afterHooks) await hook(...args); };
  if (disposers.length) output.dispose = async () => { await Promise.allSettled(disposers.map((dispose) => dispose())); };
  return output;
}

export const OptimisedToolingsPlugin = async (input) => {
  const packageRoot = packageRootFrom(import.meta.url);
  const attestation = await runtimeAttestation(packageRoot, { role: "server" });
  if (attestation.dependencyMatchesExpected === false) {
    // The npm-resolved package is transport only. OpenCode/npm may hoist a
    // different transitive tree than the published shrinkwrap. Provision the
    // package-local locked generation, switch both config entries atomically,
    // and execute that exact server generation in this process.
    const prepared = await ensureAndActivateGeneration(packageRoot);
    const target = prepared.generation.root;
    if (target === packageRoot) throw new Error("Alonix locked-generation delegation did not change the runtime root");
    const loaded = await import(`${pathToFileURL(join(target, "index.js")).href}?generation=${prepared.generation.fingerprint}`);
    const factory = loaded.default ?? loaded.OptimisedToolingsPlugin;
    if (typeof factory !== "function") throw new Error("Provisioned Alonix generation has no server plugin factory");
    return factory(input);
  }
  writeServerLifecycle(packageRoot, attestation.sourceMatchesMarker === false ? "failed" : "active", {
    ...attestation,
    stage: attestation.sourceMatchesMarker === false ? "runtime-attestation" : "complete",
    error: attestation.sourceMatchesMarker === false ? "Loaded server source bytes do not match the immutable generation marker" : null,
  });
  if (attestation.sourceMatchesMarker === false) throw new Error("Alonix refused a drifted server generation");
  // Migration is deliberately failure-isolated: invalid user JSONC or a locked
  // config can never prevent tool registration in the current process.
  try { migrateInstalledConfig(packageRoot); } catch (error) { console.warn(`[alonix] zero-touch config migration skipped: ${error?.message ?? error}`); }
  // Never hot-swap code used by the running process. A background update first
  // provisions and validates one immutable generation, then atomically stages
  // both direct server and TUI file entries for the next restart.
  schedulePackageUpdate(packageRoot);
  const combined = combineHooks(await Promise.all([
  FsToolingPlugin(input),
  EnhancedTerminalPlugin(input),
  cbmPlugin(input),
  WebToolingPlugin(input),
  StealthToolingPlugin(input),
  SelfPatchPlugin(input),
  Promise.resolve({ config: async (config) => { applyRuntimeDefaults(config, packageRoot); } }),
]));
  return combined;
};

export default OptimisedToolingsPlugin;
