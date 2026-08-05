function field(block, name) {
  return block.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim() ?? ""
}

export function parseBlocks(text, kind) {
  const source = String(text ?? "")
  const pattern = new RegExp(`^=== ${kind} (\\d+): (.*?) ===$`, "gm")
  const matches = [...source.matchAll(pattern)]
  return matches.map((match, index) => {
    const start = match.index + match[0].length
    const end = matches[index + 1]?.index ?? source.length
    return { number: Number(match[1]), title: match[2], raw: source.slice(start, end).trim() }
  })
}

export function parseWebFetch(text) {
  const header = String(text).match(/^WEB FETCH RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m)?.[1]
  if (!header) return null
  const items = parseBlocks(text, "URL").map((block) => {
    const outcome = field(block.raw, "Outcome")
    const contentStart = block.raw.indexOf("--- EXTRACTED CONTENT ---")
    return {
      ...block,
      status: outcome === "FAILED" ? "FAILED" : /HTTP 2\d\d/.test(outcome) ? "SUCCESS" : "PARTIAL SUCCESS",
      outcome,
      finalUrl: field(block.raw, "Final URL"), cache: field(block.raw, "Cache"), duration: field(block.raw, "Duration"),
      content: field(block.raw, "Content"), completeness: field(block.raw, "Returned extraction"), titleText: field(block.raw, "Title"), error: field(block.raw, "Error"),
      extracted: contentStart >= 0 ? block.raw.slice(contentStart + "--- EXTRACTED CONTENT ---".length).trim() : "",
    }
  })
  return { status: header, summary: field(String(text), "WHAT HAPPENED"), allocation: field(String(text), "OUTPUT ALLOCATION"), items }
}

export function parseWebSearch(text) {
  const header = String(text).match(/^WEB SEARCH RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m)?.[1]
  if (!header) return null
  const items = parseBlocks(text, "QUERY").map((block) => {
    const outcome = field(block.raw, "Outcome")
    const results = []
    const pattern = /^\d+\. (.+)$/gm
    const matches = [...block.raw.matchAll(pattern)]
    for (let index = 0; index < matches.length; index += 1) {
      const start = matches[index].index + matches[index][0].length
      const end = matches[index + 1]?.index ?? block.raw.length
      const body = block.raw.slice(start, end)
      results.push({ title: matches[index][1], url: body.match(/^\s+URL: (.+)$/m)?.[1] ?? "", source: body.match(/^\s+Source: (.+)$/m)?.[1] ?? "", snippet: body.split(/\r?\n/).find((line) => /^\s{3}\S/.test(line) && !/^\s+(URL|Source|Date|Score):/.test(line))?.trim() ?? "" })
    }
    return { ...block, status: /RESULTS FOUND/.test(outcome) ? "SUCCESS" : "FAILED", outcome, cache: field(block.raw, "Cache"), attempts: block.raw.match(/^\s+- .+$/gm)?.map((line) => line.trim().slice(2)) ?? [], results }
  })
  return { status: header, summary: field(String(text), "WHAT HAPPENED"), items }
}

export function parseStealth(text) {
  const header = String(text).match(/^STEALTH (FETCH|SEARCH) RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m)
  if (!header) return null
  const items = parseBlocks(text, "ITEM").map((block) => ({ ...block, status: field(block.raw, "Outcome") === "FAILED" ? "FAILED" : "SUCCESS", outcome: field(block.raw, "Outcome"), finalUrl: field(block.raw, "Final URL"), http: field(block.raw, "HTTP status"), error: field(block.raw, "Error"), titleText: field(block.raw, "Title"), completeness: field(block.raw, "Returned evidence"), content: block.raw.split("--- CONTENT ---")[1]?.trim() ?? "" }))
  return { kind: header[1].toLowerCase(), status: header[2], summary: field(String(text), "WHAT HAPPENED"), tor: String(text).match(/^Tor: (.+)$/m)?.[1] ?? "", items }
}

