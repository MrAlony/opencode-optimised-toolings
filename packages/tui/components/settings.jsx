/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { GLYPH } from "../lib/design.js"
import { TOOL_GROUPS, WEB_PROVIDERS } from "../lib/settings.js"
import { Button, SegmentedControl, TextInput, Toolbar } from "./controls.jsx"
import { SectionLabel } from "./ide-kit.jsx"
import { dockWidth } from "./dock.jsx"

const PERMISSION_OPTIONS = [
  { value: "inherit", label: "Inherit" },
  { value: "custom", label: "Custom" },
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "deny", label: "Deny" },
]

function ToggleRow(props) {
  return (
    <box flexDirection="row" flexShrink={0} height={1} gap={1} alignItems="center">
      <text fg={props.tokens.text} wrapMode="none" selectable={false}><b>{props.label}</b></text>
      <box flexGrow={1} />
      <SegmentedControl
        tokens={props.tokens}
        value={props.value ? "on" : "off"}
        onChange={(value) => props.onChange?.(value === "on")}
        items={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]}
      />
    </box>
  )
}

function PermissionRow(props) {
  return (
    <box flexDirection="row" flexShrink={0} minHeight={1} gap={1} alignItems="center">
      <text fg={props.tokens.text} width={31} wrapMode="none" selectable={false}>{props.name}</text>
      <SegmentedControl tokens={props.tokens} value={props.value} onChange={props.onChange} items={PERMISSION_OPTIONS} />
    </box>
  )
}

