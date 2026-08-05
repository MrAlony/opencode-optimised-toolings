// Directory browser model for adding a project.
//
// Adding a project must not require typing a path from memory, so this models
// a navigable listing that a pointer can drive. Pure functions over a supplied
// listing, so ordering, filtering and path arithmetic are testable without a
// filesystem.

const WINDOWS_ROOT = /^[a-zA-Z]:[\\/]?$/

/** Normalise to forward slashes without a trailing separator. */
export function normalizePath(value) {
  const text = String(value ?? "").trim().replaceAll("\\", "/")
  if (!text) return ""
  if (WINDOWS_ROOT.test(text.replace(/\//g, "\\"))) return text.replace(/\/$/, "")
  return text.replace(/\/+$/, "") || "/"
}

/** Parent directory, or null at a filesystem root. */
export function parentOf(value) {
  const normalized = normalizePath(value)
  if (!normalized) return null
  if (normalized === "/") return null
  if (/^[a-zA-Z]:$/.test(normalized)) return null
  const index = normalized.lastIndexOf("/")
  if (index < 0) return null
  if (index === 0) return "/"
  const parent = normalized.slice(0, index)
  return /^[a-zA-Z]:$/.test(parent) ? parent : parent
}

export function baseName(value) {
  const normalized = normalizePath(value)
  if (!normalized) return ""
  const index = normalized.lastIndexOf("/")
  return index < 0 ? normalized : normalized.slice(index + 1) || normalized
}

export function joinPath(base, name) {
  const normalized = normalizePath(base)
  const leaf = String(name ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
  if (!leaf) return normalized
  if (!normalized) return leaf
  if (/^[a-zA-Z]:$/.test(normalized)) return `${normalized}/${leaf}`
  return normalized === "/" ? `/${leaf}` : `${normalized}/${leaf}`
}

// Directories that are never interesting as a project and only add noise.
const NOISE = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  ".DS_Store",
])

/** Markers that make a directory look like a real project root. */
const PROJECT_MARKERS = [
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
]

/** True when a listing shows the directory is a project root. */
export function looksLikeProject(entryNames) {
  const names = new Set(Array.from(entryNames ?? []).map((name) => String(name)))
  return PROJECT_MARKERS.some((marker) => names.has(marker))
}

/**
 * Build the browsable listing for a directory.
 *
 * Only directories are offered because a project is a directory. Noise and
 * dotfiles are hidden by default but reachable, and known-project directories
 * are flagged so the obvious choice is visually obvious.
 */
export function browseModel(input = {}) {
  const directory = normalizePath(input.directory)
  const query = String(input.query ?? "").trim().toLowerCase()
  const showHidden = input.showHidden === true
  const known = new Set(Array.from(input.knownProjects ?? []).map((item) => normalizePath(item)))

  const entries = Array.from(input.entries ?? [])
    .filter((entry) => entry && entry.directory === true && typeof entry.name === "string" && entry.name)
    .filter((entry) => showHidden || (!entry.name.startsWith(".") && !NOISE.has(entry.name)))
    .filter((entry) => !query || entry.name.toLowerCase().includes(query))
    .map((entry) => {
      const path = joinPath(directory, entry.name)
      return {
        name: entry.name,
        path,
        project: entry.project === true,
        added: known.has(path),
      }
    })

  entries.sort((a, b) => {
    // Projects first: they are what the user is looking for.
    if (a.project !== b.project) return a.project ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  })

  return {
    directory,
    parent: parentOf(directory),
    entries,
    // The current directory is itself a valid choice.
    canAdd: Boolean(directory) && !known.has(directory),
    alreadyAdded: known.has(directory),
    isProject: input.isProject === true,
  }
}

/** Breadcrumb segments, each with the path it navigates to. */
export function breadcrumbs(directory, limit = 5) {
  const normalized = normalizePath(directory)
  if (!normalized) return []
  const crumbs = []
  let current = normalized
  while (current) {
    crumbs.unshift({ name: baseName(current) || current, path: current })
    const parent = parentOf(current)
    if (!parent || parent === current) break
    current = parent
  }
  const max = Math.max(1, Math.floor(Number(limit) || 5))
  if (crumbs.length <= max) return crumbs
  // Keep the root and the deepest segments; the middle is the least useful.
  return [crumbs[0], { name: "\u2026", path: null }, ...crumbs.slice(crumbs.length - (max - 2))]
}
