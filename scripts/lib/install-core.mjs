export const legacyPluginMarkers = ["/oc-cbm/", "/oc-enhanced-terminal/", "/oc-fs-tooling/", "/oc-webtooling/", "/opencode-optimised-toolings/"];
export function normalizeEntry(value) { return String(Array.isArray(value) ? value[0] : value).replaceAll("\\", "/").toLowerCase(); }
export function isLegacyToolingPlugin(value) { const text = normalizeEntry(value); return legacyPluginMarkers.some((marker) => text.includes(marker)); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

export const legacyAlonixToolIds = {
  "alonix-read-many": "alonix-read",
  "alonix-edit-many": "alonix-edit",
  "alonix-web-fetch-many": "alonix-web-fetch",
  "alonix-stealth-fetch-many": "alonix-stealth-fetch",
  "alonix-stealth-search-many": "alonix-stealth-search",
};

const alonixPermissionDefaults = {
  "alonix-read": "allow",
  "alonix-edit": "allow",
  "alonix-search": "allow",
  "alonix-explore": "allow",
  "alonix-shell": "allow",
  "alonix-background-process": "deny",
  "alonix-web-fetch": "allow",
  "alonix-web-search": "allow",
  "alonix-stealth-fetch": "allow",
  "alonix-stealth-search": "allow",
  "alonix-stealth-rotate-tor": "allow",
  "alonix-stealth-status": "allow",
  "alonix-toolings": "allow",
  "alonix-index-project": "allow",
  "alonix-index-context": "allow",
  "alonix-index-investigate": "allow",
  "alonix-index-memory": "allow",
};

export function migrateOpenCodeConfig(input, { rootPluginUrl, cbmSkillPath }) {
  const config = structuredClone(input);
  config.plugin = [...(Array.isArray(config.plugin) ? config.plugin.filter((item) => !isLegacyToolingPlugin(item) && String(Array.isArray(item) ? item[0] : item) !== rootPluginUrl) : []), rootPluginUrl];
  config.tools = { ...object(config.tools), webfetch: false };
  config.permission = object(config.permission);
  for (const legacyTool of [
    "fs_read_many", "fs_edit_many", "fs_search", "fs_explore", "shell", "background_process",
    "web_search", "web_fetch", "stealth_fetch", "stealth_search", "stealth_rotate_tor",
    "stealth_status", "toolings", "cbm_project", "cbm_context", "cbm_investigate", "cbm_memory",
  ]) delete config.permission[legacyTool];
  for (const [legacy, current] of Object.entries(legacyAlonixToolIds)) {
    if (config.permission[current] === undefined && config.permission[legacy] !== undefined) config.permission[current] = config.permission[legacy];
    delete config.permission[legacy];
  }
  if (config.permission.webfetch === undefined) config.permission.webfetch = "deny";
  if (config.permission.websearch === undefined) config.permission.websearch = "deny";
  for (const [tool, fallback] of Object.entries(alonixPermissionDefaults)) {
    if (config.permission[tool] === undefined) config.permission[tool] = fallback;
  }
  config.skills = object(config.skills);
  config.skills.paths = [...new Set([...(Array.isArray(config.skills.paths) ? config.skills.paths.filter((item) => !normalizeEntry(item).includes("/oc-cbm")) : []), cbmSkillPath])];
  if (config.mcp && typeof config.mcp === "object") delete config.mcp.stealth;
  return config;
}
