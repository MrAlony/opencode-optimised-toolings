import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const userSecretsPath = resolve(homedir(), ".config", "opencode", "alonix", "secrets.json");
const legacySecretsPath = resolve(repositoryRoot, "config", "secrets.local.json");
const configuredSecretsPath = process.env.OPENCODE_TOOLINGS_SECRETS;
const secretsPath = resolve(configuredSecretsPath || (existsSync(userSecretsPath) ? userSecretsPath : legacySecretsPath));

export function loadSecrets() {
  try { return JSON.parse(readFileSync(secretsPath, "utf8")); }
  catch { return {}; }
}

export function webConfig() {
  const local = loadSecrets()["alonix-web-search"] ?? {};
  return {
    serper_api_key: process.env.SERPER_API_KEY || local.serper_api_key || "",
    firecrawl_api_key: process.env.FIRECRAWL_API_KEY || local.firecrawl_api_key || "",
    tavily_api_key: process.env.TAVILY_API_KEY || local.tavily_api_key || "",
    exa_api_key: process.env.EXA_API_KEY || local.exa_api_key || "",
    searxng_ports: Array.isArray(local.searxng_ports) ? local.searxng_ports : [18999],
  };
}

export { legacySecretsPath, repositoryRoot, secretsPath, userSecretsPath };
