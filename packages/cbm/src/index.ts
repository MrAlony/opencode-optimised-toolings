import { buildToolDefs } from "./tools/index.js";

/**
 * Registers the bounded CBM tools with OpenCode.
 * Params: None.
 * Returns: Promise-like plugin configuration containing tool definitions.
 * Side effects: None during registration; tools start subprocesses only when invoked.
 * Assumptions: OpenCode loads this compiled module once per plugin lifecycle.
 */
const ocCbmPlugin = async () => {
  return {
    tool: buildToolDefs(),
  };
};

export default ocCbmPlugin;
