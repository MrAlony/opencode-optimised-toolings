// Authoritative adapter for the OpenCode v2 generated SDK.
//
// The generated convenience classes accept FLAT parameter objects even though
// the lower-level OpenAPI data types describe `{ query, body }`. Passing the
// lower-level shape to `api.client` silently drops directory/path parameters and
// falls back to the OpenCode launch directory. Keep every cross-project call in
// this module so tests and UI code cannot accidentally mix the two contracts.

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

function resultError(result, action) {
  if (!result?.error) return null
  const detail = result.error?.message ?? JSON.stringify(result.error)
  return new Error(`${action}: ${detail}`)
}

export async function listProjects(client) {
  const result = await client?.project?.list?.({})
  const error = resultError(result, "Could not list projects")
  if (error) throw error
  return Array.isArray(result?.data) ? result.data : []
}

export async function listSessions(client, options = {}) {
  const directory = text(options.directory)
  const result = await client?.session?.list?.({
    roots: options.roots !== false,
    limit: Number.isFinite(options.limit) ? options.limit : 400,
    ...(directory ? { directory } : {}),
  })
  const error = resultError(result, `Could not list chats${directory ? ` in ${directory}` : ""}`)
  if (error) throw error
  return Array.isArray(result?.data) ? result.data : []
}

export async function listDirectory(client, directory) {
  const target = text(directory)
  if (!target) return []
  const result = await client?.file?.list?.({ path: target, directory: target })
  const error = resultError(result, `Could not read folder ${target}`)
  if (error) throw error
  return Array.isArray(result?.data) ? result.data : []
}
