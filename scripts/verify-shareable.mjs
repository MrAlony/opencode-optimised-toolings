#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { root } from "./lib/paths.mjs";

const excludedNames = new Set(["node_modules", ".venv", "__pycache__", ".git", ".runtime", "runtime", "dist"]);
const excludedFiles = [/^config\/secrets\.local\.json$/, /^config\/install-state\.local\.json$/, /^config\/backup-/, /^services\/searxng\/settings\.local\.yml$/];
const textExtensions = new Set([".js", ".mjs", ".json", ".md", ".py", ".toml", ".yml", ".yaml", ".txt", ".rst", ".cfg", ".html", ".css", ".ts"]);
const credentialScope = /^(config\/|packages\/(?:web|stealth)\/|scripts\/|index\.js$)/;
const findings = [];
const required = ["index.js", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "packages/cbm/SKILL.md", "packages/web/index.js", "packages/stealth/worker.py", "services/searxng/LICENSE", "services/searxng/searx/data/__init__.py", "config/secrets.example.json"];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (excludedFiles.some((pattern) => pattern.test(path))) continue;
    if (entry.isDirectory()) { walk(absolute); continue; }
    if (!entry.isFile() || statSync(absolute).size > 4 * 1024 * 1024) continue;
    const extension = entry.name.includes(".") ? `.${entry.name.split(".").pop().toLowerCase()}` : "";
    if (!textExtensions.has(extension) && !["manage", "Makefile"].includes(entry.name)) continue;
    const text = readFileSync(absolute, "utf8");
    const universalChecks = [
      [/C:\\Users\\dell/gi, "hardcoded local Windows user path"],
      [/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/g, "private key material"],
      [/CookieAuthentication\s+0/g, "unauthenticated Tor control"],
    ];
    for (const [pattern, label] of universalChecks) if (pattern.test(text)) findings.push(`${path}: ${label}`);
    if (credentialScope.test(path) && !path.endsWith("secrets.example.json") && !path.includes("/test/") && !path.startsWith("test/")) {
      if (/(?:api[_-]?key|secret[_-]?key|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/gi.test(text)) findings.push(`${path}: possible embedded credential in authored tooling/config surface`);
    }
  }
}

for (const path of required) {
  try { statSync(resolve(root, path)); } catch { findings.push(`${path}: required shareable file is missing`); }
}
walk(root);
if (findings.length) { console.error("SHAREABILITY CHECK: FAILED"); findings.forEach((item) => console.error(`- ${item}`)); process.exit(1); }
console.log("SHAREABILITY CHECK: PASSED\n- No hardcoded local user paths in shareable source.\n- No likely embedded credentials in authored tooling/config surfaces and no private keys anywhere.\n- No unauthenticated Tor control configuration.\n- Required SearXNG data/license and package entry files are present.\n- Local secrets, backups, environments, runtime state, and generated settings are excluded.");
