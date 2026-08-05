/** @jsxImportSource @opentui/solid */
// Add a project.
//
// Two ways in, because neither alone is enough: type or paste a path when you
// know it, or click through directories when you do not. Adding a project just
// means preparing the native home prompt for that directory. OpenCode registers
// the project only after the first message creates the session, so this validates
// the directory and hands it to the caller without creating an empty chat.

import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { classifyKey, moveIndex } from "../lib/keys.js"
import { fit, fitLeft } from "../lib/layout.js"
import {
  baseName,
  breadcrumbs,
  browseModel,
  commonRoots,
  homeOf,
  joinPath,
  normalizePath,
  parentOf,
} from "../lib/browse.js"
import { Button, TextInput } from "./controls.jsx"
import { listDirectory as listSdkDirectory } from "../lib/sdk.js"
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
    const nodes = await listSdkDirectory(api?.client, normalized)
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
  const [pathDraft, setPathDraft] = createSignal(normalizePath(props.initialDirectory) || "")
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

  // Offer a shortcut only when the listing proves the folder exists, so the
  // picker never advertises a dead end.
  const [homeListing] = createResource(
    () => homeOf(props.initialDirectory) ?? homeOf(directory()),
    (home) => listDirectory(props.api, home),
  )

  const shortcuts = createMemo(() => {
    const home = homeOf(props.initialDirectory) ?? homeOf(directory())
    const existing = (homeListing()?.entries ?? [])
      .filter((entry) => entry.directory)
      .map((entry) => joinPath(home, entry.name))
    return commonRoots({ home, current: props.initialDirectory ?? directory(), existing })
  })

  const enter = (path) => {
    const next = normalizePath(path)
    if (!next) return
    setDirectory(next)
    setPathDraft(next)
    setTyped("")
    setIndex(0)
    setFailure("")
  }

  const goUp = () => {
    const parent = parentOf(directory())
    if (parent) enter(parent)
  }

  /** Adding prepares a directory-scoped draft; the caller owns navigation. */
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
  }

  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      gap={1}
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

      {/*
        Typing a path from memory is the worst way to choose a folder, so the
        usual destinations are one click away before any browsing starts.
      */}
      <Show when={shortcuts().length}>
        <box flexDirection="column" flexShrink={0} gap={1}>
          <text fg={tokens().faint} wrapMode="none" selectable={false}>
            JUMP TO
          </text>
          <box flexDirection="row" flexShrink={0} gap={1} flexWrap="wrap">
            <For each={shortcuts()}>
              {(root) => (
                <Button
                  tokens={tokens()}
                  variant={directory() === root.path ? "secondary" : "ghost"}
                  size="sm"
                  onPress={() => enter(root.path)}
                >
                  {root.name}
                </Button>
              )}
            </For>
          </box>
        </box>
      </Show>

      <box flexDirection="row" flexShrink={0} height={1} gap={1}>
        <Button
          tokens={tokens()}
          variant="secondary"
          size="sm"
          glyph={GLYPH.caretRight}
          onPress={goUp}
          disabled={!model().parent}
        >
          Up one level
        </Button>
        <For each={breadcrumbs(directory(), 4)}>
          {(crumb) => (
            <box
              flexShrink={0}
              onMouseUp={() => {
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

      <TextInput
        tokens={tokens()}
        label="Folder path"
        glyph={GLYPH.square}
        value={pathDraft()}
        placeholder="Paste or type a folder path"
        autoFocus
        onInput={setPathDraft}
        onSubmit={(value) => enter(value)}
        hint="Press Enter to open this path"
      />

      <TextInput
        tokens={tokens()}
        label="Filter folders"
        glyph={GLYPH.pointer}
        value={typed()}
        placeholder="Type part of a folder name"
        onInput={(value) => {
          setTyped(value)
          setIndex(0)
        }}
        onKeyDown={handleKey}
      />

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

      <box flexDirection="column" flexGrow={1} minHeight={8}>
        <SectionLabel tokens={tokens()} meta={`${model().entries.length} folders · scroll to browse`}>
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
          <scrollbox flexGrow={1} minHeight={8} stickyScroll={false}>
          <For each={model().entries}>
            {(entry, position) => (
              <box
                flexDirection="row"
                flexShrink={0}
                height={1}
                gap={1}
                paddingLeft={1}
                backgroundColor={position() === index() ? tokens().selectionStrong : undefined}
                onMouseUp={() => enter(entry.path)}
                onMouseMove={() => setIndex(position())}
                onMouseDown={() => setIndex(position())}
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
          </scrollbox>
        </Show>
      </box>

      <Rule tokens={tokens()} />

      <box flexDirection="row" flexShrink={0} height={3} gap={2} alignItems="center">
        <Button
          tokens={tokens()}
          variant="primary"
          size="lg"
          glyph={GLYPH.plus}
          description={model().alreadyAdded ? "This folder is already in your list" : "Adds it to your folders"}
          disabled={!model().canAdd || busy()}
          onPress={() => void add()}
        >
          {model().alreadyAdded ? "Already added" : `Use ${fit(baseName(directory()) || "this folder", 20)}`}
        </Button>
        <box flexDirection="column" flexGrow={1} minWidth={0}>
          <text fg={model().isProject ? tokens().success : tokens().muted} wrapMode="none" selectable={false}>
            {model().isProject ? `${GLYPH.ok} Project files detected` : "Any folder can be added"}
          </text>
          <text fg={tokens().faint} wrapMode="none" selectable={false}>
            The folder appears immediately; the chat is created after your first message.
          </text>
        </box>
        <Button tokens={tokens()} variant="ghost" onPress={() => props.onClose?.()}>
          Cancel
        </Button>
      </box>

      <KeyHints tokens={tokens()} hints={HINTS} />
    </box>
  )
}