export function SettingsView(props) {
  const dimensions = useTerminalDimensions()
  const tokens = props.tokens
  const [draft, setDraft] = createSignal(structuredClone(props.initial))
  const [page, setPage] = createSignal("tools")
  const [saving, setSaving] = createSignal(false)
  const [message, setMessage] = createSignal("")
  const [secretInput, setSecretInput] = createSignal({})
  const [secretClear, setSecretClear] = createSignal({})
  const width = createMemo(() => {
    const reserved = props.dockOpen ? dockWidth(props.dockOpen(), dimensions().width) : 0
    return Math.max(48, dimensions().width - reserved)
  })
  const height = createMemo(() => Math.max(16, dimensions().height))

  const update = (path, value) => {
    const next = structuredClone(draft())
    let cursor = next
    for (const key of path.slice(0, -1)) cursor = cursor[key]
    cursor[path.at(-1)] = value
    setDraft(next)
  }

  const save = async () => {
    if (saving()) return
    setSaving(true)
    setMessage("Saving safely…")
    try {
      const web = {}
      for (const provider of WEB_PROVIDERS) {
        if (secretClear()[provider.id]) web[provider.id] = null
        else if (secretInput()[provider.id]) web[provider.id] = secretInput()[provider.id]
      }
      const result = await props.onSave?.({ ...draft(), web })
      setDraft(structuredClone(result ?? draft()))
      setSecretInput({})
      setSecretClear({})
      setMessage(result?.changed === false
        ? "Already saved. No files were rewritten."
        : "Saved. Restart OpenCode to activate config-time changes.")
    } catch (error) {
      setMessage(`Could not save: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <box width={width()} height={height()} flexDirection="column" backgroundColor={tokens().canvasOpaque ?? tokens().canvas}>
      <Toolbar tokens={tokens()} height={3}>
        <text fg={tokens().accent}>{GLYPH.diamond}</text>
        <text fg={tokens().text}><b>Alonix Settings</b></text>
        <text fg={tokens().faint}>Only Alonix-owned values are changed</text>
        <box flexGrow={1} />
        <Button tokens={tokens()} variant="primary" disabled={saving()} onPress={save}>{saving() ? "Saving…" : "Save changes"}</Button>
        <Button tokens={tokens()} variant="secondary" onPress={props.onClose}>Back</Button>
      </Toolbar>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box width={22} flexShrink={0} flexDirection="column" padding={1} gap={1} backgroundColor={tokens().panel}>
          <For each={[
            ["tools", "Tool access"], ["instructions", "Instructions"], ["dcp", "Context / DCP"], ["web", "Web providers"], ["about", "Plugin & safety"],
          ]}>
            {([value, label]) => <Button tokens={tokens()} width={20} variant={page() === value ? "primary" : "secondary"} onPress={() => setPage(value)}>{label}</Button>}
          </For>
          <box flexGrow={1} />
          <text fg={tokens().faint} wrapMode="wrap">Changes are staged to user config and take effect after restart.</text>
        </box>

        <scrollbox flexGrow={1} minWidth={40} padding={2} viewportCulling>
          <Show when={page() === "tools"}>
            <box flexDirection="column" gap={1}>
              <SectionLabel tokens={tokens()} title="TOOL ACCESS" meta="explicit permissions" />
              <text fg={tokens().muted} wrapMode="wrap">Choose Allow, Ask, Deny, or Inherit for each tool. Existing custom pattern rules remain untouched until you choose a simple value.</text>
              <For each={TOOL_GROUPS}>{(group) => (
                <box flexDirection="column" gap={1} marginTop={1}>
                  <text fg={tokens().accent}><b>{group.title}</b></text>
                  <text fg={tokens().faint} wrapMode="wrap">{group.description}</text>
                  <For each={group.tools}>{(tool) => (
                    <PermissionRow tokens={tokens()} name={tool} value={draft().tools[tool] ?? "inherit"} onChange={(value) => update(["tools", tool], value)} />
                  )}</For>
                </box>
              )}</For>
            </box>
          </Show>

          <Show when={page() === "instructions"}>
            <box flexDirection="column" gap={1}>
              <SectionLabel tokens={tokens()} title="OPTIMIZED INSTRUCTIONS" meta="owned and reversible" />
              <ToggleRow tokens={tokens()} label="Use Alonix operating instructions" value={draft().instructions.enabled} onChange={(value) => update(["instructions", "enabled"], value)} />
              <text fg={tokens().muted} wrapMode="wrap">Alonix places its exact optimized-tool profile between clearly named START / END markers inside <b>~/.config/opencode/AGENTS.md</b>. Every byte outside that owned block remains yours.</text>
              <text fg={tokens().faint} wrapMode="wrap">Turning this off removes only the marked Alonix block. Turning it back on restores the block without duplicating it.</text>
            </box>
          </Show>

          <Show when={page() === "dcp"}>
            <box flexDirection="column" gap={1}>
              <SectionLabel tokens={tokens()} title="DYNAMIC CONTEXT PRUNING" meta="optional companion" />
              <ToggleRow tokens={tokens()} label="Install / enable DCP" value={draft().dcp.installed} onChange={(value) => update(["dcp", "installed"], value)} />
              <ToggleRow tokens={tokens()} label="Notifications" value={draft().dcp.notifications} onChange={(value) => update(["dcp", "notifications"], value)} />
              <ToggleRow tokens={tokens()} label="Protect recent turns" value={draft().dcp.turnProtection} onChange={(value) => update(["dcp", "turnProtection"], value)} />
              <ToggleRow tokens={tokens()} label="Deduplicate context" value={draft().dcp.deduplication} onChange={(value) => update(["dcp", "deduplication"], value)} />
              <ToggleRow tokens={tokens()} label="Purge old errors" value={draft().dcp.purgeErrors} onChange={(value) => update(["dcp", "purgeErrors"], value)} />
              <TextInput tokens={tokens()} label="Minimum context limit" value={String(draft().dcp.minContextLimit)} hint="Keep percentages such as 50%, or use an absolute token count." onInput={(value) => update(["dcp", "minContextLimit"], value)} />
              <TextInput tokens={tokens()} label="Maximum context limit" value={String(draft().dcp.maxContextLimit)} hint="Keep percentages such as 60%, or use an absolute token count." onInput={(value) => update(["dcp", "maxContextLimit"], value)} />
              <text fg={tokens().faint} wrapMode="wrap">No model or provider preference is managed here. DCP remains optional and uses its own dcp.jsonc file.</text>
            </box>
          </Show>

          <Show when={page() === "web"}>
            <box flexDirection="column" gap={1}>
              <SectionLabel tokens={tokens()} title="WEB PROVIDER KEYS" meta="private user file" />
              <text fg={tokens().muted} wrapMode="wrap">Keys are never loaded back into this screen. A configured badge proves presence; enter a replacement or clear it. Environment variables continue to take priority.</text>
              <For each={WEB_PROVIDERS}>{(provider) => (
                <box flexDirection="column" gap={1} marginTop={1}>
                  <box flexDirection="row"><text fg={tokens().text}><b>{provider.label}</b></text><box flexGrow={1} /><text fg={draft().web[provider.id] && !secretClear()[provider.id] ? tokens().success : tokens().faint}>{draft().web[provider.id] && !secretClear()[provider.id] ? "configured" : "not configured"}</text></box>
                  <TextInput tokens={tokens()} value={secretInput()[provider.id] ?? ""} placeholder={`Paste a new ${provider.label} key`} onInput={(value) => setSecretInput({ ...secretInput(), [provider.id]: value })} />
                  <Button tokens={tokens()} variant="secondary" onPress={() => setSecretClear({ ...secretClear(), [provider.id]: true })}>Clear saved key</Button>
                </box>
              )}</For>
            </box>
          </Show>

          <Show when={page() === "about"}>
            <box flexDirection="column" gap={1}>
              <SectionLabel tokens={tokens()} title="PLUGIN & SAFETY" meta="npm-ready" />
              <text fg={tokens().text}><b>{draft().plugin.installed ? "Package entry detected" : "Local/development plugin source detected"}</b></text>
              <text fg={tokens().muted} wrapMode="wrap">Distribution package: <b>opencode-optimised-toolings@latest</b>. The plugin never manages personal models, provider definitions, accounts, or unrelated configuration.</text>
              <text fg={tokens().muted} wrapMode="wrap">Every save validates JSON/JSONC, creates timestamped backups, writes through atomic temporary files, and rolls back the transaction if any write fails.</text>
              <text fg={tokens().faint} wrapMode="wrap">Host enhancements are optional and capability-verified. Portable tools and settings remain available when a future OpenCode source release is not patch-compatible.</text>
            </box>
          </Show>
        </scrollbox>
      </box>

      <box flexShrink={0} minHeight={1} paddingLeft={2} paddingRight={2} backgroundColor={message().startsWith("Could not") ? tokens().errorSurface : tokens().raised}>
        <text fg={message().startsWith("Could not") ? tokens().error : tokens().muted} wrapMode="wrap">{message() || "Ready. No changes are written until Save changes is pressed."}</text>
      </box>
    </box>
  )
}
