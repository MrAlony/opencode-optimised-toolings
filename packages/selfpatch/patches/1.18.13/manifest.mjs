// Anchor patch manifest for OpenCode v1.18.13.
// Adds a plugin-registered tool-renderer registry consulted by the transcript
// ToolPart before the GenericTool fallback, plus the public api.toolRenderers
// registration surface. The registry is reactive: ToolPart display re-evaluates
// whenever renderers register, so parts mounted during early/reconnected
// render paths are not stuck as "generic".
export const manifest = {
  version: "1.18.13",
  create: [
    {
      path: "packages/tui/src/plugin/tool-renderers.ts",
      content: `import type { JSX } from "@opentui/solid"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"

export type PluginToolRenderProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: ToolPart
}

export type PluginToolRenderer = (props: PluginToolRenderProps) => JSX.Element

const registry = new Map<string, { token: symbol; renderer: PluginToolRenderer }[]>()
const [registryVersion, bumpRegistryVersion] = createSignal(0)

export function pluginToolRendererVersion(): number {
  return registryVersion()
}

export function registerPluginToolRenderer(tool: string, renderer: PluginToolRenderer) {
  if (!tool || typeof tool !== "string") {
    throw new Error(\`registerPluginToolRenderer: invalid tool name \${JSON.stringify(tool)}\`)
  }
  if (typeof renderer !== "function") {
    throw new Error(\`registerPluginToolRenderer: renderer for \"\${tool}\" must be a function\`)
  }
  const token = Symbol(tool)
  const entries = registry.get(tool) ?? []
  registry.set(tool, [...entries, { token, renderer }])
  bumpRegistryVersion((prev) => prev + 1)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const current = registry.get(tool)
    if (!current) return
    const next = current.filter((entry) => entry.token !== token)
    if (next.length) registry.set(tool, next)
    else registry.delete(tool)
    bumpRegistryVersion((prev) => prev + 1)
  }
}

export function hasPluginToolRenderer(tool: string): boolean {
  void registryVersion()
  return (registry.get(tool)?.length ?? 0) > 0
}

export function getPluginToolRenderer(tool: string): PluginToolRenderer | undefined {
  void registryVersion()
  return registry.get(tool)?.at(-1)?.renderer
}

export function pluginToolRendererNames(): string[] {
  void registryVersion()
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
import { getPluginToolRenderer, hasPluginToolRenderer, pluginToolRendererVersion } from "../../plugin/tool-renderers"
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
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} flexShrink={0}>
        {renderer()!({ input: props.input, metadata: props.metadata, tool: props.tool, output: props.output, part: props.part })}
      </box>
    </Show>
  )
}

function InlineTool(props: {`,
        },
        {
          name: "reactive ToolPart display memo",
          search: `function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const display = createMemo(() => toolDisplay(props.part.tool))`,
          replace: `function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const display = createMemo(() => {
    void pluginToolRendererVersion()
    return toolDisplay(props.part.tool)
  })`,
        },
      ],
    },
    {
      path: "packages/plugin/src/tui.ts",
      beforeSha256: "3b0ccca22ebf8558afb9dc055505c7c503930f2f622d1db8c3fb9ca3e9278e8c",
      replacements: [
        {
          name: "public tool renderer types",
          search: `export type TuiDispose = () => void | Promise<void>`,
          replace: `export type TuiToolRenderProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: Part
}

export type TuiToolRenderer = (props: TuiToolRenderProps) => JSX.Element

export type TuiToolRenderers = {
  register: (tool: string, renderer: TuiToolRenderer) => () => void
}

export type TuiDispose = () => void | Promise<void>`,
        },
        {
          name: "public api toolRenderers property",
          search: `  renderer: CliRenderer
  slots: TuiSlots`,
          replace: `  renderer: CliRenderer
  toolRenderers: TuiToolRenderers
  slots: TuiSlots`,
        },
      ],
    },
    {
      path: "packages/opencode/src/plugin/tui/runtime.ts",
      beforeSha256: "f454bc0c2ec61d5cf605f4c65b2223692cd6731f501fd64a4a762a8868c69e70",
      replacements: [
        {
          name: "scoped tool renderer forwarding",
          search: `    event,
    renderer: api.renderer,
    slots,`,
          replace: `    event,
    renderer: api.renderer,
    toolRenderers: {
      register(tool, renderer) {
        return scope.track(api.toolRenderers.register(tool, renderer))
      },
    },
    slots,`,
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
        return registerPluginToolRenderer(tool, renderer)
      },
    },
    slots: {`,
        },
      ],
    },
  ],
}
