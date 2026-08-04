import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const configDirectory = resolve(root, "config");
export const secretsPath = process.env.OPENCODE_TOOLINGS_SECRETS || resolve(configDirectory, "secrets.local.json");
export const installStatePath = resolve(configDirectory, "install-state.local.json");
export const globalOpenCodeDirectory = process.env.OPENCODE_CONFIG_DIR || resolve(homedir(), ".config", "opencode");
export const globalConfigPath = process.env.OPENCODE_CONFIG_PATH || resolve(globalOpenCodeDirectory, "opencode.json");
export const rootPluginUrl = pathToFileURL(resolve(root, "index.js")).href;
export const cbmSkillPath = resolve(root, "packages", "cbm").replaceAll("\\", "/");
