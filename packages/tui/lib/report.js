const STATUS_RE = {
  fs_search: /^SEARCH RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m,
  fs_explore: /^EXPLORE RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m,
  web_fetch_many: /^WEB FETCH RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m,
  web_search: /^WEB SEARCH RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m,
  stealth_fetch_many: /^STEALTH FETCH RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m,
  stealth_search_many: /^STEALTH SEARCH RESULT: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m,
  stealth_rotate_tor: /^STEALTH TOR ROTATION: (SUCCESS|PARTIAL SUCCESS|FAILED)$/m,
  stealth_status: /^STEALTH STATUS: (READY|[\w ]+)$/m,
}

export function reportStatus(text, tool) {
  const re = STATUS_RE[tool]
  if (re) {
    const m = text.match(re)
    if (m) {
      const value = m[1]
      if (value === "READY" || value === "SUCCESS") return "SUCCESS"
      if (value === "FAILED") return "FAILED"
      return "PARTIAL SUCCESS"
    }
  }
  if (/(?:Outcome|status|Status): (FAILED|ERROR)/m.test(text)) return "FAILED"
  if (/^Outcome: (EXISTING VERIFIED INDEX USED|INDEX REFRESHED AND VERIFIED INSIDE THIS TOOL CALL|INDEX CREATED|INDEX DELETED|SUCCESS)/m.test(text)) return "SUCCESS"
  if (/(PASS|SUCCESS|READY|completed successfully)/m.test(text)) return "SUCCESS"
  return "PARTIAL SUCCESS"
}

export function parseReportBlocks(text) {
  const nodes = []
  let inSection = false
  const push = (block) => {
    if (inSection && block.type !== "section") nodes.push({ ...block, indented: true })
    else nodes.push(block)
  }
  const lines = String(text).split(/\r?\n/)
  let pending = []
  const flushText = () => {
    if (pending.length) {
      push({ type: "text", lines: pending })
      pending = []
    }
  }
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/g, "")
    if (!line.trim()) { flushText(); continue }
    const banner = line.match(/^=+\s*(.+?)\s*=+$/)
    if (banner) {
      flushText()
      inSection = true
      nodes.push({ type: "section", title: banner[1] })
      continue
    }
    const indent = line.match(/^ */)[0].length
    const stripped = line.trim()
    const list = stripped.match(/^- (.*)$/)
    if (list) {
      flushText()
      push({ type: "list", items: [list[1]] })
      continue
    }
    const kv = indent >= 2
      ? stripped.match(/^([\w .()/-]{1,42}): (.+)$/)
      : stripped.match(/^([A-Z][A-Za-z ]{2,42}): (.+)$/)
    if (kv) {
      flushText()
      push({ type: "kv", key: kv[1], value: kv[2] })
      continue
    }
    pending.push(line)
  }
  flushText()
  return nodes
}
