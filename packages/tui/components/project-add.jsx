/** @jsxImportSource @opentui/solid */
// Fast, bounded folder picker for adding a project.
//
// Directory reads are cached and stale requests cannot overwrite the current
// location. Listings are indexed/sorted once, filtering is deferred, and only
// the visible rows are mounted. This keeps pointer and keyboard interaction
// responsive even for directories containing thousands of children.

import { useTerminalDimensions } from "@opentui/solid"
import { readdir } from "node:fs/promises"
import { createDeferred, createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { classifyKey, moveIndex } from "../lib/keys.js"
import { fit, fitLeft } from "../lib/layout.js"
import {
  baseName,
  browseModel,
  commonRoots,
  createDirectoryCache,
  folderIndex,
  folderWindow,
  homeOf,
  joinPath,
  normalizePath,
  parentOf,
} from "../lib/browse.js"
import { Button, TextInput } from "./controls.jsx"
import { listDirectory as listSdkDirectory } from "../lib/sdk.js"
import { EmptyState, SectionLabel, Spinner } from "./ide-kit.jsx"

const EMPTY_LISTING = Object.freeze({ directory: "", entries: [], isProject: false, error: "" })
const MARKERS = new Set([
  ".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml",
  "build.gradle", "Gemfile", "composer.json", "CMakeLists.txt", "Makefile",
])

function toEntries(nodes) {
  return Array.from(nodes ?? [])
    .map((node) => {
      if (!node || typeof node !== "object") return null
      const name = String(node.name ?? baseName(node.path ?? "") ?? "")
      if (!name) return null
      const directory = node.type === "directory" || node.directory === true || node.isDirectory === true
      return { name, directory }
    })
    .filter(Boolean)
}

async function nativeDirectory(directory) {
  const nodes = await readdir(directory, { withFileTypes: true })
  const names = new Set()
  const entries = []
  for (const node of nodes) {
    names.add(node.name)
    if (node.isDirectory()) entries.push({ name: node.name, directory: true })
  }
  return { entries, isProject: [...MARKERS].some((marker) => names.has(marker)) }
}

async function sdkDirectory(api, directory) {
  const entries = toEntries(await listSdkDirectory(api?.client, directory))
  const names = new Set(entries.map((entry) => entry.name))
  return { entries, isProject: [...MARKERS].some((marker) => names.has(marker)) }
}

async function listDirectory(api, directory) {
  const normalized = normalizePath(directory)
  if (!normalized) return { directory: normalized, entries: [], isProject: false, source: "native", error: "" }
  try {
    const result = await nativeDirectory(normalized)
    return { directory: normalized, ...result, source: "native", error: "" }
  } catch (nativeError) {
    try {
      const result = await sdkDirectory(api, normalized)
      return { directory: normalized, ...result, source: "sdk", error: "" }
    } catch (sdkError) {
      const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError)
      const sdkMessage = sdkError instanceof Error ? sdkError.message : String(sdkError)
      return {
        directory: normalized,
        entries: [],
        isProject: false,
        source: "unavailable",
        error: sdkMessage || nativeMessage,
      }
    }
  }
}

