import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function source(relative) {
  return await readFile(path.join(packageRoot, relative), "utf8")
}

const COMPONENTS = [
  "components/workbench.jsx",
  "components/operations.jsx",
  "components/monitor.jsx",
  "components/session-rail.jsx",
  "components/dock.jsx",
  "components/palette.jsx",
  "components/project-add.jsx",
  "components/controls.jsx",
  "components/ide-surfaces.jsx",
  "components/ide-kit.jsx",
  "components/settings.jsx",
]

// Regression: the workbench crashed with
//   props.tick is not a function (props.tick is an instance of Object)
// because `createClock` returns a controller object, not a tick function, and
// it was passed down as a prop and then invoked.
test("createClock exposes a controller object, not a callable tick", async () => {
  const runtime = await source("components/runtime.jsx")
  const returned = /export function createClock[\s\S]*?return \{([\s\S]*?)\n\}/.exec(runtime)
  assert.ok(returned, "createClock must return an object literal")
  for (const key of ["elapsed", "enabled", "subscribe"]) {
    assert.match(returned[1], new RegExp(`\\b${key}\\b`), `the clock controller must expose ${key}`)
  }
})

test("no component invokes the clock controller as a function", async () => {
  for (const file of COMPONENTS) {
    const text = await source(file)
    // A prop holding the controller must never be called directly.
    assert.ok(
      !/props\.(tick|clock)\s*\??\.\(\)/.test(text),
      `${file}: the clock controller is an object and must not be invoked as a function`,
    )
  }
})

