/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"

const total = 100
const windowSize = 24
const step = 20
const textPayload = "x".repeat(20_000)
const inlineAttachment = `data:image/png;base64,${"A".repeat(1_500_000)}`
const messages = Array.from({ length: total }, (_, index) => ({
  id: `message-${index + 1}`,
  text: `${index + 1}:${textPayload}`,
  attachment: index === 82 || index === 91 ? inlineAttachment : undefined,
}))
const [start, setStart] = createSignal(total - windowSize)
const [pulse, setPulse] = createSignal(0)
const shiftEarlier = () => setStart((value) => Math.max(0, value - step))
const shiftLater = () => setStart((value) => Math.min(total - windowSize, value + step))

function App() {
  const end = createMemo(() => Math.min(total, start() + windowSize))
  const visible = createMemo(() => messages.slice(start(), end()))
  return (
    <box flexDirection="column" width={100} height={40}>
      <text id="prompt-surface">prompt-surface-ready</text>
      <scrollbox flexGrow={1} stickyScroll={false}>
        <Show when={start() > 0}>
          <text id="earlier-control">+ {start()} earlier messages</text>
        </Show>
        <For each={visible()}>
          {(message) => (
            <box id={message.id} flexDirection="column">
              <text>{message.text}</text>
              <Show when={message.attachment}>
                <text id={`${message.id}-attachment`}>attachment.png</text>
              </Show>
            </box>
          )}
        </For>
        <Show when={end() < total}>
          <text id="later-control">+ {total - end()} later messages</text>
        </Show>
      </scrollbox>
      <text id="plugin-surface">plugin-surface-ready-{pulse()}</text>
    </box>
  )
}

const before = process.memoryUsage().rss
const started = performance.now()
const setup = await testRender(() => <App />, { width: 100, height: 40 })
const mounted = performance.now() - started
const render = async () => {
  await new Promise((resolve) => setTimeout(resolve, 10))
  await setup.renderOnce()
}
await render()
const mountedIDs = () => {
  const ids: string[] = []
  const visit = (node: any) => {
    if (!node) return
    if (node.id) ids.push(node.id)
    for (const child of node.getChildren?.() ?? node.children ?? []) visit(child)
  }
  visit(setup.renderer.root)
  return ids
}
const snapshot = () => {
  const ids = mountedIDs()
  const current = messages.slice(start(), Math.min(total, start() + windowSize))
  return {
    prompt: ids.includes("prompt-surface"),
    plugin: ids.includes("plugin-surface"),
    earlier: start() > 0,
    later: start() + windowSize < total,
    count: current.length,
    first: current[0]?.id,
    last: current.at(-1)?.id,
  }
}
const snapshots = [snapshot()]
for (let index = 0; index < 5; index++) {
  shiftEarlier()
  setPulse(index + 1)
  await render()
  snapshots.push(snapshot())
}
for (let index = 0; index < 5; index++) {
  shiftLater()
  setPulse(index + 6)
  await render()
  snapshots.push(snapshot())
}
const after = process.memoryUsage().rss
const output = {
  mounted,
  rssDelta: after - before,
  snapshots,
  maxMounted: Math.max(...snapshots.map((item) => item.count)),
  siblingSurvival: snapshots.every((item) => item.prompt && item.plugin),
}
setup.renderer.destroy()
console.log(JSON.stringify(output))