export function ProjectAdd(props) {
  const tokens = props.tokens
  const dimensions = useTerminalDimensions()
  const initial = normalizePath(props.initialDirectory) || ""
  const [directory, setDirectory] = createSignal(initial)
  const [pathDraft, setPathDraft] = createSignal(initial)
  const [query, setQuery] = createSignal("")
  const [showHidden, setShowHidden] = createSignal(false)
  const [index, setIndex] = createSignal(0)
  const [listing, setListing] = createSignal(EMPTY_LISTING)
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal("")
  const [reload, setReload] = createSignal(0)
  const [history, setHistory] = createSignal(initial ? [initial] : [])
  const [historyIndex, setHistoryIndex] = createSignal(initial ? 0 : -1)
  const deferredQuery = createDeferred(query, { timeoutMs: 75 })
  const cache = createDirectoryCache((target) => listDirectory(props.api, target), {
    limit: 40,
    ttlMs: 120_000,
    errorTtlMs: 1_000,
  })
  let request = 0

  createEffect(() => {
    const target = directory()
    reload()
    const owner = ++request
    setLoading(true)
    setFailure("")
    void cache.get(target).then((result) => {
      if (owner !== request) return
      setListing(result)
    }).catch((error) => {
      if (owner !== request) return
      setListing({ directory: target, entries: [], isProject: false, error: error instanceof Error ? error.message : String(error) })
    }).finally(() => {
      if (owner === request) setLoading(false)
    })
  })
  onCleanup(() => { request += 1; cache.clear() })

  const currentListing = createMemo(() => listing().directory === directory() ? listing() : EMPTY_LISTING)
  const listingSource = createMemo(() => currentListing().source === "sdk" ? "compatibility mode" : "local filesystem")
  const indexedEntries = createMemo(() => folderIndex(currentListing().entries))
  const known = createMemo(() => (props.projects?.() ?? []).map((project) => project.worktree))
  const model = createMemo(() => browseModel({
    directory: directory(),
    entries: indexedEntries(),
    indexed: true,
    knownProjects: known(),
    isProject: currentListing().isProject,
    query: deferredQuery(),
    showHidden: showHidden(),
  }))

  createEffect(() => {
    const size = model().entries.length
    if (!size) setIndex(0)
    else if (index() >= size) setIndex(size - 1)
  })

  const width = () => Math.max(36, Number(props.width) || 84)
  const panelHeight = createMemo(() => Math.max(13, Math.floor(dimensions().height * 0.75) - 2))
  const compact = createMemo(() => panelHeight() < 25 || width() < 66)
  const listHeight = createMemo(() => Math.max(4, Math.min(18, panelHeight() - (compact() ? 9 : 15))))
  const visible = createMemo(() => folderWindow(model().entries, index(), listHeight()))
  const currentName = createMemo(() => baseName(directory()) || directory() || "folder")

  const shortcuts = createMemo(() => commonRoots({
    home: homeOf(props.initialDirectory) ?? homeOf(directory()),
    current: props.initialDirectory ?? directory(),
  }).slice(0, compact() ? 2 : 5))

  const enter = (value, options = {}) => {
    const next = normalizePath(value)
    if (!next || next === directory()) return
    if (options.history !== false) {
      const prior = history().slice(0, historyIndex() + 1)
      setHistory([...prior, next].slice(-32))
      setHistoryIndex(Math.min(31, prior.length))
    }
    setDirectory(next)
    setPathDraft(next)
    setQuery("")
    setIndex(0)
    setFailure("")
  }

  const goBack = () => {
    if (historyIndex() <= 0) return
    const nextIndex = historyIndex() - 1
    setHistoryIndex(nextIndex)
    enter(history()[nextIndex], { history: false })
  }

  const goUp = () => {
    const parent = parentOf(directory())
    if (parent) enter(parent)
  }

  const refresh = () => {
    cache.invalidate(directory())
    setReload((value) => value + 1)
  }

  const add = async () => {
    const target = normalizePath(directory())
    if (!target || busy()) return
    setBusy(true)
    setFailure("")
    try {
      await props.onAdd?.(target)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleKey = (event) => {
    const action = classifyKey(event)
    if (action === "dismiss") return props.onClose?.()
    if (action === "confirm") {
      const entry = model().entries[index()]
      if (entry) enter(entry.path)
      else if (model().canAdd) void add()
      return
    }
    if (action === "left") return goUp()
    if (["up", "down", "page-up", "page-down", "first", "last"].includes(action)) {
      event?.preventDefault?.()
      setIndex((current) => moveIndex(current, model().entries.length, action, listHeight()))
    }
  }

  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      gap={1}
      height={panelHeight()}
      maxHeight={panelHeight()}
      overflow="hidden"
    >
      <box flexDirection="row" flexShrink={0} height={1} gap={1}>
        <text fg={tokens().accent} wrapMode="none">{GLYPH.plus}</text>
        <text fg={tokens().text} wrapMode="none"><b>Add folder</b></text>
        <text fg={tokens().faint} wrapMode="none">{compact() ? "" : "Choose where a new chat belongs"}</text>
        <box flexGrow={1} />
        <Show when={loading() || busy()}><Spinner tokens={tokens()} tone="accent" /></Show>
      </box>

      <Show when={!compact() && shortcuts().length}>
        <box flexDirection="row" flexShrink={0} height={1} gap={1} overflow="hidden">
          <text fg={tokens().faint} wrapMode="none">QUICK</text>
          <For each={shortcuts()}>{(root) => (
            <Button tokens={tokens()} variant={directory() === root.path ? "secondary" : "ghost"} size="sm" onPress={() => enter(root.path)}>
              {root.name}
            </Button>
          )}</For>
        </box>
      </Show>

      <box flexDirection="row" flexShrink={0} height={1} gap={1} overflow="hidden">
        <Button tokens={tokens()} variant="secondary" size="sm" disabled={historyIndex() <= 0} onPress={goBack}>Back</Button>
        <Button tokens={tokens()} variant="secondary" size="sm" disabled={!model().parent} onPress={goUp}>Up</Button>
        <Button tokens={tokens()} variant="ghost" size="sm" onPress={refresh}>Refresh</Button>
        <Button tokens={tokens()} variant={showHidden() ? "secondary" : "ghost"} size="sm" onPress={() => { setShowHidden((value) => !value); setIndex(0) }}>
          {showHidden() ? "Hide system" : "Show hidden"}
        </Button>
        <box flexGrow={1} />
        <text fg={tokens().muted} wrapMode="none">{fitLeft(directory(), Math.max(12, width() - 40))}</text>
      </box>

      <Show when={!compact()}>
        <TextInput
          tokens={tokens()}
          glyph={GLYPH.square}
          value={pathDraft()}
          placeholder="Paste a folder path and press Enter"
          autoFocus
          onInput={setPathDraft}
          onSubmit={enter}
        />
      </Show>

      <TextInput
        tokens={tokens()}
        glyph={GLYPH.pointer}
        value={query()}
        placeholder="Filter folders"
        autoFocus={compact()}
        onInput={(value) => { setQuery(value); setIndex(0) }}
        onKeyDown={handleKey}
      />

      <Show when={currentListing().error || failure()}>
        <box flexDirection="row" flexShrink={0} height={1} gap={1}>
          <text fg={tokens().error} wrapMode="none">{fit(failure() || currentListing().error, width() - 12)}</text>
          <Button tokens={tokens()} variant="secondary" size="sm" onPress={refresh}>Try again</Button>
        </box>
      </Show>

      <box flexDirection="column" flexShrink={0} height={listHeight() + 1} minHeight={5} overflow="hidden">
        <SectionLabel
          tokens={tokens()}
          meta={model().entries.length ? `${visible().start + 1}-${visible().end} of ${model().entries.length} · ${listingSource()}` : loading() ? "reading local filesystem…" : "0 folders"}
        >
          {currentName()}
        </SectionLabel>
        <Show when={model().entries.length} fallback={
          <EmptyState
            tokens={tokens()}
            title={loading() ? "Reading this folder…" : query() ? "No matching folders" : "No folders inside"}
            hint={loading() ? "You can keep typing while it loads" : "You can still use the current folder"}
          />
        }>
          <box
            flexDirection="column"
            flexShrink={0}
            height={listHeight()}
            overflow="hidden"
            focusable
            onKeyDown={handleKey}
            onMouseScroll={(event) => {
              event?.preventDefault?.()
              event?.stopPropagation?.()
              const direction = event?.scroll?.direction
              if (direction !== "up" && direction !== "down") return
              const step = Math.max(1, Math.min(5, Math.round(Number(event?.scroll?.delta) || 3)))
              setIndex((current) => direction === "down"
                ? Math.min(model().entries.length - 1, current + step)
                : Math.max(0, current - step))
            }}
          >
            <For each={visible().entries}>{(entry, position) => {
              const absolute = () => visible().start + position()
              const selected = () => absolute() === index()
              return (
                <box
                  flexDirection="row"
                  flexShrink={0}
                  height={1}
                  width="100%"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={selected() ? tokens().selectionStrong : undefined}
                  focusable
                  onMouseUp={() => enter(entry.path)}
                  onMouseMove={() => { const next = absolute(); if (next !== index()) setIndex(next) }}
                  onKeyDown={(event) => {
                    const name = String(event?.name ?? "").toLowerCase()
                    if (name === "enter" || name === "return" || name === "space") enter(entry.path)
                    else handleKey(event)
                  }}
                >
                  <text fg={entry.added ? tokens().success : selected() ? tokens().accent : tokens().faint} wrapMode="none">
                    {entry.added ? GLYPH.ok : GLYPH.caretRight}
                  </text>
                  <text fg={tokens().text} wrapMode="none">{fit(entry.name, width() - 23)}</text>
                  <box flexGrow={1} />
                  <Show when={entry.added}><text fg={tokens().faint} wrapMode="none">added</text></Show>
                </box>
              )
            }}</For>
          </box>
        </Show>
      </box>

      <box flexDirection="row" flexShrink={0} height={compact() ? 1 : 3} gap={1} alignItems="center">
        <Button
          tokens={tokens()}
          variant="primary"
          size={compact() ? "sm" : "lg"}
          glyph={GLYPH.plus}
          disabled={!model().canAdd || busy()}
          onPress={() => void add()}
        >
          {model().alreadyAdded ? "Already added" : `Use ${fit(currentName(), 22)}`}
        </Button>
        <Show when={!compact()}>
          <box flexDirection="column" flexGrow={1} minWidth={0}>
            <text fg={model().isProject ? tokens().success : tokens().muted} wrapMode="none">
              {model().isProject ? `${GLYPH.ok} Project files detected` : "Any folder can be used"}
            </text>
            <text fg={tokens().faint} wrapMode="none">The chat is created only after your first message.</text>
          </box>
        </Show>
        <Button tokens={tokens()} variant="ghost" size={compact() ? "sm" : "md"} onPress={() => props.onClose?.()}>Cancel</Button>
      </box>
    </box>
  )
}