export function parseDiscovery(text, tool) {
  if (tool === "fs_search") {
    const status = String(text).match(/^SEARCH RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m)?.[1]
    if (!status) return null
    const pairs = Object.fromEntries([...String(text).matchAll(/^\s{2}([^:]+): (.+)$/gm)].map((match) => [match[1], match[2]]))
    const matchSection = String(text).split(/^=== CONTENT MATCHES: .* ===$/m)[1]?.trim() ?? ""
    const matches = matchSection.split(/\r?\n/).filter((line) => /^\.\\/.test(line)).slice(0, 20)
    const items = matches.length ? matches.map((line) => ({ status: "SUCCESS", label: line.split(":").slice(0, 2).join(":"), meta: line.split(":")[2]?.trim() ?? "" })) : [
      { status, label: `${pairs["Matches found"] ?? 0} content matches`, meta: `${pairs["Files scanned"] ?? 0} files scanned` },
      { status: pairs["Complete"] === "yes" ? "SUCCESS" : "PARTIAL SUCCESS", label: "bounded evidence", meta: status.toLowerCase() },
    ]
    return { status, summary: field(String(text), "WHAT HAPPENED"), items, metrics: pairs, raw: text }
  }
  const status = String(text).match(/^EXPLORE RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m)?.[1]
  if (!status) return null
  const components = String(text).match(/^COMPONENT STATUS:\n([\s\S]*?)(?:\n\n|$)/m)?.[1].split(/\r?\n/).filter((line) => line.startsWith("- ")).map((line) => {
    const [label, ...rest] = line.slice(2).split(": ")
    const value = rest.join(": ")
    return { status: /complete|not requested|success/i.test(value) && !/partial/i.test(value) ? "SUCCESS" : /failed/i.test(value) ? "FAILED" : "PARTIAL SUCCESS", label, meta: value }
  }) ?? []
  return { status, summary: field(String(text), "WHAT HAPPENED"), items: components, raw: text }
}

export function parseCbm(text) {
  const source = String(text ?? "")
  if (!source) return null
  const failed = /^(?:CBM .* FAILED|INDEX REFRESH FAILED|STOP\.)/m.test(source) || /^Outcome: FAILED$/m.test(source)
  const partial = /INCONSISTENT|UNVERIFIABLE|TRUNCATED|OUTPUT BUDGET REACHED/m.test(source)
  const sectionMatches = [...source.matchAll(/^=== (.+?) ===$/gm)]
  const sectionNames = sectionMatches.map((match) => match[1])
  const sectionBodies = sectionMatches.map((match, index) => ({ name: match[1], body: source.slice(match.index + match[0].length, sectionMatches[index + 1]?.index ?? source.length).trim() }))
  const outcome = source.match(/^Outcome: (.+)$/m)?.[1] ?? ""
  const projectSummary = source.match(/^active=(.+)$/m)?.[0] ?? ""
  return { status: failed ? "FAILED" : partial ? "PARTIAL SUCCESS" : "SUCCESS", summary: failed ? (field(source, "What happened") || "CBM operation failed") : outcome || projectSummary || `${sectionNames.length} evidence sections returned`, sections: sectionNames, sectionBodies, raw: source }
}

export function inputItems(tool, input) {
  if (tool === "web_fetch_many" || tool === "stealth_fetch_many") return (input?.requests ?? []).map((item) => ({ status: "PENDING", label: item.url, meta: item.format ?? "" }))
  if (tool === "web_search" || tool === "stealth_search_many") return (input?.queries ?? []).map((item) => ({ status: "PENDING", label: item.query, meta: item.backend ?? "" }))
  if (tool === "shell") return (input?.commands ?? []).map((item) => ({ status: "PENDING", label: item.label || item.command, meta: "queued" }))
  if (tool === "background_process") return (input?.operations ?? []).map((item, index) => ({ status: "PENDING", label: item.label || item.action || `operation ${index + 1}`, meta: item.action ?? "" }))
  if (tool === "fs_read_many") return [...(input?.paths ?? []), ...(input?.requests ?? []).map((item) => item.path)].map((path) => ({ status: "PENDING", label: path, meta: "requested" }))
  if (tool === "fs_edit_many") return (input?.actions ?? []).map((item) => ({ status: "PENDING", label: item.path, meta: item.operation }))
  return []
}
