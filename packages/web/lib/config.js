import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const secretsPath = process.env.OPENCODE_TOOLINGS_SECRETS || resolve(repositoryRoot, "config", "secrets.local.json");

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

export { repositoryRoot, secretsPath };
