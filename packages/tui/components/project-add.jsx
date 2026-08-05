/** @jsxImportSource @opentui/solid */
// Add a project.
//
// Two ways in, because neither alone is enough: type or paste a path when you
// know it, or click through directories when you do not. Adding a project just
// means starting a session in that directory - OpenCode registers the project
// on first use - so this validates the directory and hands it to the caller.

import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { applyKeyToQuery, classifyKey, moveIndex } from "../lib/keys.js"
import { fit, fitLeft } from "../lib/layout.js"
import { baseName, breadcrumbs, browseModel, joinPath, normalizePath, parentOf } from "../lib/browse.js"
import { Button } from "./controls.jsx"
import { EmptyState, KeyHints, Rule, SectionLabel, Spinner } from "./ide-kit.jsx"

const HINTS = [
  { key: "↑↓", label: "move" },
  { key: "↵", label: "enter folder" },
  { key: "click", label: "open" },
  { key: "esc", label: "cancel" },
]

/** Directory markers that identify a project root without a second request. */
const MARKERS = new Set([
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
  "CMakeLists.txt",
  "Makefile",
])

/**
 * Normalise a host file listing.
 *
 * The shape has varied across host versions, so both `type: "directory"` and a
 * boolean `directory` are accepted rather than assuming one.
 */
function toEntries(nodes) {
  return Array.from(nodes ?? [])
    .map((node) => {
      if (!node || typeof node !== "object") return null
      const name = String(node.name ?? baseName(node.path ?? "") ?? "")
      if (!name) return null
      const isDirectory = node.type === "directory" || node.directory === true || node.isDirectory === true
      return { name, directory: isDirectory }
    })
    .filter(Boolean)
}

