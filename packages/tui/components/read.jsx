/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseReadResult } from "../lib/read.js"
import { inputPlanAvailable, pendingPlanSummary, reconcileBatch } from "../lib/batch.js"
import { inputItems } from "../lib/inspect.js"
import { Activity, ContentPane, displayPath, InspectorCard, InspectorDegraded, InspectorUnavailable, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, resolvedStatus, Section, statusLabel, statusPending } from "./kit.jsx"

function requestedCount(input) { return new Set([...(input?.paths ?? []), ...(input?.requests ?? []).map((item) => item.path)]).size }
function omissionFor(parsed, path) { return parsed.omitted.filter((item) => item.path === path) }
function fileStatus(file, parsed) { return file.bounded || omissionFor(parsed, file.path).length ? "PARTIAL SUCCESS" : "SUCCESS" }
function evidenceMeaning(file, omissions) {
  if (file.kind === "ranged") return `${file.ranges ?? 0} requested range${file.ranges === 1 ? " was" : "s were"} returned. Unrequested portions were intentionally not read.`
  if (file.bounded) return omissions.length ? `The beginning and end were returned; ${omissions.map((item) => item.lines ? `lines ${item.lines}` : item.note).join("; ")} were omitted.` : "Bounded evidence was returned; this is not the complete file."
  return "The complete requested file was returned."
}
function FileEvidenceCard({ file, parsed, skin }) {
  const omissions = omissionFor(parsed, file.path)
  const evidence = file.evidence
  const status = fileStatus(file, parsed)
  return <InspectorCard title={displayPath(file.path, 100)} skin={skin} status={status} meta={file.kind === "ranged" ? `${file.ranges ?? 0} range(s)` : file.bounded ? "partial" : "complete"} subtitle={evidenceMeaning(file, omissions)}>
    {evidence?.contentLines?.length ? <ContentPane title={file.kind === "ranged" ? "Requested lines" : file.bounded ? "Returned head and tail" : "Returned file"} skin={skin} lines={evidence.contentLines} limit={file.bounded ? 28 : 24} tail={false} /> : <ContentPane title="Returned content" skin={skin} lines={["The report confirmed this target but contained no renderable text lines."]} tail={false} />}
    {omissions.length ? <ContentPane title="Not returned" skin={skin} lines={omissions.map((item) => item.note || `Middle lines ${item.lines} (${item.bytes} decoded bytes) were omitted.`)} limit={8} tail={false} color={skin.warning} /> : null}
    {evidence?.signals?.length ? <ContentPane title="Boundary notes" skin={skin} lines={evidence.signals} limit={8} tail={false} /> : null}
    <MetaGrid skin={skin} entries={[["encoding", file.encoding], ["returned bytes", file.returnedRenderedBytes], ["source bytes", file.sourceBytes], ["stable snapshot", evidence?.stable === false ? "no" : "yes"], ["sha256", file.sha256]]} />
  </InspectorCard>
}

