export const legacyPluginMarkers = ["/oc-cbm/", "/oc-enhanced-terminal/", "/oc-fs-tooling/", "/oc-webtooling/", "/opencode-optimised-toolings/"];
export function normalizeEntry(value) { return String(Array.isArray(value) ? value[0] : value).replaceAll("\\", "/").toLowerCase(); }
export function isLegacyToolingPlugin(value) { const text = normalizeEntry(value); return legacyPluginMarkers.some((marker) => text.includes(marker)); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

export function migrateOpenCodeConfig(input, { rootPluginUrl, cbmSkillPath }) {
  const config = structuredClone(input);
  config.plugin = [...(Array.isArray(config.plugin) ? config.plugin.filter((item) => !isLegacyToolingPlugin(item) && String(Array.isArray(item) ? item[0] : item) !== rootPluginUrl) : []), rootPluginUrl];
  config.tools = { ...object(config.tools), webfetch: false };
  config.permission = object(config.permission);
  Object.assign(config.permission, {
    webfetch: "deny",
    websearch: "deny",
    web_fetch_many: "allow",
    web_search: "allow",
    stealth_fetch_many: "allow",
    stealth_search_many: "allow",
    stealth_rotate_tor: "allow",
    stealth_status: "allow",
  });
  config.skills = object(config.skills);
  config.skills.paths = [...new Set([...(Array.isArray(config.skills.paths) ? config.skills.paths.filter((item) => !normalizeEntry(item).includes("/oc-cbm")) : []), cbmSkillPath])];
  if (config.mcp && typeof config.mcp === "object") delete config.mcp.stealth;
  return config;
}
