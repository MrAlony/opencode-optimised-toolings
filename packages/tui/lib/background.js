function parseOperationBlock(block) {
  const lines = block.split(/\r?\n/)
  const headline = (lines.find((line) => /^(PROCESS|Start|Stop|Removed|No|Starting)/.test(line.trim())) ?? "").trim()
  const body = []
  const kv = []
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed === headline) continue
    const pair = raw.match(/^\s+([A-Za-z ]+): (.+)$/)
    if (pair) { kv.push([pair[1], pair[2]]); continue }
    body.push(raw)
  }
  return { headline, kv, body }
}

export function parseOperations(text) {
  const ops = []
  const re = /^=== OPERATION (\d+): (.*?) ===$/gm
  let match
  while ((match = re.exec(text))) {
    const start = re.lastIndex
    const next = text.indexOf("=== OPERATION", start)
    const end = next === -1 ? text.length : next
    ops.push({ num: Number(match[1]), label: match[2], ...parseOperationBlock(text.slice(start, end)) })
  }
  return ops
}

export function opColor(headline, skin) {
  if (/FAILED|Error/.test(headline)) return skin.error
  if (/READY|STATUS|completed|Removed/.test(headline)) return skin.success
  if (/Stop|stopped|kill/.test(headline)) return skin.accent
  return skin.text
}