export function ReadView(props) {
  const parsed = createMemo(() => parseReadResult(String(props.output ?? "")))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const plan = createMemo(() => inputItems("alonix-read", props.input))
  const planReady = createMemo(() => inputPlanAvailable("alonix-read", props.input))
  const observed = createMemo(() => parsed() ? [...parsed().files.map((file) => ({ status: fileStatus(file, parsed()), label: file.path, meta: file.bounded ? "partial" : file.kind })), ...parsed().unavailable.map((item) => ({ status: "FAILED", label: item.path, meta: "unavailable" }))] : [])
  const batch = createMemo(() => reconcileBatch(plan(), observed()))
  const items = createMemo(() => batch().records.map((item) => ({ ...item, label: displayPath(item.label, 84) })))
  const summary = createMemo(() => parsed() ? `${batch().plannedCount} target${batch().plannedCount === 1 ? "" : "s"} · ${parsed().files.length} returned${parsed().unavailable.length ? ` · ${parsed().unavailable.length} unavailable` : ""}${batch().omitted.length ? ` · ${batch().omitted.length} details omitted` : ""}` : pendingPlanSummary(planReady(), requestedCount(props.input), "target"))
  const details = () => {
    const result = parsed()
    if (!result) {
      if (statusPending(status())) return <InspectorCard title={planReady() ? "Read plan" : "Preparing read"} skin={props.skin} status={status()} pending meta={planReady() ? `${requestedCount(props.input)} target(s)` : "input pending"}>{planReady() ? <PreviewList skin={props.skin} items={items()} limit={12} /> : <text fg={props.skin.muted}>Waiting for OpenCode to attach the validated read targets.</text>}</InspectorCard>
      if (lifecycle().phase === "error") return <InspectorUnavailable skin={props.skin} message={lifecycle().error} />
      return <InspectorDegraded skin={props.skin} items={items()} message={`The completed read output was bounded before the READ RESULT header. All ${requestedCount(props.input)} requested targets remain visible; source evidence is preserved in OpenCode's saved tool output.`} />
    }
    const partial = result.files.filter((file) => fileStatus(file, result) === "PARTIAL SUCCESS").length
    return <>
      <OutcomeOverview skin={props.skin} status={result.status} summary={result.outcome} facts={[["requested", requestedCount(props.input)], ["returned", result.files.length], ["partial", partial], ["unavailable", result.unavailable.length], ["details omitted", batch().omitted.length]]} meaning={batch().omitted.length ? ["The request plan remains authoritative; bounded output omitted structured details for some targets.", "Use the saved tool output when the omitted source evidence is needed."] : result.status === "SUCCESS" ? ["Every requested target was returned completely and stably."] : result.status === "FAILED" ? ["No usable text was returned. Review unavailable targets and path guidance."] : ["Usable evidence was returned, but part of the request is missing.", "Each target below states exactly what was returned and omitted.", "Request an exact omitted range when the missing middle matters."]} />
      {result.files.length ? <Section title="Returned targets" skin={props.skin} meta={`${result.files.length}`} >{result.files.map((file) => <FileEvidenceCard file={file} parsed={result} skin={props.skin} />)}</Section> : null}
      {result.unavailable.length ? <Section title="Unavailable targets" skin={props.skin} meta={`${result.unavailable.length}`} color={props.skin.error}>{result.unavailable.map((item) => <InspectorCard title={displayPath(item.path, 100)} skin={props.skin} status="FAILED" meta="not returned" subtitle={item.reason}><ContentPane title="Next action" skin={props.skin} lines={result.possiblePaths.filter((line) => line.startsWith(item.path)).length ? result.possiblePaths.filter((line) => line.startsWith(item.path)) : ["Verify the path or run a directory/search baseline before reading again."]} limit={8} tail={false} /></InspectorCard>)}</Section> : null}
      {batch().omitted.length ? <Section title="Requested targets without visible detail" skin={props.skin} meta={`${batch().omitted.length}`}>{batch().omitted.map((item) => <InspectorDegraded skin={props.skin} title={displayPath(item.label, 100)} />)}</Section> : null}
      {result.consolidation.length ? <InspectorCard title="Requests consolidated" skin={props.skin} status="SUCCESS" meta={`${result.consolidation.length}`}><ContentPane skin={props.skin} lines={result.consolidation} limit={12} tail={false} /></InspectorCard> : null}
      <InspectorCard title="Provenance" skin={props.skin} status={result.recovery.length ? "PARTIAL SUCCESS" : "SUCCESS"}><MetaGrid skin={props.skin} entries={[["shared budget", result.budget["Shared total"]], ["evidence used", result.budget["Complete-file evidence used"]], ["remaining range budget", result.budget["Remaining range budget"]], ["unstable sources", result.editContext["Unstable sources"]]]} />{result.recovery.length ? <ContentPane title="Recovery" skin={props.skin} lines={result.recovery} limit={10} tail={false} /> : null}</InspectorCard>
    </>
  }
  return <Activity evidence={props.output} label="Read" summary={summary()} meta={statusLabel(status())} status={status()} pending={statusPending(status())} skin={props.skin} preview={items().length ? <PreviewList skin={props.skin} items={items()} /> : null} details={details} />
}