async function listDirectory(api, directory) {
  const normalized = normalizePath(directory)
  if (!normalized) return { entries: [], error: "" }
  try {
    const result = await api?.client?.file?.list?.({ query: { path: normalized, directory: normalized } })
    const nodes = Array.isArray(result?.data) ? result.data : []
    const entries = toEntries(nodes)
    const names = new Set(entries.map((entry) => entry.name))
    return {
      // A directory containing a project marker is worth highlighting.
      entries: entries.map((entry) => ({ ...entry, project: false })),
      isProject: [...MARKERS].some((marker) => names.has(marker)),
      error: "",
    }
  } catch (error) {
    return { entries: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export function ProjectAdd(props) {
  const tokens = props.tokens
  const [directory, setDirectory] = createSignal(normalizePath(props.initialDirectory) || "")
  const [typed, setTyped] = createSignal("")
  const [index, setIndex] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal("")

  const [listing] = createResource(directory, (dir) => listDirectory(props.api, dir))

  const known = createMemo(() => (props.projects?.() ?? []).map((project) => project.worktree))

  const model = createMemo(() =>
    browseModel({
      directory: directory(),
      entries: listing()?.entries ?? [],
      knownProjects: known(),
      isProject: listing()?.isProject === true,
      query: typed(),
    }),
  )

  createEffect(() => {
    const size = model().entries.length
    if (index() > Math.max(0, size - 1)) setIndex(Math.max(0, size - 1))
  })

  const width = () => Math.max(30, Number(props.width) || 90)

  const enter = (path) => {
    const next = normalizePath(path)
    if (!next) return
    setDirectory(next)
    setTyped("")
    setIndex(0)
    setFailure("")
  }

  const goUp = () => {
    const parent = parentOf(directory())
    if (parent) enter(parent)
  }

  /** Adding is really "start working here"; the caller owns that. */
  const add = async (path) => {
    const target = normalizePath(path ?? directory())
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
    if (action === "dismiss") {
      props.onClose?.()
      return
    }
    if (action === "confirm") {
      const entry = model().entries[index()]
      if (entry) enter(entry.path)
      else if (model().canAdd) void add()
      return
    }
    if (action === "left") {
      goUp()
      return
    }
    if (["up", "down", "page-up", "page-down", "first", "last"].includes(action)) {
      setIndex((current) => moveIndex(current, model().entries.length, action, 10))
      return
    }
    const next = applyKeyToQuery(typed(), event)
    if (next !== typed()) {
      setTyped(next)
      setIndex(0)
    }
  }

  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      gap={1}
      focusable
      focused
      onKeyDown={handleKey}
    >
      <box flexDirection="row" flexShrink={0} height={1} gap={1}>
        <text fg={tokens().accent} wrapMode="none" selectable={false}>
          {GLYPH.plus}
        </text>
        <text fg={tokens().text} wrapMode="none" selectable={false}>
          <b>Add a project</b>
        </text>
        <text fg={tokens().faint} wrapMode="none" selectable={false}>
          pick a folder to work in
        </text>
        <box flexGrow={1} />
        <Show when={listing.loading || busy()}>
          <Spinner tokens={tokens()} tone="accent" />
        </Show>
      </box>

      <box flexDirection="row" flexShrink={0} height={1} gap={1}>
        <Button tokens={tokens()} glyph={GLYPH.caretRight} onPress={goUp} disabled={!model().parent}>
          Up
        </Button>
        <For each={breadcrumbs(directory(), 4)}>
          {(crumb) => (
            <box
              flexShrink={0}
              onMouseDown={() => {
                if (crumb.path) enter(crumb.path)
              }}
            >
              <text fg={crumb.path ? tokens().muted : tokens().faint} wrapMode="none" selectable={false}>
                {crumb.name}
              </text>
            </box>
          )}
        </For>
      </box>

      <box flexDirection="row" flexShrink={0} height={1} backgroundColor={tokens().surface} paddingLeft={1}>
        <text wrapMode="none" selectable={false}>
          <span style={{ fg: tokens().faint }}>{typed() ? "filter " : "path "}</span>
          <span style={{ fg: tokens().text }}>
            {typed() || fitLeft(directory() || "(no directory)", width() - 10)}
          </span>
        </text>
      </box>

      <Show when={listing()?.error}>
        <text fg={tokens().error} wrapMode="wrap" selectable={false}>
          {fit(listing().error, width() * 2)}
        </text>
      </Show>
      <Show when={failure()}>
        <text fg={tokens().error} wrapMode="wrap" selectable={false}>
          {fit(failure(), width() * 2)}
        </text>
      </Show>

      <box flexDirection="column" flexShrink={0}>
        <SectionLabel tokens={tokens()} meta={String(model().entries.length)}>
          Folders
        </SectionLabel>
        <Show
          when={model().entries.length}
          fallback={
            <EmptyState
              tokens={tokens()}
              title={listing.loading ? "Reading folder…" : "No folders here"}
              hint="You can still add this folder itself"
            />
          }
        >
          <For each={model().entries.slice(0, 12)}>
            {(entry, position) => (
              <box
                flexDirection="row"
                flexShrink={0}
                height={1}
                gap={1}
                paddingLeft={1}
                backgroundColor={position() === index() ? tokens().selectionStrong : undefined}
                onMouseDown={() => enter(entry.path)}
                onMouseOver={() => setIndex(position())}
              >
                <text fg={entry.added ? tokens().success : tokens().faint} wrapMode="none" selectable={false}>
                  {entry.added ? GLYPH.ok : GLYPH.caretRight}
                </text>
                <text fg={tokens().text} wrapMode="none" selectable={false}>
                  {fit(entry.name, width() - 22)}
                </text>
                <box flexGrow={1} />
                <Show when={entry.added}>
                  <text fg={tokens().faint} wrapMode="none" selectable={false}>
                    already added
                  </text>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </box>

      <Rule tokens={tokens()} />

      <box flexDirection="row" flexShrink={0} height={1} gap={2}>
        <Button
          tokens={tokens()}
          tone="accent"
          primary
          glyph={GLYPH.plus}
          disabled={!model().canAdd || busy()}
          onPress={() => void add()}
        >
          {model().alreadyAdded ? "Already added" : `Work in ${fit(baseName(directory()) || "this folder", 24)}`}
        </Button>
        <Button tokens={tokens()} onPress={() => props.onClose?.()}>
          Cancel
        </Button>
      </box>

      <KeyHints tokens={tokens()} hints={HINTS} />
    </box>
  )
}