test("components read elapsed time through useClock", async () => {
  // These surfaces animate or poll live state, so they must subscribe properly
  // rather than receiving a tick through props.
  for (const file of ["components/operations.jsx", "components/monitor.jsx", "components/session-rail.jsx"]) {
    const text = await source(file)
    assert.match(text, /useClock\(/, `${file} must subscribe through useClock`)
  }
})

test("the dock occupies a left layout column on every screen", async () => {
  const entry = await source("index.tsx")
  const slot = /\n        app_left\(\) \{[\s\S]*?\n        \},/.exec(entry)
  assert.ok(slot, "the plugin must render into the app_left layout column")
  assert.match(slot[0], /<Dock/, "projects and sessions must be present on the home screen and in sessions")
})

// Regression: an absolutely positioned dock floated above the transcript and
// covered the content it was meant to sit beside.
test("the dock is a layout column, not an overlay", async () => {
  const text = await source("components/dock.jsx")
  assert.ok(
    !/position="absolute"/.test(text),
    "the dock must take layout space so showing it pushes the app aside",
  )
})

test("the session sidebar does not duplicate the dock's project list", async () => {
  const entry = await source("index.tsx")
  const slot = /sidebar_content\([\s\S]*?\n        \},/.exec(entry)
  assert.ok(slot, "the plugin still registers sidebar_content")
  assert.ok(
    !/<ExplorerPanel/.test(slot[0]),
    "projects belong to the left dock only; a second list is redundant",
  )
})

test("the dock offers pointer paths for every core action", async () => {
  const text = await source("components/dock.jsx")
  assert.match(text, /<Button/, "global dock actions must use the shared button control")
  assert.match(text, /<ClickRow/, "chat rows must use the shared clickable row control")
  assert.match(text, /onAddProject/, "adding a project must be clickable")
  assert.match(text, /onOpen/, "opening a session must be clickable")
  assert.match(text, /onToggle/, "collapsing the dock must be clickable")
  assert.match(text, /onChooseProject/, "new chats must begin with an explicit folder selection")
})

test("ambiguous new-chat actions always ask for a folder", async () => {
  const entry = await source("index.tsx")
  assert.doesNotMatch(entry, /createSession\(\{\}\)/, "a global button must never create in the launch directory")
  assert.match(entry, /newSession: async \(\) => openPalette\("#"\)/)
  const dock = await source("components/dock.jsx")
  assert.match(dock, /Choose a folder/)
  assert.doesNotMatch(dock, /Start a new chat/)
})

// A project row is a folder target, while its child rows are previous chats.
// Mixing those meanings reopened an arbitrary old chat when the folder itself
// was clicked.
test("selecting a project prepares a native deferred draft in that folder", async () => {
  const entry = await source("index.tsx")
  const draftStart = entry.indexOf("const openSessionDraft =")
  const projectStart = entry.indexOf("const openProject =", draftStart)
  const addStart = entry.indexOf("const openAddProject =", projectStart)
  assert.ok(draftStart >= 0 && projectStart > draftStart && addStart > projectStart)
  const helpers = entry.slice(draftStart, addStart)
  assert.match(helpers, /sessionDraft/)
  assert.match(helpers, /draftApi\.open\(target\)/)
  assert.match(helpers, /api\.route\.navigate\("home"\)/, "portable hosts must still open a native draft")
  assert.match(helpers, /Portable mode opened a native draft/)
  assert.match(helpers, /openSessionDraft\(project\?\.worktree\)/)
  assert.doesNotMatch(helpers, /session\.create|projects\.createSession|openSessionTab/, "folder selection must not create or resume a chat")

  const projectAction = /if \(action\.kind === "project"\) \{([\s\S]*?)\n              \}/.exec(entry)
  assert.ok(projectAction, "the universal finder must handle project results")
  assert.match(projectAction[1], /openProject\(action\.project\)/)
  assert.doesNotMatch(projectAction[1], /createSession|openSessionTab/, "finder project results must also prepare a draft")
})

test("all folder entry points share the deferred draft helper", async () => {
  const entry = await source("index.tsx")
  assert.doesNotMatch(entry, /projects\.createSession|api\.client\.session\.create/)
  assert.match(entry, /onAdd=\{async \(directory: string\) => \{\s*projects\.addProject\(directory\)\s*if \(!openSessionDraft\(directory\)\) return/)
  assert.match(entry, /onNewSessionIn=\{\(project: \{ worktree\?: string \}\) => openSessionDraft\(project\?\.worktree\)\}/)
})

// Regression: controls acted on mouse-down, but the host dialog backdrop
// dismisses on mouse-up. A control that opened a dialog was therefore closed
// again by the same release, so the panel only stayed visible while held.
//
// Press *feedback* on mouse-down is still correct and is what makes a button
// feel physical, so the rule is precise: a mouse-down handler may only set
// local visual state, never invoke a callback.
test("dock project cards use the full visible header as the action target and paginate chats", async () => {
  const dock = await source("components/dock.jsx")
  assert.match(dock, /width=\{props\.width\}[\s\S]*height=\{2\}[\s\S]*focusable=\{project\(\)\.openable\}[\s\S]*onMouseUp=\{project\(\)\.openable/)
  assert.match(dock, /<box flexDirection="row" flexShrink=\{0\} width=\{props\.width\} height=\{1\}>/)
  assert.match(dock, /width=\{props\.width\} height=\{1\} paddingLeft=\{3\}/, "the metadata row must share the full card hitbox")
  assert.match(dock, /INITIAL_SESSION_COUNT = 5/)
  assert.match(dock, /SESSION_PAGE_SIZE = 10/)
  assert.match(dock, /Show \{Math\.min\(SESSION_PAGE_SIZE, remaining\(\)\)\} more/)
  assert.doesNotMatch(dock, /<For each=\{project\.sessions\}>/, "all chats must never render eagerly")
})

test("the sidebar exposes a bounded full-width recent chats section", async () => {
  const dock = await source("components/dock.jsx")
  assert.match(dock, /RECENT_CHAT_COUNT = 5/)
  assert.match(dock, /store\.recentSessionRows\(\)/)
  assert.doesNotMatch(dock, /store\.sessionRows\(\)\.slice/, "recents must not inherit selected-project grouping")
  assert.match(dock, /<b>RECENT CHATS<\/b>/)
  assert.match(dock, /<RecentChatRow[\s\S]*width=\{width\(\)\}/)
  assert.match(dock, /if \(row\.projectID\) store\.selectProject\?\.\(row\.projectID\)/)
})

test("folder picker is height-bounded, wheel-scrollable, and virtualized", async () => {
  const picker = await source("components/project-add.jsx")
  assert.match(picker, /height=\{panelHeight\(\)\}/)
  assert.match(picker, /panelHeight\(\) - \(compact\(\) \? 9 : 27\)/, "fixed dialog chrome must be deducted from the list viewport")
  assert.match(picker, /height=\{compact\(\) \? 1 : 3\}/, "compact actions must consume one row, not overflow with large buttons")
  assert.match(picker, /autoFocus=\{compact\(\)\}/, "compact mode must focus the visible filter instead of a hidden path field")
  assert.match(picker, /<Show when=\{!compact\(\)\}>[\s\S]*label="Folder path"/, "short terminals must remove optional rows rather than overflow")
  assert.match(picker, /maxHeight=\{panelHeight\(\)\}/)
  assert.match(picker, /overflow="hidden"/)
  assert.match(picker, /onMouseScroll=/)
  assert.match(picker, /<For each=\{visible\(\)\.entries\}>/)
  assert.doesNotMatch(picker, /<For each=\{model\(\)\.entries\}>/, "large directories must not mount every row")
  assert.match(picker, /createDeferred\(typed, \{ timeoutMs: 60 \}\)/, "filtering must yield to pointer and paint work")
  assert.match(picker, /listingCache\.size > 48/, "backtracking must reuse bounded directory results")
})

test("no control acts on mouse-down", async () => {
  for (const file of COMPONENTS) {
    const text = await source(file)
    for (const match of text.matchAll(/onMouseDown=\{([^}]*)\}/g)) {
      const body = match[1]
      assert.ok(
        /set[A-Za-z]+\((?:true|false|position\(\))\)|target\?\.focus\?\.\(\)|onHover/.test(body.trim()),
        `${file}: onMouseDown may only establish focus/selection, found: ${body.trim()}`,
      )
    }
  }
})

// A control that is invisible until hovered cannot be discovered by someone who
// does not already know it is there.
test("primary and secondary buttons are filled at rest", async () => {
  const { createTokens, buttonSurface } = await import("../lib/design.js")
  const tokens = createTokens({})
  for (const variant of ["primary", "secondary", "danger"]) {
    const rest = buttonSurface(tokens, { variant })
    assert.ok(rest.background, `${variant} must have a background before hover`)
    const hovered = buttonSurface(tokens, { variant, hover: true })
    assert.notEqual(hovered.background, rest.background, `${variant} must react to hover`)
    const pressed = buttonSurface(tokens, { variant, pressed: true })
    assert.notEqual(pressed.background, rest.background, `${variant} must react to press`)
  }
})

test("button labels stay legible on their own fill", async () => {
  const { contrast, createTokens, buttonSurface } = await import("../lib/design.js")
  // Includes a light theme: ink chosen for a dark canvas fails on a light one.
  for (const theme of [{}, { background: "#ffffff", text: "#111111", primary: "#2563eb" }]) {
    const tokens = createTokens(theme)
    for (const variant of ["primary", "secondary", "danger"]) {
      for (const state of [{}, { hover: true }, { pressed: true }]) {
        const surface = buttonSurface(tokens, { variant, ...state })
        assert.ok(
          contrast(surface.foreground, surface.background) >= 4,
          `${variant} ${JSON.stringify(state)}: label must stay readable on its fill`,
        )
      }
    }
  }
})

// The interface must be usable by someone who does not code and will never
// read a shortcut list. The primary path on every surface has to be a real
// labelled button.
test("every main surface offers a filled primary button", async () => {
  for (const file of ["components/dock.jsx", "components/workbench.jsx", "components/project-add.jsx"]) {
    const text = await source(file)
    assert.match(text, /variant="primary"/, `${file}: the main action must be a filled button`)
  }
})

test("the operations workspace replaces the empty editor canvas", async () => {
  const workbench = await source("components/workbench.jsx")
  const operations = await source("components/operations.jsx")
  assert.match(workbench, /<OperationsWorkspace/)
  assert.doesNotMatch(workbench, /ActivityPanel|SessionView|DetailPane|<Tab/, "legacy inspector and fake editor tabs must be gone")
  for (const title of ["Operations", "Current chat", "Needs you", "Working now", "Recent chats"]) {
    assert.match(operations, new RegExp(title), `missing useful workspace section: ${title}`)
  }
  assert.match(operations, /<scrollbox flexGrow=\{1\}/, "the dashboard must fill and scroll the available viewport")
})

test("the folder picker offers one-click destinations", async () => {
  const text = await source("components/project-add.jsx")
  assert.match(text, /commonRoots/, "typing a full path must not be the only way in")
})

test("search and folder fields use native OpenTUI inputs", async () => {
  const controls = await source("components/controls.jsx")
  assert.match(controls, /export function TextInput/)
  assert.match(controls, /<input/)
  assert.match(controls, /onInput=/)
  assert.match(controls, /target\?\.focus/)
  for (const file of ["components/palette.jsx", "components/session-switcher.jsx", "components/project-add.jsx"]) {
    const text = await source(file)
    assert.match(text, /<TextInput/, `${file}: painted text is not an input system`)
    assert.doesNotMatch(text, /applyKeyToQuery/, `${file}: native inputs own text editing`)
  }
})

test("shared controls never change geometry on hover", async () => {
  const controls = await source("components/controls.jsx")
  assert.doesNotMatch(controls, /onMouseOver|onMouseOut/, "nested enter/leave events cause hover flicker")
  assert.doesNotMatch(controls, /hover\(\)/, "hover must not mount controls or alter widths")
})

test("large buttons render one line and never overprint descriptions", async () => {
  const controls = await source("components/controls.jsx")
  const start = controls.indexOf("export function Button")
  const end = controls.indexOf("export function TextInput", start)
  const button = controls.slice(start, end)
  assert.doesNotMatch(button, /props\.description/, "multiple text rows overlap in fixed-height OpenTUI buttons")
  assert.match(button, /height=\{size\(\) === "lg" \? 3 : 1\}/, "large click targets keep their three-row hit area")
})

test("settings is a first-class mouse-accessible route", async () => {
  const entry = await source("index.tsx")
  const settings = await source("components/settings.jsx")
  assert.match(entry, /SETTINGS_ROUTE = "alonix-settings"/)
  assert.match(entry, /name: SETTINGS_ROUTE/)
  assert.match(entry, /slashName: "alonix-settings"/)
  assert.match(entry, /onSettings=\{openSettings\}/)
  assert.match(settings, /Alonix Settings/)
  for (const page of ["Tool access", "Instructions", "Context \/ DCP", "Web providers", "Plugin & safety"]) assert.match(settings, new RegExp(page))
  assert.match(settings, /Save changes/)
  assert.match(settings, /dockWidth\(props\.dockOpen\(\), dimensions\(\)\.width\)/, "settings must reserve the persistent sidebar column")
  const saveBody = settings.match(/const save = async \(\) => \{([\s\S]*?)\n  \}\n\n  return/)?.[1] ?? ""
  assert.doesNotMatch(saveBody, /session|prompt|route|navigate|dialog|openSession|sessionDraft/, "settings save must be config-only")
  const settingsLib = await source("lib/settings.js")
  assert.match(settingsLib, /if \(!changes\.length\) return \{[\s\S]*changed: false/, "duplicate saves must be strict no-ops")
})

test("settings owns one marked AGENTS block and never edits personal models or providers", async () => {
  const sourceText = await source("lib/settings.js")
  assert.match(sourceText, /ALONIX OPTIMIZED TOOL INSTRUCTIONS: START/)
  assert.match(sourceText, /ALONIX OPTIMIZED TOOL INSTRUCTIONS: END/)
  assert.match(sourceText, /agentsPath: resolve\(options\.agentsPath \?\? join\(configDir, "AGENTS\.md"\)\)/)
  assert.match(sourceText, /incomplete or duplicate Alonix instruction block/)
  assert.match(sourceText, /backupExisting/)
  assert.match(sourceText, /atomicTransaction/)
  assert.doesNotMatch(sourceText, /\["model"\]|\["provider"\]/)
})

test("dock actions are bounded to the expanded sidebar width", async () => {
  const dock = await source("components/dock.jsx")
  assert.match(dock, /<box flexDirection="row" gap=\{1\} width="100%">[\s\S]*width="50%"[\s\S]*width="50%"/)
  assert.match(dock, /<Button tokens=\{tokens\(\)\} width="100%" variant="secondary" onPress=\{props\.onSettings\}>Settings<\/Button>/)
})

test("presence reconciliation is bounded and debounced to protect pointer responsiveness", async () => {
  const store = await source("components/project-store.jsx")
  assert.match(store, /SDK_CONCURRENCY = 4/)
  assert.match(store, /PRESENCE_EVENT_DEBOUNCE_MS = 250/)
  assert.match(store, /mapSettledBounded/)
  assert.match(store, /api\?\.event\?\.on\?\.\(event, schedulePresence\)/)
  assert.doesNotMatch(store, /api\?\.event\?\.on\?\.\(event, refreshPresence\)/)
})

test("the universal finder exposes plain-language mouse filters", async () => {
  const text = await source("components/palette.jsx")
  for (const label of ["All", "Chats", "Folders", "Actions"]) assert.match(text, new RegExp(`label: "${label}"`))
  assert.match(text, /<SegmentedControl/, "filters must be visible click targets")
  assert.match(text, /Open selected/, "opening the current choice must not require enter")
  assert.doesNotMatch(text, />·@·#/, "developer prefix syntax must not be the primary instruction")
})

test("monitor is automatic and explains what it shows", async () => {
  const text = await source("components/monitor.jsx")
  assert.match(text, /Updates automatically from every active chat/)
  assert.match(text, /filter\(\(session\) => session\.running/)
  assert.doesNotMatch(text, /props\.panes|onAutoFill|paneGrid/, "monitor state must not go stale behind manual panes")
})

test("a disabled button never looks pressable", async () => {
  const { createTokens, buttonSurface } = await import("../lib/design.js")
  const tokens = createTokens({})
  const disabled = buttonSurface(tokens, { variant: "primary", disabled: true, hover: true })
  assert.equal(disabled.disabled, true)
  assert.notEqual(disabled.background, buttonSurface(tokens, { variant: "primary" }).background)
})
