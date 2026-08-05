/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseReadResult } from "../lib/read-many.js"
import { inputItems } from "../lib/inspect.js"
import { Activity, ContentPane, displayPath, InspectorCard, lifecycleOf, MetaGrid, OutcomeOverview, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

function requestedCount(input) {
  return new Set([...(input?.paths ?? []), ...(input?.requests ?? []).map((item) => item.path)]).size
}

function omissionFor(parsed, path) {
  return parsed.omitted.filter((item) => item.path === path)
}

function evidenceMeaning(file, omissions) {
  if (file.kind === "ranged") return `${file.ranges ?? 0} requested range${file.ranges === 1 ? " was" : "s were"} returned; unrequested parts of the file were intentionally not read.`
  if (file.bounded) return omissions.length ? `The beginning and end were returned, but the middle was omitted (${omissions.map((item) => item.lines ? `lines ${item.lines}` : item.note).join("; ")}).` : "Only bounded evidence fit the shared output budget; this is not the complete file."
  return "The complete requested file was returned; no content was omitted."
}

function FileEvidenceCard({ file, parsed, skin }) {
  const omissions = omissionFor(parsed, file.path)
  const evidence = file.evidence
  const status = file.bounded || omissions.length ? "PARTIAL SUCCESS" : "SUCCESS"
  return (
    <InspectorCard title={displayPath(file.path, 100)} skin={skin} status={status} meta={file.kind === "ranged" ? `${file.ranges ?? 0} range(s)` : file.bounded ? "partial file" : "complete file"} subtitle={evidenceMeaning(file, omissions)}>
      {evidence?.contentLines?.length ? <ContentPane title={file.kind === "ranged" ? "Lines returned" : file.bounded ? "Head and tail returned" : "File content returned"} skin={skin} lines={evidence.contentLines} limit={file.bounded ? 28 : 24} tail={false} /> : <ContentPane title="Returned content" skin={skin} lines={["The read report contained metadata but no renderable text lines for this item."]} tail={false} />}
      {omissions.length ? <ContentPane title="Not returned" skin={skin} lines={omissions.map((item) => item.note || `Middle lines ${item.lines} (${item.bytes} decoded bytes) were omitted.`)} limit={8} tail={false} color={skin.warning} /> : null}
      {evidence?.signals?.length ? <ContentPane title="Boundary and recovery notes" skin={skin} lines={evidence.signals} limit={8} tail={false} /> : null}
      <MetaGrid skin={skin} entries={[["encoding", file.encoding], ["returned bytes", file.returnedRenderedBytes], ["source bytes", file.sourceBytes], ["stable snapshot", evidence?.stable === false ? "no" : "yes"], ["sha256", file.sha256]]} />
    </InspectorCard>
  )
}

export function ReadManyView(props) {
  const parsed = createMemo(() => parseReadResult(String(props.output ?? "")))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const items = createMemo(() => parsed() ? [...parsed().files.map((file) => ({ status: file.bounded ? "PARTIAL SUCCESS" : "SUCCESS", label: displayPath(file.path, 84), meta: file.bounded ? "partial" : file.kind })), ...parsed().unavailable.map((item) => ({ status: "FAILED", label: displayPath(item.path, 84), meta: "not returned" }))] : inputItems("alonix-read-many", props.input))
  const summary = createMemo(() => lifecycle().phase === "completed" ? parsed()?.outcome ?? `Read ${items().length} targets` : `Reading ${items().length} target${items().length === 1 ? "" : "s"}`)
  const details = () => {
    const result = parsed()
    if (!result) return <RawEvidence skin={props.skin} text={lifecycle().error || props.output} />
    const requested = requestedCount(props.input)
    const partial = result.files.filter((file) => file.bounded).length
    return <>
      <OutcomeOverview skin={props.skin} status={result.status} summary={result.outcome} facts={[["requested targets", requested], ["returned targets", result.files.length], ["partial targets", partial], ["unavailable targets", result.unavailable.length]]} meaning={result.status === "SUCCESS" ? ["Everything requested was returned completely and from a stable snapshot."] : result.status === "FAILED" ? ["No usable text was returned. Review each unavailable target and any path candidates below."] : ["The returned text is usable, but it is not the whole request.", "Read each target card: it states exactly what was returned and what was left out.", "Request an exact omitted range if the missing middle is needed for the next decision."]} />
      {result.files.length ? <Section title="What you received" skin={props.skin} meta={`${result.files.length} target(s)`}>{result.files.map((file) => <FileEvidenceCard file={file} parsed={result} skin={props.skin} />)}</Section> : null}
      {result.unavailable.length ? <Section title="What could not be read" skin={props.skin} meta={`${result.unavailable.length} target(s)`} color={props.skin.error}>{result.unavailable.map((item) => <InspectorCard title={displayPath(item.path, 100)} skin={props.skin} status="FAILED" meta="not returned" subtitle={item.reason}>{result.possiblePaths.filter((line) => line.startsWith(item.path)).length ? <ContentPane title="Possible intended paths" skin={props.skin} lines={result.possiblePaths.filter((line) => line.startsWith(item.path))} limit={8} tail={false} /> : <ContentPane title="What to do" skin={props.skin} lines={["Verify the path or request a directory/search baseline before reading again."]} tail={false} />}</InspectorCard>)}</Section> : null}
      {result.consolidation.length ? <InspectorCard title="Requests simplified safely" skin={props.skin} status="SUCCESS" meta={`${result.consolidation.length} consolidation(s)`} subtitle="Duplicate or already-covered requests were merged without losing evidence."><ContentPane skin={props.skin} lines={result.consolidation} limit={12} tail={false} /></InspectorCard> : null}
      <InspectorCard title="Technical provenance" skin={props.skin} status={result.recovery.length ? "PARTIAL SUCCESS" : "SUCCESS"} meta="for verification"><MetaGrid skin={props.skin} entries={[["shared output budget", result.budget["Shared total"]], ["complete-file evidence used", result.budget["Complete-file evidence used"]], ["remaining range budget", result.budget["Remaining range budget"]], ["unstable sources", result.editContext["Unstable sources"]]]} />{result.recovery.length ? <ContentPane title="Read recovery" skin={props.skin} lines={result.recovery} limit={10} tail={false} /> : null}</InspectorCard>
    </>
  }
  return <Activity label="read" summary={summary().slice(0, 130)} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={<PreviewList skin={props.skin} items={items()} />} details={details} />
}
