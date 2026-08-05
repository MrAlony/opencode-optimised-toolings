import test from "node:test"
import assert from "node:assert/strict"
import { baseName, breadcrumbs, browseModel, joinPath, looksLikeProject, normalizePath, parentOf } from "../lib/browse.js"

function dir(name, project = false) {
  return { name, directory: true, project }
}

test("paths normalise separators and trailing slashes", () => {
  assert.equal(normalizePath("C:\\work\\app\\"), "C:/work/app")
  assert.equal(normalizePath("/home/user/"), "/home/user")
  assert.equal(normalizePath("/"), "/")
  assert.equal(normalizePath(""), "")
  assert.equal(normalizePath(undefined), "")
})

test("parent traversal stops at filesystem roots", () => {
  assert.equal(parentOf("C:/work/app"), "C:/work")
  assert.equal(parentOf("C:/work"), "C:")
  assert.equal(parentOf("C:"), null, "a drive root has no parent")
  assert.equal(parentOf("/home/user"), "/home")
  assert.equal(parentOf("/home"), "/")
  assert.equal(parentOf("/"), null)
  assert.equal(parentOf(""), null)
})

test("base names and joins behave on both platforms", () => {
  assert.equal(baseName("C:/work/app"), "app")
  assert.equal(baseName("/home/user"), "user")
  assert.equal(joinPath("C:/work", "app"), "C:/work/app")
  assert.equal(joinPath("C:", "work"), "C:/work")
  assert.equal(joinPath("/", "home"), "/home")
  assert.equal(joinPath("/home", "/user/"), "/home/user")
  assert.equal(joinPath("/home", ""), "/home")
})

test("project roots are recognised by their markers", () => {
  assert.equal(looksLikeProject(["src", "package.json"]), true)
  assert.equal(looksLikeProject([".git", "README.md"]), true)
  assert.equal(looksLikeProject(["Cargo.toml"]), true)
  assert.equal(looksLikeProject(["notes.txt", "photos"]), false)
  assert.equal(looksLikeProject([]), false)
  assert.equal(looksLikeProject(undefined), false)
})

test("only directories are offered and noise is hidden", () => {
  const model = browseModel({
    directory: "C:/work",
    entries: [
      dir("app"),
      dir("node_modules"),
      dir(".git"),
      dir("dist"),
      { name: "readme.md", directory: false },
    ],
  })
  assert.deepEqual(model.entries.map((entry) => entry.name), ["app"], "files and noise are excluded")
})

test("hidden directories can be revealed on demand", () => {
  const entries = [dir("app"), dir(".config"), dir("node_modules")]
  const shown = browseModel({ directory: "C:/work", entries, showHidden: true })
  const names = shown.entries.map((entry) => entry.name)
  assert.ok(names.includes(".config"))
  assert.ok(names.includes("node_modules"))
})

test("projects sort ahead of ordinary directories", () => {
  const model = browseModel({
    directory: "C:/work",
    entries: [dir("zeta"), dir("alpha"), dir("beta", true)],
  })
  assert.equal(model.entries[0].name, "beta", "a project root leads")
  assert.deepEqual(model.entries.slice(1).map((entry) => entry.name), ["alpha", "zeta"])
})

test("filtering narrows the listing case-insensitively", () => {
  const model = browseModel({
    directory: "C:/work",
    entries: [dir("Alpha"), dir("beta"), dir("gamma")],
    // Uppercase query must still match the lowercase directory name.
    query: "AL",
  })
  assert.deepEqual(model.entries.map((entry) => entry.name), ["Alpha"])

  // A substring match is not anchored to the start of the name.
  const contains = browseModel({
    directory: "C:/work",
    entries: [dir("Alpha"), dir("beta"), dir("gamma")],
    query: "a",
  })
  assert.deepEqual(contains.entries.map((entry) => entry.name), ["Alpha", "beta", "gamma"])
})

test("already-added projects are flagged, not offered twice", () => {
  const model = browseModel({
    directory: "C:/work",
    entries: [dir("app", true), dir("other", true)],
    knownProjects: ["C:/work/app"],
  })
  const app = model.entries.find((entry) => entry.name === "app")
  assert.equal(app.added, true)
  assert.equal(model.entries.find((entry) => entry.name === "other").added, false)
})

test("the current directory is itself addable unless already known", () => {
  const fresh = browseModel({ directory: "C:/work/app", entries: [] })
  assert.equal(fresh.canAdd, true)
  assert.equal(fresh.alreadyAdded, false)

  const known = browseModel({ directory: "C:/work/app", entries: [], knownProjects: ["C:/work/app"] })
  assert.equal(known.canAdd, false)
  assert.equal(known.alreadyAdded, true)

  // Known paths compare after normalisation.
  const windows = browseModel({ directory: "C:/work/app", entries: [], knownProjects: ["C:\\work\\app\\"] })
  assert.equal(windows.alreadyAdded, true)
})

test("the model exposes the parent so navigation can go up", () => {
  assert.equal(browseModel({ directory: "C:/work/app", entries: [] }).parent, "C:/work")
  assert.equal(browseModel({ directory: "/", entries: [] }).parent, null)
})

test("breadcrumbs cover the full path and collapse when deep", () => {
  const shallow = breadcrumbs("C:/work/app")
  assert.deepEqual(shallow.map((crumb) => crumb.name), ["C:", "work", "app"])
  assert.equal(shallow.at(-1).path, "C:/work/app")

  const deep = breadcrumbs("/a/b/c/d/e/f/g", 4)
  assert.equal(deep.length, 4)
  assert.equal(deep[1].name, "\u2026", "the middle collapses")
  assert.equal(deep.at(-1).name, "g")
  assert.equal(deep[1].path, null, "the ellipsis is not navigable")

  assert.deepEqual(breadcrumbs(""), [])
})

test("malformed input never throws", () => {
  for (const input of [undefined, {}, { entries: null }, { entries: [null, {}, { name: 5 }] }]) {
    assert.doesNotThrow(() => browseModel(input))
  }
})
