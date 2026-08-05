function identity(value) {
  return String(value ?? "").trim().replaceAll("\\", "/").replace(/\/$/, "").toLowerCase()
}

function defaultMatch(requested, observed) {
  const left = identity(requested?.label)
  const right = identity(observed?.titleText || observed?.title || observed?.label)
  return Boolean(left && right && (left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)))
}

export function declaredCounts(text) {
  const source = String(text ?? "")
  const ofTotal = source.match(/\b(\d+)\s+of\s+(\d+)\b/i)
  if (ofTotal) return { succeeded: Number(ofTotal[1]), total: Number(ofTotal[2]) }
  const succeeded = source.match(/\b(\d+)\s+(?:command|operation|transaction|item|request|quer(?:y|ies)|URL)s?\b[^.\n]*?succeeded/i)?.[1]
    ?? source.match(/\b(\d+)\s+succeeded\b/i)?.[1]
  const failed = source.match(/\b(\d+)\s+(?:failed|rejected|unavailable|timed out|aborted)\b/i)?.[1]
  if (succeeded !== undefined) {
    const good = Number(succeeded)
    return { succeeded: good, total: failed === undefined ? null : good + Number(failed) }
  }
  return { succeeded: null, total: null }
}

export function inputPlanAvailable(tool, input) {
  if (tool === "alonix-shell") return Array.isArray(input?.commands) && input.commands.length > 0
  if (tool === "alonix-background-process") return Array.isArray(input?.operations) && input.operations.length > 0
  if (tool === "alonix-web-fetch-many" || tool === "alonix-stealth-fetch-many") return Array.isArray(input?.requests) && input.requests.length > 0
  if (tool === "alonix-web-search" || tool === "alonix-stealth-search-many") return Array.isArray(input?.queries) && input.queries.length > 0
  if (tool === "alonix-read-many") return (input?.paths?.length ?? 0) + (input?.requests?.length ?? 0) > 0
  if (tool === "alonix-edit-many") return Array.isArray(input?.actions) && input.actions.length > 0
  if (tool === "alonix-search") return Boolean(String(input?.query ?? "").trim() && String(input?.base_dir ?? "").trim() && String(input?.file_pattern ?? "").trim())
  if (tool === "alonix-explore") return Boolean(String(input?.base_dir ?? "").trim())
  if (tool === "alonix-index-project") return Boolean(String(input?.project ?? "").trim() && String(input?.action ?? "").trim())
  if (tool === "alonix-index-context" || tool === "alonix-index-investigate" || tool === "alonix-index-memory") return Boolean(String(input?.project ?? "").trim())
  return true
}

export function pendingPlanSummary(available, count, singular, plural = `${singular}s`) {
  if (!available) return `${singular} input pending`
  return `${count} ${count === 1 ? singular : plural}`
}

export function reconcileBatch(plan, observed, options = {}) {
  const requested = Array.from(plan ?? [])
  const actual = Array.from(observed ?? [])
  if (!requested.length) {
    const records = actual.map((item, index) => ({ ...item, number: item.number ?? index + 1, detailAvailable: true, requested: null }))
    return { records, omitted: [], plannedCount: records.length, observedCount: records.length }
  }

  const used = new Set()
  const matcher = options.match ?? defaultMatch
  const records = requested.map((item, index) => {
    let actualIndex = actual.findIndex((candidate, candidateIndex) => !used.has(candidateIndex) && Number(candidate?.number) === index + 1)
    if (actualIndex < 0) actualIndex = actual.findIndex((candidate, candidateIndex) => !used.has(candidateIndex) && matcher(item, candidate, index))
    if (actualIndex < 0) actualIndex = actual.findIndex((candidate, candidateIndex) => !used.has(candidateIndex) && candidate?.number == null)
    if (actualIndex < 0) return { ...item, number: index + 1, status: "PARTIAL SUCCESS", meta: "details omitted", detailAvailable: false, requested: item }
    used.add(actualIndex)
    const result = actual[actualIndex]
    return {
      ...item,
      ...result,
      number: result.number ?? index + 1,
      label: options.label ? options.label(item, result, index) : result.label ?? result.titleText ?? result.title ?? item.label,
      meta: options.meta ? options.meta(item, result, index) : result.meta ?? item.meta,
      detailAvailable: true,
      requested: item,
    }
  })
  return { records, omitted: records.filter((item) => !item.detailAvailable), plannedCount: requested.length, observedCount: used.size }
}

export function visibleOutcome(records) {
  const list = Array.from(records ?? [])
  return {
    succeeded: list.filter((item) => item.detailAvailable && item.status === "SUCCESS").length,
    failed: list.filter((item) => item.detailAvailable && item.status === "FAILED").length,
    omitted: list.filter((item) => !item.detailAvailable).length,
  }
}
