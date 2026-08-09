// Pure keyed selection and exact painted-row virtualization for the palette.

export function paletteDisplayRows(groups) {
  const out = []
  for (const group of Array.from(groups ?? [])) {
    const rows = Array.from(group?.rows ?? [])
    if (!rows.length) continue
    out.push({ kind: "group", key: `group:${group.kind}`, label: group.label, count: rows.length })
    for (const action of rows) out.push({ kind: "row", key: `action:${action.id}`, action, actionID: action.id })
  }
  return out
}

export function preservePaletteSelection(actions, selectedID, fallbackIndex = 0) {
  const rows = Array.from(actions ?? [])
  if (!rows.length) return { id: "", index: 0 }
  const anchored = rows.findIndex((item) => item?.id === selectedID)
  const index = anchored >= 0 ? anchored : Math.max(0, Math.min(rows.length - 1, Math.floor(Number(fallbackIndex) || 0)))
  return { id: String(rows[index]?.id ?? ""), index }
}

export function paletteWindow(displayRows, selectedID, offset = 0, rowBudget = 1) {
  const rows = Array.from(displayRows ?? [])
  const budget = Math.max(1, Math.floor(Number(rowBudget) || 1))
  const selectedRow = Math.max(0, rows.findIndex((row) => row.kind === "row" && row.actionID === selectedID))
  let start = Math.max(0, Math.min(Math.floor(Number(offset) || 0), Math.max(0, rows.length - budget)))
  if (selectedRow < start) start = selectedRow
  if (selectedRow >= start + budget) start = selectedRow - budget + 1
  start = Math.max(0, Math.min(start, Math.max(0, rows.length - budget)))
  return { rows: rows.slice(start, start + budget), start, end: Math.min(rows.length, start + budget), selectedRow }
}
