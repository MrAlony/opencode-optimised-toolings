const inlineSignal = /\[(?:[^\]]*(?:ADVISORY|ADVICE|SIGNAL|RECOVERY|ENFORCEMENT|WARNING|ESCALATION|NOTICE|CRITICAL|TRUNCAT|BOUND|OMITTED|PORTABILITY|CLEANUP)[^\]]*)\]/i
const sectionHeader = /^(?:--- )?(?:TECHNICAL STATUS|AUTOMATIC RECOVERY|READ\/WRITE RECOVERY(?: \(\d+\))?|READ RECOVERY(?: \(\d+\))?|LIMITS AND RECOVERY|RECOVERY SIGNALS|BOUNDED OR OMITTED EVIDENCE(?: \(\d+\))?|UNAVAILABLE TARGETS(?: \(\d+\))?|OUTPUT BUDGET|EDIT CONTEXT|SAFETY MODEL):?/i
const nextSection = /^(?:--- .+ ---|[A-Z][A-Z /-]+(?: \(\d+\))?:|=== .+ ===)$/

export function diagnosticEvidenceLines(text, options = {}) {
  const lines = String(text ?? "").split(/\r?\n/)
  const contextLimit = Math.max(1, options.contextLimit ?? 8)
  const selected = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (inlineSignal.test(trimmed)) {
      selected.push(line)
      continue
    }
    if (!sectionHeader.test(trimmed)) continue
    selected.push(line)
    let context = 0
    for (let cursor = index + 1; cursor < lines.length && context < contextLimit; cursor += 1) {
      const next = lines[cursor]
      const value = next.trim()
      if (value && nextSection.test(value)) break
      selected.push(next)
      context += 1
    }
  }
  return [...new Set(selected)].filter((line, index, all) => line.trim() || (index > 0 && index < all.length - 1 && all[index - 1].trim() && all[index + 1].trim()))
}
