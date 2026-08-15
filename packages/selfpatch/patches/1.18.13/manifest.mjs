// Anchor patch manifest for OpenCode v1.18.13.
// Adds a plugin-registered tool-renderer registry consulted by the transcript
// ToolPart before the GenericTool fallback, plus the public api.toolRenderers
// registration surface. The registry is reactive: ToolPart display re-evaluates
// whenever renderers register, so parts mounted during early/reconnected
// render paths are not stuck as "generic". It also recovers persisted pending or
// running tool parts when a new session-loop generation proves their former
// in-memory runner no longer exists.
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
    {
      path: "packages/tui/src/prompt/history-attachments.ts",
      content: `import path from "path"
import { mkdir, readdir, rename, rm, stat } from "fs/promises"
import type { PromptInfo } from "./history"

const REFERENCE_PREFIX = "alonix-history://"
const DATA_URL = /^data:([^;,]+);base64,(.+)$/s
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000

function root(statePath: string) {
  return path.join(statePath, "prompt-history-attachments")
}

function attachmentPath(statePath: string, hash: string) {
  return path.join(root(statePath), \`${"${hash}"}.bin\`)
}

function reference(hash: string, mime: string) {
  return \`\${REFERENCE_PREFIX}\${hash}?mime=\${encodeURIComponent(mime)}\`
}

function parseReference(value: unknown) {
  if (typeof value !== "string" || !value.startsWith(REFERENCE_PREFIX)) return undefined
  const separator = value.indexOf("?mime=", REFERENCE_PREFIX.length)
  if (separator === -1) return undefined
  const hash = value.slice(REFERENCE_PREFIX.length, separator)
  if (!/^[a-f0-9]{64}$/.test(hash)) return undefined
  return { hash, mime: decodeURIComponent(value.slice(separator + 6)) }
}

async function persistAttachment(statePath: string, bytes: Uint8Array) {
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const directory = root(statePath)
  const target = attachmentPath(statePath, hash)
  if (await Bun.file(target).exists()) return hash
  await mkdir(directory, { recursive: true })
  const temporary = \`${"${target}"}.${"${process.pid}"}.${"${crypto.randomUUID()}"}.tmp\`
  await Bun.write(temporary, bytes)
  await rename(temporary, target).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    if (!(await Bun.file(target).exists())) throw error
  })
  return hash
}

export async function externalizePromptHistoryEntry(item: PromptInfo, statePath: string): Promise<PromptInfo> {
  const parts: PromptInfo["parts"] = []
  for (const part of item.parts) {
    if (part.type !== "file" || typeof part.url !== "string") {
      parts.push({ ...part })
      continue
    }
    const match = part.url.match(DATA_URL)
    if (!match) {
      parts.push({ ...part })
      continue
    }
    const bytes = Buffer.from(match[2], "base64")
    const hash = await persistAttachment(statePath, bytes)
    parts.push({ ...part, url: reference(hash, match[1]) })
  }
  return { input: item.input, mode: item.mode, parts }
}

export async function hydratePromptHistoryEntry(item: PromptInfo, statePath: string): Promise<PromptInfo> {
  const parts = await Promise.all(item.parts.map(async (part) => {
    if (part.type !== "file") return { ...part }
    const stored = parseReference(part.url)
    if (!stored) return { ...part }
    const file = Bun.file(attachmentPath(statePath, stored.hash))
    if (!(await file.exists())) return { ...part }
    const data = Buffer.from(await file.arrayBuffer()).toString("base64")
    return { ...part, url: \`data:${"${stored.mime}"};base64,${"${data}"}\` }
  }))
  return { input: item.input, mode: item.mode, parts }
}

export async function prunePromptHistoryAttachments(entries: PromptInfo[], statePath: string, now = Date.now()) {
  const retained = new Set<string>()
  for (const entry of entries) {
    for (const part of entry.parts) {
      if (part.type !== "file") continue
      const stored = parseReference(part.url)
      if (stored) retained.add(stored.hash)
    }
  }
  const directory = root(statePath)
  const names = await readdir(directory).catch(() => [])
  await Promise.all(names.map(async (name) => {
    const match = name.match(/^([a-f0-9]{64})\.bin$/)
    if (!match || retained.has(match[1])) return
    const target = path.join(directory, name)
    const info = await stat(target).catch(() => undefined)
    if (!info || now - info.mtimeMs < ORPHAN_GRACE_MS) return
    await rm(target, { force: true }).catch(() => undefined)
  }))
}
`,
    },
    {
      path: "packages/tui/src/context/part-delta-buffer.ts",
      content: `export type PendingPartDelta = {
  sessionID: string
  messageID: string
  partID: string
  field: string
  delta: string
}

type Scheduler = (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
type Canceller = (handle: ReturnType<typeof setTimeout>) => void

// Provider streams frequently deliver one token per event. Preserve every byte
// and its order while committing at most once per display frame, avoiding a
// growing-string allocation and Solid/layout invalidation for every token.
export function createPartDeltaBuffer(
  commit: (entries: PendingPartDelta[]) => void,
  options: { frameMs?: number; schedule?: Scheduler; cancel?: Canceller } = {},
) {
  const frameMs = Math.max(1, options.frameMs ?? 16)
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle))
  const pending = new Map<string, Omit<PendingPartDelta, "delta"> & { chunks: string[] }>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const keyOf = (entry: Omit<PendingPartDelta, "delta">) =>
    \`\${entry.sessionID}\\0\${entry.messageID}\\0\${entry.partID}\\0\${entry.field}\`

  const flush = (matches: (entry: PendingPartDelta) => boolean = () => true) => {
    const entries: PendingPartDelta[] = []
    for (const [key, buffered] of pending) {
      const entry: PendingPartDelta = { ...buffered, delta: buffered.chunks.join("") }
      delete (entry as Partial<typeof buffered>).chunks
      if (!matches(entry)) continue
      pending.delete(key)
      entries.push(entry)
    }
    if (pending.size === 0 && timer !== undefined) {
      cancel(timer)
      timer = undefined
    }
    if (entries.length) commit(entries)
    return entries.length
  }

  const scheduleFlush = () => {
    if (timer !== undefined) return
    timer = schedule(() => {
      timer = undefined
      flush()
    }, frameMs)
  }

  return {
    queue(entry: PendingPartDelta) {
      const key = keyOf(entry)
      const current = pending.get(key)
      if (current) current.chunks.push(entry.delta)
      else pending.set(key, { ...entry, chunks: [entry.delta] })
      scheduleFlush()
    },
    flush,
    dispose() {
      if (timer !== undefined) cancel(timer)
      timer = undefined
      flush()
    },
    get size() {
      return pending.size
    },
  }
}
`,
    },
  ],
  files: [
    {
      path: "packages/tui/src/context/sync.tsx",
      beforeSha256: "648147d2abee2e01a467eacaf3abf78018ef184e2902ecaa6e3f2242484a8431",
      replacements: [
        {
          name: "frame-coalesced delta imports",
          search: `import { batch, onMount } from "solid-js"
import path from "path"`,
          replace: `import { batch, onCleanup, onMount } from "solid-js"
import path from "path"
import { createPartDeltaBuffer } from "./part-delta-buffer"`,
        },
        {
          name: "lossless frame delta buffer",
          search: `    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

    function sessionListQuery()`,
          replace: `    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

    const partDeltas = createPartDeltaBuffer((entries) => {
      const byMessage = new Map<string, typeof entries>()
      for (const entry of entries) {
        const current = byMessage.get(entry.messageID)
        if (current) current.push(entry)
        else byMessage.set(entry.messageID, [entry])
      }
      batch(() => {
        for (const [messageID, deltas] of byMessage) {
          const parts = store.part[messageID]
          if (!parts) continue
          setStore(
            "part",
            messageID,
            produce((draft) => {
              for (const delta of deltas) {
                const result = search(draft, delta.partID, (part) => part.id)
                if (!result.found) continue
                const part = draft[result.index]
                const field = delta.field as keyof typeof part
                const existing = part[field]
                if (typeof existing !== "string" && existing !== undefined) continue
                ;(part[field] as string) = (existing ?? "") + delta.delta
              }
            }),
          )
        }
      })
    })
    const flushSessionDeltas = (sessionID: string) => partDeltas.flush((entry) => entry.sessionID === sessionID)
    const flushMessageDeltas = (messageID: string) => partDeltas.flush((entry) => entry.messageID === messageID)
    const flushPartDeltas = (partID: string) => partDeltas.flush((entry) => entry.partID === partID)

    function sessionListQuery()`,
        },
        {
          name: "idle flushes session deltas",
          search: `        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)`,
          replace: `        case "session.status": {
          if (event.properties.status.type === "idle") flushSessionDeltas(event.properties.sessionID)
          setStore("session_status", event.properties.sessionID, event.properties.status)`,
        },
        {
          name: "message update flushes prior deltas",
          search: `        case "message.updated": {
          touchMessage(event.properties.info.sessionID, event.properties.info.id)`,
          replace: `        case "message.updated": {
          flushMessageDeltas(event.properties.info.id)
          touchMessage(event.properties.info.sessionID, event.properties.info.id)`,
        },
        {
          name: "message removal flushes prior deltas",
          search: `        case "message.removed": {
          touchMessage(event.properties.sessionID, event.properties.messageID)`,
          replace: `        case "message.removed": {
          flushMessageDeltas(event.properties.messageID)
          touchMessage(event.properties.sessionID, event.properties.messageID)`,
        },
        {
          name: "part update flushes prior deltas",
          search: `        case "message.part.updated": {
          touchPart(event.properties.part.sessionID, event.properties.part.id)`,
          replace: `        case "message.part.updated": {
          flushPartDeltas(event.properties.part.id)
          touchPart(event.properties.part.sessionID, event.properties.part.id)`,
        },
        {
          name: "coalesce provider deltas per frame",
          search: `        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }`,
          replace: `        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          partDeltas.queue({
            sessionID: event.properties.sessionID,
            messageID: event.properties.messageID,
            partID: event.properties.partID,
            field: event.properties.field,
            delta: event.properties.delta,
          })
          break
        }`,
        },
        {
          name: "part removal flushes prior deltas",
          search: `        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)`,
          replace: `        case "message.part.removed": {
          flushPartDeltas(event.properties.partID)
          touchPart(event.properties.sessionID, event.properties.partID)`,
        },
        {
          name: "dispose flushes pending deltas",
          search: `    })

    const exit = useExit()`,
          replace: `    })
    onCleanup(() => partDeltas.dispose())

    const exit = useExit()`,
        },
        {
          name: "public exact-data session flush",
          search: `      session: {
        get(sessionID: string) {`,
          replace: `      session: {
        flush(sessionID: string) {
          flushSessionDeltas(sessionID)
        },
        get(sessionID: string) {`,
        },
      ],
    },
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
          name: "bounded transcript constants",
          search: `export const alwaysSeparate = new WeakSet<BoxRenderable>()`,
          replace: `export const alwaysSeparate = new WeakSet<BoxRenderable>()

// OpenTUI's viewport culling skips painting off-screen children, but every
// Markdown/code/tool renderable remains mounted and laid out. A long session
// can therefore retain gigabytes of native render buffers. Keep authoritative
// sync data intact and mount history progressively; copy/export still consume
// the complete synced transcript.
const TRANSCRIPT_WINDOW_MESSAGES = 24
const TRANSCRIPT_REVEAL_MESSAGES = 20`,
        },
        {
          name: "copy last assistant flushes current frame",
          search: `      run: () => {
        const lastAssistantMessage = messagesBeforeRevert().findLast((message) => message.role === "assistant")`,
          replace: `      run: () => {
        sync.session.flush(route.sessionID)
        const lastAssistantMessage = messagesBeforeRevert().findLast((message) => message.role === "assistant")`,
        },
        {
          name: "copy transcript flushes current frame",
          search: `      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      run: async () => {
        try {
          const sessionData = session()`,
          replace: `      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      run: async () => {
        try {
          sync.session.flush(route.sessionID)
          const sessionData = session()`,
        },
        {
          name: "export transcript flushes current frame",
          search: `      title: "Export session transcript",
      value: "session.export",
      category: "Session",
      slash: {
        name: "export",
      },
      run: async () => {
        try {
          const sessionData = session()`,
          replace: `      title: "Export session transcript",
      value: "session.export",
      category: "Session",
      slash: {
        name: "export",
      },
      run: async () => {
        try {
          sync.session.flush(route.sessionID)
          const sessionData = session()`,
        },
        {
          name: "progressive transcript model",
          search: `  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const messagesBeforeRevert = () => {`,
          replace: `  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const [transcriptStart, setTranscriptStart] = createSignal(0)
  const [transcriptFollowTail, setTranscriptFollowTail] = createSignal(true)
  const transcriptMaximumStart = () => Math.max(0, messages().length - TRANSCRIPT_WINDOW_MESSAGES)
  const transcriptEnd = createMemo(() => Math.min(messages().length, transcriptStart() + TRANSCRIPT_WINDOW_MESSAGES))
  const transcriptMessages = createMemo(() => messages().slice(transcriptStart(), transcriptEnd()))
  const hiddenEarlierMessages = createMemo(() => transcriptStart())
  const hiddenLaterMessages = createMemo(() => Math.max(0, messages().length - transcriptEnd()))
  const visiblePending = () => {
    const value = pending()
    return value === undefined || value < transcriptStart() || value >= transcriptEnd()
      ? undefined
      : value - transcriptStart()
  }
  const visibleRevertMessageIndex = () => {
    const value = revertMessageIndex()
    return value < transcriptStart() || value >= transcriptEnd() ? -1 : value - transcriptStart()
  }
  const moveTranscriptWindow = (
    requested: number,
    anchor: "first" | "last" | undefined,
    after?: () => void,
  ) => {
    const next = Math.max(0, Math.min(transcriptMaximumStart(), requested))
    if (next === transcriptStart()) {
      after?.()
      return false
    }
    const anchorID = anchor === "first"
      ? transcriptMessages()[0]?.id
      : anchor === "last"
        ? transcriptMessages().at(-1)?.id
        : undefined
    const anchorY = anchorID ? scroll?.getRenderable(anchorID)?.y : undefined
    setTranscriptFollowTail(next === transcriptMaximumStart())
    setTranscriptStart(next)
    setTimeout(() => {
      if (anchorID && anchorY !== undefined && scroll && !scroll.isDestroyed) {
        const current = scroll.getRenderable(anchorID)
        if (current) scroll.scrollBy(current.y - anchorY)
      }
      after?.()
    }, 0)
    return true
  }
  const revealEarlierMessages = (count = TRANSCRIPT_REVEAL_MESSAGES, after?: () => void) =>
    moveTranscriptWindow(transcriptStart() - Math.max(1, count), "first", after)
  const revealLaterMessages = (count = TRANSCRIPT_REVEAL_MESSAGES, after?: () => void) =>
    moveTranscriptWindow(transcriptStart() + Math.max(1, count), "last", after)
  const revealMessage = (messageID: string, after: () => void) => {
    const index = messages().findIndex((message) => message.id === messageID)
    if (index === -1 || (index >= transcriptStart() && index < transcriptEnd())) return after()
    const centered = index - Math.floor(TRANSCRIPT_WINDOW_MESSAGES / 2)
    moveTranscriptWindow(centered, undefined, after)
  }
  const messagesBeforeRevert = () => {`,
        },
        {
          name: "progressive previous navigation",
          search: `  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {`,
          replace: `  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    if (direction === "prev" && scroll.scrollTop <= 0 && hiddenEarlierMessages() > 0) {
      revealEarlierMessages()
      dialog.clear()
      return
    }
    const targetID = findNextVisibleMessage(direction)

    if (!targetID && direction === "next" && hiddenLaterMessages() > 0) {
      revealLaterMessages()
      dialog.clear()
      return
    }
    if (!targetID) {`,
        },
        {
          name: "timeline reveals target history",
          search: `            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}`,
          replace: `            onMove={(messageID) => {
              revealMessage(messageID, () => {
                const child = scroll.getChildren().find((child) => child.id === messageID)
                if (child) scroll.scrollBy(child.y - scroll.y - 1)
              })
            }}`,
        },
        {
          name: "fork reveals target history",
          search: `            onMove={(messageID) => {
              if (!messageID) return
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}`,
          replace: `            onMove={(messageID) => {
              if (!messageID) return
              revealMessage(messageID, () => {
                const child = scroll.getChildren().find((child) => child.id === messageID)
                if (child) scroll.scrollBy(child.y - scroll.y - 1)
              })
            }}`,
        },
        {
          name: "last user command reveals hidden target",
          search: `          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }`,
          replace: `          if (hasValidTextPart) {
            revealMessage(message.id, () => {
              const child = scroll.getChildren().find((child) => child.id === message.id)
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            })
            break
          }`,
        },
        {
          name: "first command shifts bounded window",
          search: `      run: () => {
        scroll.scrollTo(0)
        dialog.clear()
      },`,
          replace: `      run: () => {
        moveTranscriptWindow(0, undefined, () => scroll.scrollTo(0))
        dialog.clear()
      },`
        },
        {
          name: "last command shifts bounded window",
          search: `      run: () => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },`,
          replace: `      run: () => {
        moveTranscriptWindow(transcriptMaximumStart(), undefined, () => scroll.scrollTo(scroll.scrollHeight))
        dialog.clear()
      },`
        },
        {
          name: "reset transcript window per session",
          search: `  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))`,
          replace: `  // Reset the bounded presentation window per session; authoritative sync
  // data remains complete and copy/export continue to use messages().
  createEffect(on(() => route.sessionID, () => {
    setTranscriptFollowTail(true)
    setTranscriptStart(transcriptMaximumStart())
    toBottom()
  }))
  createEffect(() => {
    const maximum = transcriptMaximumStart()
    setTranscriptStart((current) => transcriptFollowTail() ? maximum : Math.min(current, maximum))
  })`,
        },
        {
          name: "progressive transcript rendering",
          search: `                <box height={1} />
                <For each={messages()}>`,
          replace: `                <box height={1} />
                <Show when={hiddenEarlierMessages() > 0}>
                  <box
                    flexShrink={0}
                    paddingLeft={3}
                    paddingTop={1}
                    paddingBottom={1}
                    onMouseUp={() => revealEarlierMessages()}
                  >
                    <text fg={theme.textMuted}>
                      + {hiddenEarlierMessages()} earlier messages · click or move previous to load more
                    </text>
                  </box>
                </Show>
                <For each={transcriptMessages()}>`,
        },
        {
          name: "bounded later transcript control",
          search: `                </For>
              </scrollbox>`,
          replace: `                </For>
                <Show when={hiddenLaterMessages() > 0}>
                  <box
                    flexShrink={0}
                    paddingLeft={3}
                    paddingTop={1}
                    paddingBottom={1}
                    onMouseUp={() => revealLaterMessages()}
                  >
                    <text fg={theme.textMuted}>
                      + {hiddenLaterMessages()} later messages · click or move next to load more
                    </text>
                  </box>
                </Show>
              </scrollbox>`,
        },
        {
          name: "progressive revert index",
          search: `                        when={revert()?.messageID && revertMessageIndex() !== -1 && index() >= revertMessageIndex()}`,
          replace: `                        when={revert()?.messageID && visibleRevertMessageIndex() !== -1 && index() >= visibleRevertMessageIndex()}`,
        },
        {
          name: "progressive pending index",
          search: `                          pending={pending()}`,
          replace: `                          pending={visiblePending()}`,
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
      path: "packages/tui/src/prompt/history.tsx",
      beforeSha256: "ebf619998f067afd0d0c590b98366cb8bf87a527cd0ef366679ec883084def27",
      replacements: [
        {
          name: "externalized prompt history imports",
          search: `import { appendText, readText, writeText } from "../util/persistence"`,
          replace: `import { appendText, readText, writeText } from "../util/persistence"
import { externalizePromptHistoryEntry, hydratePromptHistoryEntry, prunePromptHistoryAttachments } from "./history-attachments"`,
        },
        {
          name: "externalized prompt history lifecycle",
          search: `    const historyPath = path.join(paths.state, "prompt-history.jsonl")
    onMount(async () => {
      const lines = parsePromptHistory(await readText(historyPath).catch(() => ""))
      setStore("history", lines)

      // Rewrite valid retained entries to self-heal corruption and enforce the limit.
      if (lines.length > 0)
        writeText(historyPath, lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n").catch(() => {})
    })`,
          replace: `    const historyPath = path.join(paths.state, "prompt-history.jsonl")
    let loadPromise = Promise.resolve()
    let appendQueue = Promise.resolve()
    onMount(() => {
      loadPromise = (async () => {
        const parsed = parsePromptHistory(await readText(historyPath).catch(() => ""))
        const lines: PromptInfo[] = []
        for (const line of parsed) lines.push(await externalizePromptHistoryEntry(line, paths.state))
        setStore("history", lines)

        // Rewrite valid retained entries to self-heal corruption, migrate inline
        // attachments to content-addressed files, and enforce the entry limit.
        if (lines.length > 0) await writeText(historyPath, lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n")
        await prunePromptHistoryAttachments(lines, paths.state)
      })().catch(() => undefined)
    })`,
        },
        {
          name: "hydrate one recalled prompt on demand",
          search: `      move(direction: 1 | -1, input: string) {`,
          replace: `      async move(direction: 1 | -1, input: string) {`,
        },
        {
          name: "hydrate selected prompt history entry",
          search: `        if (store.index === 0) return { input: "", parts: [] }
        return store.history.at(store.index)`,
          replace: `        if (store.index === 0) return { input: "", parts: [] }
        const selected = store.history.at(store.index)
        return selected ? hydratePromptHistoryEntry(selected, paths.state) : undefined`,
        },
        {
          name: "serialize prompt history attachment writes",
          search: `      append(item: PromptInfo) {
        const entry = structuredClone(unwrap(item))
        if (isDuplicateEntry(store.history.at(-1), entry)) {
          setStore("index", 0)
          return
        }
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.history.push(entry)
            if (draft.history.length > MAX_HISTORY_ENTRIES) {
              draft.history = draft.history.slice(-MAX_HISTORY_ENTRIES)
              trimmed = true
            }
            draft.index = 0
          }),
        )

        if (trimmed) {
          writeText(historyPath, store.history.map((line) => JSON.stringify(line)).join("\\n") + "\\n").catch(() => {})
          return
        }
        appendText(historyPath, JSON.stringify(entry) + "\\n").catch(() => {})
      },`,
          replace: `      append(item: PromptInfo) {
        // Capture a shallow immutable snapshot synchronously, then externalize
        // large data URLs in a serialized queue. The reactive store never owns
        // attachment bytes and rapid submissions retain their original order.
        const snapshot: PromptInfo = {
          input: item.input,
          mode: item.mode,
          parts: item.parts.map((part) => ({ ...unwrap(part) })),
        }
        appendQueue = appendQueue.then(async () => {
          await loadPromise
          const entry = await externalizePromptHistoryEntry(snapshot, paths.state)
          if (isDuplicateEntry(store.history.at(-1), entry)) {
            setStore("index", 0)
            return
          }
          let trimmed = false
          setStore(
            produce((draft) => {
              draft.history.push(entry)
              if (draft.history.length > MAX_HISTORY_ENTRIES) {
                draft.history = draft.history.slice(-MAX_HISTORY_ENTRIES)
                trimmed = true
              }
              draft.index = 0
            }),
          )

          if (trimmed) {
            await writeText(historyPath, store.history.map((line) => JSON.stringify(line)).join("\\n") + "\\n")
            await prunePromptHistoryAttachments(store.history, paths.state)
            return
          }
          await appendText(historyPath, JSON.stringify(entry) + "\\n")
        }).catch(() => undefined)
      },`,
        },
      ],
    },
    {
      path: "packages/tui/src/component/prompt/index.tsx",
      beforeSha256: "102d9496202bc720d6918268ad5594c386fe0330edf4c74cf27d34b21e048186",
      replacements: [
        {
          name: "await previous prompt history hydration",
          search: `          run() {
            if (input.cursorOffset !== 0) {`,
          replace: `          async run() {
            if (input.cursorOffset !== 0) {`,
        },
        {
          name: "await previous prompt history entry",
          search: `            const item = history.move(-1, input.plainText)`,
          replace: `            const item = await history.move(-1, input.plainText)`,
        },
        {
          name: "await next prompt history hydration",
          search: `          run() {
            if (input.cursorOffset !== input.plainText.length) {`,
          replace: `          async run() {
            if (input.cursorOffset !== input.plainText.length) {`,
        },
        {
          name: "await next prompt history entry",
          search: `            const item = history.move(1, input.plainText)`,
          replace: `            const item = await history.move(1, input.plainText)`,
        },
        {
          name: "session-scoped interrupt confirmation state",
          search: `  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({`,
          replace: `  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    placeholder: number
  }>({`,
        },
        {
          name: "remove timer-backed interrupt counter",
          search: `    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })`,
          replace: `    mode: "normal",
    extmarkToPartIndex: new Map(),
  })

  // Interrupt confirmation must belong to one concrete session and wall-clock
  // window. A delayed event loop can postpone timers for seconds; a component-
  // scoped counter would then leak an old Escape into a newly submitted run.
  const INTERRUPT_CONFIRM_MIN_MS = 180
  const INTERRUPT_CONFIRM_MAX_MS = 5_000
  let interruptArm: { sessionID: string; armedAt: number } | undefined
  const clearInterruptArm = () => { interruptArm = undefined }
  createEffect(on(() => props.sessionID, clearInterruptArm, { defer: true }))
  createEffect(() => {
    if (status().type === "idle") clearInterruptArm()
  })`,
        },
        {
          name: "session-scoped interrupt dispatch",
          search: `          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            void sdk.client.session.abort({
              sessionID: props.sessionID,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()`,
          replace: `          const sessionID = props.sessionID
          if (!sessionID) return

          const now = Date.now()
          const armed = interruptArm
          const elapsed = armed?.sessionID === sessionID ? now - armed.armedAt : Number.POSITIVE_INFINITY
          if (!armed || armed.sessionID !== sessionID || elapsed > INTERRUPT_CONFIRM_MAX_MS) {
            interruptArm = { sessionID, armedAt: now }
            dialog.clear()
            return
          }
          // Ignore duplicate dispatches from one physical key event. A deliberate
          // second Escape remains available after the short debounce boundary.
          if (elapsed < INTERRUPT_CONFIRM_MIN_MS) {
            dialog.clear()
            return
          }
          clearInterruptArm()
          void sdk.client.session.abort({ sessionID })
          dialog.clear()`,
        },
        {
          name: "new prompt clears stale interrupt confirmation",
          search: `  async function submit() {
    // Prevent overlapping invocations`,
          replace: `  async function submit() {
    clearInterruptArm()
    // Prevent overlapping invocations`,
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
        {
          name: "public deferred session draft api",
          search: `  route: {
    register: (routes: TuiRouteDefinition[]) => () => void
    navigate: (name: string, params?: Record<string, unknown>) => void
    readonly current: TuiRouteCurrent
  }
  ui: {`,
          replace: `  route: {
    register: (routes: TuiRouteDefinition[]) => () => void
    navigate: (name: string, params?: Record<string, unknown>) => void
    readonly current: TuiRouteCurrent
  }
  /** Prepare the native home prompt for a directory; no session exists until submit. */
  sessionDraft: {
    open: (directory: string) => void
  }
  ui: {`,
        },
        {
          // Declares the left layout column added to app.tsx below, so a
          // plugin can render a dock that pushes the app aside instead of
          // floating above it.
          name: "app_left slot type",
          search: `export type TuiHostSlotMap = {
  app: {}
  app_bottom: {}`,
          replace: `export type TuiHostSlotMap = {
  app: {}
  /** Left-hand layout column; content here pushes the app aside. */
  app_left: {}
  app_bottom: {}`,
        },
      ],
    },
    {
      path: "packages/opencode/src/plugin/tui/runtime.ts",
      beforeSha256: "f454bc0c2ec61d5cf605f4c65b2223692cd6731f501fd64a4a762a8868c69e70",
      replacements: [
        {
          name: "scoped deferred session draft forwarding",
          search: `    mode: createScopedMode(api.mode, scope),
    route,
    ui: api.ui,`,
          replace: `    mode: createScopedMode(api.mode, scope),
    route,
    sessionDraft: api.sessionDraft,
    ui: api.ui,`,
        },
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
      path: "packages/opencode/src/plugin/shared.ts",
      beforeSha256: "1ada9e15915e47bbb7b16436f0018c9b86845a66e687d89d037be896b9663140",
      replacements: [
        {
          name: "canonical Alonix deployment root resolver",
          search: `export async function resolvePluginTarget(spec: string) {
  if (isPathPluginSpec(spec)) return resolvePathPluginTarget(spec)
  const hit = parse(spec)
  const pkg = hit?.name && hit.raw === hit.name ? \`${"${hit.name}"}@latest\` : spec
  const result = await Npm.add(pkg)
  return result.directory
}`,
          replace: `async function canonicalAlonixTarget(spec: string) {
  const parsed = parsePluginSpecifier(spec)
  if (parsed.pkg !== "opencode-optimised-toolings") return
  try {
    const config = process.env.OPENCODE_CONFIG_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", ".config", "opencode")
    const record = await Bun.file(path.join(config, "alonix", "deployment.json")).json()
    const desired = record?.authority === "opencode-optimised-toolings-control-plane" ? record.desired : undefined
    if (desired?.package !== parsed.pkg || desired?.serverSpec !== spec || typeof desired?.root !== "string") return
    const root = path.resolve(desired.root)
    const [pkg, marker] = await Promise.all([
      Bun.file(path.join(root, "package.json")).json(),
      Bun.file(path.join(path.dirname(root), ".alonix-generation.json")).json(),
    ])
    if (pkg?.name !== parsed.pkg || pkg?.version !== desired.version) return
    if (marker?.fingerprint !== desired.fingerprint || marker?.version !== desired.version) return
    return root
  } catch {
    return
  }
}

export async function resolvePluginTarget(spec: string) {
  if (isPathPluginSpec(spec)) return resolvePathPluginTarget(spec)
  const canonical = await canonicalAlonixTarget(spec)
  if (canonical) return canonical
  const hit = parse(spec)
  const pkg = hit?.name && hit.raw === hit.name ? \`${"${hit.name}"}@latest\` : spec
  const result = await Npm.add(pkg)
  return result.directory
}`,
        },
      ],
    },
    {
      path: "packages/opencode/src/session/prompt.ts",
      beforeSha256: "79519fc90f6cac8ee992a7d772474e257758bcff44a2fe3b402bb1803ef72c3e",
      replacements: [
        {
          name: "orphaned unfinished tool recovery helper",
          search: `function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}`,
          replace: `function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

function recoverOrphanedToolParts(messages: SessionV1.WithParts[], now: number) {
  const recovered: SessionV1.ToolPart[] = []
  const next = messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "tool" || (part.state.status !== "pending" && part.state.status !== "running")) return part
      const state = part.state
      const updated = {
        ...part,
        state: {
          status: "error",
          error: "Tool execution interrupted before completion",
          input: state.input,
          metadata: {
            ...(state.status === "running" ? state.metadata : undefined),
            interrupted: true,
            recovered: true,
          },
          time: {
            start: state.status === "running" ? state.time.start : now,
            end: now,
          },
        },
      } satisfies SessionV1.ToolPart
      recovered.push(updated)
      return updated
    }),
  }))
  return { messages: next, recovered }
}`,
        },
        {
          name: "recover unfinished tools at new runner boundary",
          search: `          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)`,
          replace: `          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )

          // SessionRunState executes this effect only for a newly owning runner.
          // On its first iteration, unfinished persisted parts therefore belong to
          // a generation whose in-memory finalizer can no longer complete them.
          if (step === 0) {
            const recovery = recoverOrphanedToolParts(msgs, Date.now())
            if (recovery.recovered.length > 0) {
              yield* Effect.forEach(recovery.recovered, (part) => sessions.updatePart(part), {
                concurrency: "unbounded",
                discard: true,
              })
              yield* Effect.logWarning("recovered orphaned unfinished tools", {
                "session.id": sessionID,
                count: recovery.recovered.length,
                calls: recovery.recovered.map((part) => ({ tool: part.tool, callID: part.callID })),
              })
              msgs = recovery.messages
            }
          }

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)`,
        },
      ],
    },
    {
      path: "packages/opencode/src/config/tui.ts",
      beforeSha256: "7d7b30d41d5c04ea443819727490142406d293e031dcc221babeb3da1db3e902",
      replacements: [
        {
          name: "server package bridge import",
          search: `import { ConfigPlugin } from "@/config/plugin"
import { TuiKeybind } from "@opencode-ai/tui/config/keybind"`,
          replace: `import { ConfigPlugin } from "@/config/plugin"
import { parsePluginSpecifier } from "@/plugin/shared"
import { TuiKeybind } from "@opencode-ai/tui/config/keybind"`,
        },
        {
          name: "server package bridge loader",
          search: `  const mergeFile = (acc: Acc, file: string) =>
    Effect.gen(function* () {
      const data = yield* loadFile(file)`,
          replace: `  const mergeServerPackagePlugins = (acc: Acc, file: string) =>
    Effect.gen(function* () {
      const text = yield* afs.readFileStringSafe(file)
      if (!text) return
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: file, missing: "empty" }),
      )
      const raw = ConfigParse.jsonc(expanded, file)
      if (!isRecord(raw) || !Array.isArray(raw.plugin)) return
      const declared = raw.plugin
        .filter((item): item is ConfigPlugin.Origin["spec"] =>
          typeof item === "string" || (Array.isArray(item) && typeof item[0] === "string"),
        )
        .filter((item) => {
          const spec = ConfigPlugin.pluginSpecifier(item)
          const normalized = spec.replaceAll("\\\\", "/").replace(/\\\/$/, "")
          return parsePluginSpecifier(spec).pkg === "opencode-optimised-toolings"
            || normalized.endsWith("/opencode-optimised-toolings")
        })
      if (!declared.length) return
      const resolved = yield* Effect.forEach(declared, (item) =>
        Effect.promise(() => ConfigPlugin.resolvePluginSpec(item, file)),
      )
      const plugins = ConfigPlugin.deduplicatePluginOrigins([
        ...acc.plugin_origins,
        ...resolved.map((spec) => ({ spec, scope: pluginScope(file, ctx), source: file })),
      ])
      acc.result = { ...acc.result, plugin: plugins.map((item) => item.spec) }
      acc.plugin_origins = plugins
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("skipping invalid server package TUI bridge", {
          path: file,
          reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
        }).pipe(Effect.asVoid),
      ),
    )

  const mergeFile = (acc: Acc, file: string) =>
    Effect.gen(function* () {
      const data = yield* loadFile(file)`,
        },
        {
          name: "bridge global server package into TUI origins",
          search: `  // 2. Explicit OPENCODE_TUI_CONFIG override, if set.
  if (Flag.OPENCODE_TUI_CONFIG) {`,
          replace: `  // Packages that expose both ./server and ./tui may use one global
  // declaration. Alonix keeps its immutable generation and TUI entry internal.
  // Match the server config loader's explicit alternate-directory semantics,
  // while deduplicating the normal global directory when both resolve equally.
  const serverConfigDirectories = unique(
    [Global.Path.config, Flag.OPENCODE_CONFIG_DIR].filter((value): value is string => Boolean(value)),
  )
  for (const directory of serverConfigDirectories) {
    for (const file of ConfigPaths.fileInDirectory(directory, "opencode")) {
      yield* mergeServerPackagePlugins(acc, file)
    }
  }

  // 2. Explicit OPENCODE_TUI_CONFIG override, if set.
  if (Flag.OPENCODE_TUI_CONFIG) {`,
        },
      ],
    },
    {
      // A left dock must occupy layout space rather than float above the
      // transcript: an absolutely positioned panel covers the content it is
      // meant to sit beside. Wrapping the root in a row and giving plugins an
      // `app_left` slot lets the dock push the app aside, and collapse back to
      // nothing when it renders empty.
      path: "packages/tui/src/app.tsx",
      beforeSha256: "c0715487889226993d4d6f3938880aad999704ca89211dcd70cbf77ec5b1e3d7",
      replacements: [
        {
          name: "root row wrapper",
          search: `      <Show when={ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Switch>`,
          replace: `      <Show when={ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="row">
          <box flexShrink={0}>
            <pluginRuntime.Slot name="app_left" />
          </box>
          <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column">
          <Switch>`,
        },
        {
          name: "root row wrapper close",
          search: `          {plugin()}
        </box>
        <box flexShrink={0}>
          <pluginRuntime.Slot name="app_bottom" />
        </box>`,
          replace: `          {plugin()}
          </box>
        </box>
        <box flexShrink={0}>
          <pluginRuntime.Slot name="app_bottom" />
        </box>`,
        },
      ],
    },
    {
      path: "packages/tui/src/plugin/adapters.tsx",
      beforeSha256: "ecff9bb3a2d1acf0f4ee6d1dacf213ee059d88fa22cedced8cafa51dfb4eb353",
      replacements: [
        {
          name: "tool-renderers and session-draft imports",
          search: `export { createPluginRoutes, createTuiApi } from "./api"`,
          replace: `export { createPluginRoutes, createTuiApi } from "./api"
import { registerPluginToolRenderer } from "./tool-renderers"
import { setHomeSessionDestination } from "../routes/home/session-destination"`,
        },
        {
          name: "api.sessionDraft surface",
          search: `    route: {
      register(list) {
        return input.routes.register(list)
      },
      navigate(name, params) {
        routeNavigate(input.route, name, params)
      },
      get current() {
        return routeCurrent(input.route)
      },
    },
    ui: {`,
          replace: `    route: {
      register(list) {
        return input.routes.register(list)
      },
      navigate(name, params) {
        routeNavigate(input.route, name, params)
      },
      get current() {
        return routeCurrent(input.route)
      },
    },
    sessionDraft: {
      open(directory) {
        const target = directory.trim()
        if (!target) throw new Error("A directory is required to prepare a session draft")
        setHomeSessionDestination(target)
        routeNavigate(input.route, "home")
      },
    },
    ui: {`,
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
    {
      path: "packages/tui/src/routes/home/session-destination.tsx",
      beforeSha256: "6bd539d6ce6ece6bb0b5b94e186fe8b06ad06559fa97dae17ea52bf3f14ecc90",
      replacements: [
        {
          name: "session draft cleanup import",
          search: `  createMemo,
  createSignal,
  useContext,`,
          replace: `  createMemo,
  createSignal,
  onCleanup,
  useContext,`,
        },
        {
          name: "host-owned persistent home destination",
          search: `const HomeSessionDestinationContext = createContext<Context>()

export function HomeSessionDestinationProvider(props: ParentProps) {
  const sync = useSync()
  const paths = useTuiPaths()
  const [selected, setDestination] = createSignal<HomeSessionDestination>()`,
          replace: `const HomeSessionDestinationContext = createContext<Context>()
const [selected, setDestination] = createSignal<HomeSessionDestination>()

/** Prepare the native home prompt without creating a session. */
export function setHomeSessionDestination(directory: string) {
  const target = directory.trim()
  if (!target) throw new Error("A directory is required to prepare a session draft")
  setDestination({ type: "directory", directory: target, subdirectory: false })
}

export function HomeSessionDestinationProvider(props: ParentProps) {
  const sync = useSync()
  const paths = useTuiPaths()
  // A cancelled draft must not leak its folder into a later native New session.
  onCleanup(() => setDestination(undefined))`,
        },
      ],
    },
  ],
}
