import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateOpenCodeConfig } from "../scripts/lib/install-core.mjs";
import { writeJsonAtomic } from "../scripts/lib/json-files.mjs";

const options = { rootPluginUrl: "file:///portable/index.js", cbmSkillPath: "C:/portable/packages/cbm" };

test("migration preserves provider, model, DCP, unrelated plugins, and unrelated MCP entries", () => {
  const input = {
    $schema: "https://opencode.ai/config.json",
    model: "provider/model",
    provider: { private: { options: { apiKey: "local-secret-preserved" } } },
    plugin: ["@tarquinen/opencode-dcp@latest", "file:///old/oc-cbm/dist/index.js", ["unrelated-plugin", { option: true }]],
    mcp: { stealth: { type: "local" }, other: { type: "remote", url: "https://example.com" } },
    permission: { "*": "allow", bash: "deny", fs_read_many: "allow", background_process: "allow", web_search: "allow" },
    tools: { custom_existing: true },
    skills: { paths: ["C:/old/oc-cbm/SKILL.md", "C:/other/skills"] },
    tui: { scroll_speed: 5 },
  };
  const output = migrateOpenCodeConfig(input, options);
  assert.deepEqual(output.provider, input.provider);
  assert.equal(output.model, input.model);
  assert.deepEqual(output.tui, input.tui);
  assert.deepEqual(output.mcp.other, input.mcp.other);
  assert.equal(output.mcp.stealth, undefined);
  assert.ok(output.plugin.includes("@tarquinen/opencode-dcp@latest"));
  assert.ok(output.plugin.some((item) => Array.isArray(item) && item[0] === "unrelated-plugin"));
  assert.ok(output.plugin.includes(options.rootPluginUrl));
  assert.equal(output.plugin.some((item) => String(item).includes("oc-cbm")), false);
  assert.equal(output.tools.custom_existing, true);
  assert.equal(output.tools.webfetch, false);
  assert.equal(output.permission.bash, "deny");
  assert.equal(output.permission.webfetch, "deny");
  assert.equal(output.permission["alonix-web-fetch-many"], "allow");
  assert.equal(output.permission["alonix-read-many"], "allow");
  assert.equal(output.permission["alonix-background-process"], "deny");
  assert.equal(output.permission.fs_read_many, undefined);
  assert.equal(output.permission.background_process, undefined);
  assert.equal(output.permission.web_search, undefined);
  assert.deepEqual(output.skills.paths, ["C:/other/skills", options.cbmSkillPath]);
  assert.notEqual(output, input);
});

test("migration is idempotent and does not duplicate root plugin or skill path", () => {
  const once = migrateOpenCodeConfig({ plugin: [], skills: {} }, options);
  const twice = migrateOpenCodeConfig(once, options);
  assert.equal(twice.plugin.filter((item) => item === options.rootPluginUrl).length, 1);
  assert.equal(twice.skills.paths.filter((item) => item === options.cbmSkillPath).length, 1);
});

test("atomic JSON writes replace an existing Windows-compatible target without leaving swap files", () => {
  const directory = mkdtempSync(join(tmpdir(), "alonix-json-"));
  const file = join(directory, "opencode.json");
  try {
    writeFileSync(file, '{"before":true}\n', "utf8");
    writeJsonAtomic(file, { after: true });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { after: true });
    assert.deepEqual(readdirSync(directory).sort(), ["opencode.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
