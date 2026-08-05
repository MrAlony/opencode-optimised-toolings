export const legacyPluginMarkers = ["/oc-cbm/", "/oc-enhanced-terminal/", "/oc-fs-tooling/", "/oc-webtooling/", "/opencode-optimised-toolings/"];
export function normalizeEntry(value) { return String(Array.isArray(value) ? value[0] : value).replaceAll("\\", "/").toLowerCase(); }
export function isLegacyToolingPlugin(value) { const text = normalizeEntry(value); return legacyPluginMarkers.some((marker) => text.includes(marker)); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

export function migrateOpenCodeConfig(input, { rootPluginUrl, cbmSkillPath }) {
  const config = structuredClone(input);
  config.plugin = [...(Array.isArray(config.plugin) ? config.plugin.filter((item) => !isLegacyToolingPlugin(item) && String(Array.isArray(item) ? item[0] : item) !== rootPluginUrl) : []), rootPluginUrl];
  config.tools = { ...object(config.tools), webfetch: false };
  config.permission = object(config.permission);
  for (const legacyTool of [
    "fs_read_many", "fs_edit_many", "fs_search", "fs_explore", "shell", "background_process",
    "web_search", "web_fetch_many", "stealth_fetch_many", "stealth_search_many", "stealth_rotate_tor",
    "stealth_status", "toolings", "cbm_project", "cbm_context", "cbm_investigate", "cbm_memory",
  ]) delete config.permission[legacyTool];
  Object.assign(config.permission, {
    webfetch: "deny",
    websearch: "deny",
    "alonix-read-many": "allow",
    "alonix-edit-many": "allow",
    "alonix-search": "allow",
    "alonix-explore": "allow",
    "alonix-shell": "allow",
    "alonix-background-process": "deny",
    "alonix-web-fetch-many": "allow",
    "alonix-web-search": "allow",
    "alonix-stealth-fetch-many": "allow",
    "alonix-stealth-search-many": "allow",
    "alonix-stealth-rotate-tor": "allow",
    "alonix-stealth-status": "allow",
    "alonix-toolings": "allow",
    "alonix-index-project": "allow",
    "alonix-index-context": "allow",
    "alonix-index-investigate": "allow",
    "alonix-index-memory": "allow",
  });
  config.skills = object(config.skills);
  config.skills.paths = [...new Set([...(Array.isArray(config.skills.paths) ? config.skills.paths.filter((item) => !normalizeEntry(item).includes("/oc-cbm")) : []), cbmSkillPath])];
  if (config.mcp && typeof config.mcp === "object") delete config.mcp.stealth;
  return config;
}
