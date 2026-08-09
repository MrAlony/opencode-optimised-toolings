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

test("Windows focus-in restores terminal modes without consuming native input", async () => {
  const entry = await source("index.tsx")
  const recovery = await source("lib/terminal-recovery.js")
  assert.match(entry, /installTerminalModeRecovery\(api\.renderer\)/)
  assert.match(entry, /api\.lifecycle\.onDispose\(disposeTerminalRecovery\)/)
  assert.match(recovery, /prependInputHandler\(handler\)/)
  assert.match(recovery, /sequence === FOCUS_IN/)
  assert.match(recovery, /return false/, "recovery must preserve native focus and input dispatch")
  assert.match(recovery, /removeInputHandler/)
})

test("dock interactions preserve toggle intent across delayed KV hydration", async () => {
  const entry = await source("index.tsx")
  assert.match(entry, /scope\.hydrateDock\(\)[\s\S]*const next = !dockOpen\(\)/)
  assert.match(entry, /dockTogglesBeforeHydration % 2 === 0 \? restored : !restored/)
  assert.match(entry, /scope\.queueDockToggle\(\)/)
})

test("persisted state hydrates safely without blocking TUI startup", async () => {
  const entry = await source("index.tsx")
  const store = await source("components/project-store.jsx")
  assert.match(entry, /api\.kv\.ready/)
  assert.doesNotMatch(entry, /awaitKvReady\(api\)/)
  assert.doesNotMatch(entry, /await projects\.waitForInitialLoad\(\)/)
  assert.match(entry, /portfolio-hydrating/)
  assert.ok(entry.indexOf("portfolio-hydrating") < entry.indexOf("api.slots.register"), "IDE surfaces register immediately while portfolio hydration continues")
  assert.match(entry, /dockInitiallyHydrated/)
  assert.match(entry, /setInterval\(\(\) => \{\s*if \(hydrateDock\(\)/)
  assert.match(store, /persistenceHydrated/)
  assert.match(store, /pendingPersistence/)
  assert.match(store, /function hydratePersistence\(\)/)
  assert.match(store, /PORTFOLIO_SNAPSHOT_KEY/)
  assert.match(store, /PRESENCE_LEASE_MS = 20_000/)
  assert.match(store, /sharedPresence/)
  assert.match(store, /source: "shared-presence"/)
  assert.match(store, /phase: initialSnapshot \? "cached" : "loading"/)
  assert.match(store, /setInterval\(\(\) => \{\s*if \(hydratePersistence\(\)/)
})

test("transcript status animation uses the one shared clock instead of one interval per tool", async () => {
  const kit = await source("components/kit.jsx")
  const index = await source("index.tsx")
  const statusGlyph = kit.slice(kit.indexOf("export function StatusGlyph"), kit.indexOf("function isToggleKey"))
  assert.match(statusGlyph, /useClock/)
  assert.doesNotMatch(statusGlyph, /setInterval|setTimeout/)
  assert.match(index, /registry\.register\([\s\S]*?<ClockProvider clock=\{clock\}>/)
  assert.match(index, /fingerprint !== toolingStateFingerprint/)
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

test("live animation stays leaf-scoped instead of rebuilding the full Mission Control model", async () => {
  const monitor = await source("components/monitor.jsx")
  const kit = await source("components/ide-kit.jsx")
  const rail = await source("components/session-rail.jsx")
  assert.doesNotMatch(monitor, /useClock\(/, "the full agent inventory must never recompute on animation frames")
  assert.match(kit, /export function StatusDot[\s\S]*useClock\(/, "visible status glyphs own bounded animation")
  assert.match(rail, /useClock\(/, "the bounded session rail may animate its visible rows")
  const dock = await source("components/dock.jsx")
  assert.doesNotMatch(dock, /void clock\(\)[\s\S]*liveActivity/, "dock animation frames must not rebuild transcript activity")
  const operations = await source("components/operations.jsx")
  assert.doesNotMatch(operations, /useClock|liveActivity/, "the command center must remain planning-only")
})

test("opening a completed session acknowledges its lifecycle receipt", async () => {
  const entry = await source("index.tsx")
  assert.match(entry, /openSessionTab[\s\S]*projects\.acknowledgeCompletion\(sessionID\)/)
  assert.match(entry, /openChat[\s\S]*openSessionTab\(sessionID\)/)
  assert.match(entry, /openSessionTab[\s\S]*openSession\(api, sessionID\)[\s\S]*queueMicrotask[\s\S]*projects\.acknowledgeCompletion\(sessionID\)/, "routing must paint before deferred lifecycle bookkeeping")
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

test("nullable async and selection state is never dereferenced behind only a visual Show guard", async () => {
  const projectAdd = await source("components/project-add.jsx")
  const palette = await source("components/palette.jsx")
  const switcher = await source("components/session-switcher.jsx")
  const operations = await source("components/operations.jsx")
  assert.match(projectAdd, /const currentListing = createMemo/)
  assert.match(projectAdd, /listing\(\)\.directory === directory\(\)/, "late listings must be replaced with a stable empty view")
  assert.doesNotMatch(projectAdd, /listing\(\)\.error/)
  assert.match(palette, /EMPTY_PREVIEW_ACTION/)
  assert.match(switcher, /EMPTY_PREVIEW_ROW/)
  assert.match(operations, /commandCenterModel/)
  for (const [name, text] of [["dock", await source("components/dock.jsx")], ["session rail", await source("components/session-rail.jsx")]]) {
    assert.doesNotMatch(text, /activity\(\)\?\./, `${name} must use a stable activity view model`)
  }
  assert.doesNotMatch(operations, /activity\(\)|snapshot\(\)|liveActivity/, "the command center must not own live nullable state")
})

test("folder loading is bounded and exposes recovery instead of a permanent spinner", async () => {
  const dock = await source("components/dock.jsx")
  const store = await source("components/project-store.jsx")
  assert.match(store, /withDeadline/)
  assert.match(store, /ALONIX_PORTFOLIO_REQUEST_TIMEOUT_MS/)
  assert.match(store, /projects: mergeProjects\(initialSnapshot\?\.projects \?\? \[\], initialRegisteredProjects\)/)
  assert.match(dock, /Folders could not be refreshed/)
  assert.match(dock, /Loading chats…/)
  assert.match(dock, /portfolioReady=\{store\.ready\}/)
  assert.match(dock, />Try again<\/Button>/)
  const status = await source("components/ide-surfaces.jsx")
  assert.match(status, /props\.store\.ready \? `\$\{summary\(\)\.sessions\} chats` : "loading chats"/)
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
  assert.match(picker, /panelHeight\(\) - \(compact\(\) \? 9 : 15\)/, "fixed dialog chrome must be deducted from the list viewport")
  assert.match(picker, /height=\{compact\(\) \? 1 : 3\}/, "compact actions must consume one row, not overflow with large buttons")
  assert.match(picker, /autoFocus=\{compact\(\)\}/, "compact mode must focus the visible filter instead of a hidden path field")
  assert.match(picker, /<Show when=\{!compact\(\)\}>[\s\S]*placeholder="Paste a folder path/, "short terminals must remove optional rows rather than overflow")
  assert.match(picker, /maxHeight=\{panelHeight\(\)\}/)
  assert.match(picker, /overflow="hidden"/)
  assert.match(picker, /onMouseScroll=/)
  assert.match(picker, /<For each=\{visible\(\)\.entries\}>/)
  assert.doesNotMatch(picker, /<For each=\{model\(\)\.entries\}>/, "large directories must not mount every row")
  assert.match(picker, /createDeferred\(query, \{ timeoutMs: 75 \}\)/, "filtering must yield to pointer and paint work")
  assert.match(picker, /createDirectoryCache/, "backtracking must reuse bounded directory results")
  assert.match(picker, /if \(owner !== request\) return/, "late directory responses must never replace the current folder")
  assert.match(picker, /folderIndex\(currentListing\(\)\.entries\)/, "sorting and normalization must run once per listing, not per keystroke")
  assert.match(picker, /readdir\(directory, \{ withFileTypes: true \}\)/, "local folder navigation must bypass the SDK/server round trip")
  assert.ok(picker.indexOf("nativeDirectory(normalized)") < picker.indexOf("sdkDirectory(api, normalized)"), "the SDK is compatibility fallback only")
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

test("the Delivery Hub replaces the duplicate live operations canvas", async () => {
  const workbench = await source("components/workbench.jsx")
  const operations = await source("components/operations.jsx")
  const monitor = await source("components/monitor.jsx")
  assert.match(workbench, /<OperationsWorkspace/)
  assert.doesNotMatch(workbench, /ActivityPanel|SessionView|DetailPane|<Tab/, "legacy inspector and fake editor tabs must be gone")
  for (const title of ["Project Delivery Hub", "Unified project tasks", "Review queue", "Unresolved work", "Decisions & memory", "Cross-chat change overlaps", "Recent completed outcomes", "Project health"]) assert.match(operations, new RegExp(title), `missing Delivery Hub section: ${title}`)
  assert.doesNotMatch(operations, /Working now|Recent chats|liveActivity|useClock/, "live supervision and sidebar recents must not be duplicated")
  assert.match(operations, /<scrollbox flexGrow=\{1\}/, "the Delivery Hub must fill and scroll the available viewport")
  assert.match(monitor, /Live Agents Mission Control/)
  assert.match(monitor, /agentWindow/)
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

test("installed TUI resolves and attests the one direct immutable generation root", async () => {
  const entry = await source("index.tsx")
  assert.match(entry, /const root = packageRootFrom\(import\.meta\.url\)/)
  assert.match(entry, /directGeneration: true/)
  assert.match(entry, /runtimeAttestation\(root, \{ role: "tui" \}\)/)
  assert.match(entry, /sourceMatchesMarker/)
  assert.match(entry, /dependencyFingerprint/)
  assert.match(entry, /rendererCapabilityReady/)
  assert.match(entry, /record\(rendererCapabilityReady \? "active" : "degraded", rendererCapabilityReady \? "complete" : "complete-portable"/)
  assert.match(entry, /missingCapability: registration\.available \? null : "api\.toolRenderers"/)
  assert.doesNotMatch(entry, /loadedTuiBridgeIdentity|compareRuntimeIdentity|tui-loader/)
  assert.doesNotMatch(entry, /packages[\\/]tui[\\/]package\.json/)
})

test("server and TUI direct entries are provisioned together before activation", async () => {
  const generation = await source("../shared/generation.js")
  assert.match(generation, /generationSpecs/)
  assert.match(generation, /validateGeneration/)
  assert.match(generation, /activatePackageGeneration/)
  assert.match(generation, /for \(const \[role, file\] of Object\.entries\(paths\)\)/)
  assert.match(generation, /\.generation-activation\.json/)
  assert.match(generation, /acquireLock\(lock\)/)
  assert.match(generation, /recoverActivationJournal\(configDir\)/)
  assert.match(generation, /for \(const item of planned\) await atomicWrite\(item\.file, item\.before\)/)
  assert.match(generation, /replaceWithRetry/)
  assert.ok(generation.indexOf('left.role === "tui"') < generation.indexOf('Candidate activation verification failed'), "TUI must switch first and both files must verify before commit")
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
  assert.match(store, /PRESENCE_EVENT_DEBOUNCE_MS = 40/)
  assert.match(store, /mapSettledBounded/)
  assert.match(store, /AbortController/)
  assert.match(store, /onCore/)
  assert.match(store, /onLive/)
  assert.match(store, /function publishHostPresence/)
  assert.match(store, /function applyStatusEvent/)
  assert.match(store, /statusEventPayload\(event\)/)
  assert.match(store, /persistPortfolio/)
  assert.match(store, /mergePresenceStatuses/)
  assert.match(store, /readPresenceLeases/)
  assert.match(store, /readPresenceSnapshot/)
  assert.match(store, /mergePresenceSessions/)
  assert.match(store, /publishPresenceLease/)
  assert.match(store, /clearPresenceLease/)
  assert.ok(store.indexOf("applyStatusEvent(event)") < store.indexOf("schedulePresence(event)"), "event-authoritative status must publish before SDK verification is scheduled")
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

test("Live Agents data reconciliation is event-driven rather than animation-frame driven", async () => {
  const monitor = await source("components/monitor.jsx")
  const enriched = monitor.slice(monitor.indexOf("const enriched ="), monitor.indexOf("const projects =", monitor.indexOf("const enriched =")))
  assert.doesNotMatch(enriched, /useClock|void clock/)
  assert.match(enriched, /createMemo/)
  assert.match(enriched, /filter\(missionEligible\)\.map/, "historical chats must be filtered before expensive host enrichment")
})

test("Live Agents Mission Control is automatic, filterable and focused on active intervention", async () => {
  const text = await source("components/monitor.jsx")
  assert.match(text, /Live Agents Mission Control/)
  assert.match(text, /missionControlModel/)
  assert.match(text, /agentWindow/)
  assert.match(text, /missionControlLayout/)
  assert.match(text, /layout\(\)\.capacity/, "card virtualization must count agents across every visible column")
  assert.match(text, /viewportCulling/, "large live-agent sets must remain bounded without becoming unreachable")
  assert.match(text, /Needs you/)
  assert.match(text, /Stalled/)
  assert.match(text, /Overlaps/)
  assert.match(text, /FocusPanel/)
  assert.match(text, /AgentTableRow/)
  assert.doesNotMatch(text, /props\.panes|onAutoFill|paneGrid|Recent chats|Review queue/, "Mission Control must remain automatic and supervision-only")
})

test("a disabled button never looks pressable", async () => {
  const { createTokens, buttonSurface } = await import("../lib/design.js")
  const tokens = createTokens({})
  const disabled = buttonSurface(tokens, { variant: "primary", disabled: true, hover: true })
  assert.equal(disabled.disabled, true)
  assert.notEqual(disabled.background, buttonSurface(tokens, { variant: "primary" }).background)
})
