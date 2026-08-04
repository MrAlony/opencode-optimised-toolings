// Anchor patch manifest for OpenCode v1.18.13.
// Adds a plugin-registered tool-renderer registry consulted by the transcript
// ToolPart before the GenericTool fallback, plus the public api.toolRenderers
// registration surface.
export const manifest = {
  version: "1.18.13",
  create: [
    {
      path: "packages/tui/src/plugin/tool-renderers.ts",
      content: `import type { JSX } from "@opentui/solid"
import type { ToolPart } from "@opencode-ai/sdk/v2"

export type PluginToolRenderProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: ToolPart
}

export type PluginToolRenderer = (props: PluginToolRenderProps) => JSX.Element

const registry = new Map<string, PluginToolRenderer>()

export function registerPluginToolRenderer(tool: string, renderer: PluginToolRenderer) {
  if (!tool || typeof tool !== "string") {
    throw new Error(\`registerPluginToolRenderer: invalid tool name \${JSON.stringify(tool)}\`)
  }
  if (typeof renderer !== "function") {
    throw new Error(\`registerPluginToolRenderer: renderer for \"\${tool}\" must be a function\`)
  }
  registry.set(tool, renderer)
}

export function hasPluginToolRenderer(tool: string): boolean {
  return registry.has(tool)
}

export function getPluginToolRenderer(tool: string): PluginToolRenderer | undefined {
  return registry.get(tool)
}

export function pluginToolRendererNames(): string[] {
  return [...registry.keys()]
}
`,
    },
  ],
  files: [
    {
      path: "packages/tui/src/routes/session/index.tsx",
      beforeSha256: "98dc5efb0302f3b54a774005983f7e9aeb5c6b38368ce1f2f565a37fb94228d5",
      replacements: [
        {
          name: "registry import",
          search: `import { usePluginRuntime } from "../../plugin/runtime"
import { DialogRetryAction } from "../../component/dialog-retry-action"`,
          replace: `import { usePluginRuntime } from "../../plugin/runtime"
import { getPluginToolRenderer, hasPluginToolRenderer } from "../../plugin/tool-renderers"
import { DialogRetryAction } from "../../component/dialog-retry-action"`,
        },
        {
          name: "toolDisplay registry lookup",
          search: `export function toolDisplay(tool: string) {
  return toolDisplays.has(tool) ? tool : "generic"
}`,
          replace: `export function toolDisplay(tool: string) {
  if (toolDisplays.has(tool)) return tool
  if (hasPluginToolRenderer(tool)) return "plugin"
  return "generic"
}`,
        },
        {
          name: "ToolPart plugin branch",
          search: `        <Match when={display() === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={true}>`,
          replace: `        <Match when={display() === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={display() === "plugin"}>
          <PluginTool {...toolprops} />
        </Match>
        <Match when={true}>`,
        },
        {
          name: "PluginTool component",
          search: `      </BlockTool>
    </Show>
  )
}

function InlineTool(props: {`,
          replace: `      </BlockTool>
    </Show>
  )
}

function PluginTool(props: ToolProps) {
  const renderer = createMemo(() => getPluginToolRenderer(props.tool))
  return (
    <Show when={renderer()} fallback={<GenericTool {...props} />}>
      <box>{renderer()!({ input: props.input, metadata: props.metadata, tool: props.tool, output: props.output, part: props.part })}</box>
    </Show>
  )
}

function InlineTool(props: {`,
        },
      ],
    },
    {
      path: "packages/tui/src/plugin/adapters.tsx",
      beforeSha256: "ecff9bb3a2d1acf0f4ee6d1dacf213ee059d88fa22cedced8cafa51dfb4eb353",
      replacements: [
        {
          name: "tool-renderers import",
          search: `export { createPluginRoutes, createTuiApi } from "./api"`,
          replace: `export { createPluginRoutes, createTuiApi } from "./api"
import { registerPluginToolRenderer } from "./tool-renderers"`,
        },
        {
          name: "api.toolRenderers surface",
          search: `    renderer: input.renderer,
    slots: {`,
          replace: `    renderer: input.renderer,
    toolRenderers: {
      register(tool, renderer) {
        registerPluginToolRenderer(tool, renderer)
      },
    },
    slots: {`,
        },
      ],
    },
  ],
}
