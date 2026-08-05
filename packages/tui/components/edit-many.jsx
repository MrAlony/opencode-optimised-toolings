/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { parseEditResult } from "../lib/edit-many.js"
import { inputItems } from "../lib/inspect.js"
import { Activity, DetailLines, displayPath, lifecycleOf, MetaGrid, PreviewList, RawEvidence, resolvedStatus, Section, statusLabel } from "./kit.jsx"

function intendedActions(input, path) {
  return (input?.actions ?? []).filter((action) => action.path === path).map((action) => {
    if (action.operation === "patch") return `patch · ${action.replacements?.length ?? 0} exact replacement(s)`
    if (action.operation === "create") return `create · ${String(action.content ?? "").split(/\r?\n/).length} line(s)`
    return `overwrite · ${String(action.content ?? "").split(/\r?\n/).length} line(s)`
  })
}

function IntendedDetails({ input, path, skin }) {
  const actions = (input?.actions ?? []).filter((action) => action.path === path)
  return <>{actions.map((action, actionIndex) => <Section title={`${action.operation} ${actionIndex + 1}`} skin={skin}>{action.operation === "patch" ? (action.replacements ?? []).slice(0, 6).map((replacement, index) => <Section title={`Exact replacement ${index + 1}`} skin={skin} meta={`expected ${replacement.expected_count ?? 1}`}><DetailLines skin={skin} lines={String(replacement.search ?? "").split(/\r?\n/).map((line) => `- ${line}`)} limit={8} color={skin.error} tail={false} /><DetailLines skin={skin} lines={String(replacement.replace ?? "").split(/\r?\n/).map((line) => `+ ${line}`)} limit={8} color={skin.success} tail={false} /></Section>) : <DetailLines skin={skin} lines={String(action.content ?? "").split(/\r?\n/)} limit={12} color={skin.text} tail={false} />}</Section>)}</>
}

export function EditManyView(props) {
  const parsed = createMemo(() => parseEditResult(String(props.output ?? "")))
  const lifecycle = createMemo(() => lifecycleOf(props.part))
  const status = createMemo(() => resolvedStatus(props.part, parsed()?.status))
  const items = createMemo(() => parsed() ? [...parsed().applied.map((file) => ({ status: "SUCCESS", label: displayPath(file.path, 84), meta: file.kind })), ...parsed().unchanged.map((file) => ({ status: "SUCCESS", label: displayPath(file.path, 84), meta: "unchanged" })), ...parsed().rejected.map((file) => ({ status: "FAILED", label: displayPath(file.path, 84), meta: "rejected" }))] : inputItems("fs_edit_many", props.input))
  const summary = createMemo(() => lifecycle().phase === "completed" ? parsed()?.outcome ?? `Processed ${items().length} files` : `Preparing ${items().length} file transaction${items().length === 1 ? "" : "s"}`)
  const fileSection = (file, rejected = false) => <Section title={displayPath(file.path, 100)} skin={props.skin} color={rejected ? props.skin.error : props.skin.success} meta={rejected ? "not changed" : file.kind}><MetaGrid skin={props.skin} entries={rejected ? [["failed step", file.failedStep], ["expected", file.expected], ["observed", file.observed], ["safety", file.safety]] : [["actions evaluated", file.actions], ["final size", file.size], ["sha256", file.sha256], ["aliases", file.aliases?.join(", ")]]} /><Section title="Intended transaction" skin={props.skin}><DetailLines skin={props.skin} lines={intendedActions(props.input, file.path)} tail={false} /><IntendedDetails input={props.input} path={file.path} skin={props.skin} /></Section>{!rejected ? <DetailLines skin={props.skin} lines={[...file.recovery, ...file.noOps]} /> : null}</Section>
  return <Activity label="edit" summary={summary().slice(0, 130)} meta={statusLabel(status(), lifecycle())} status={status()} pending={lifecycle().pending} skin={props.skin} preview={<PreviewList skin={props.skin} items={items()} />} openDefault={Boolean(parsed()?.rejected.length)} details={() => parsed() ? <><Section title="Committed files" skin={props.skin} meta={`${parsed().applied.length} changed`}>{parsed().applied.map((file) => fileSection(file))}</Section>{parsed().unchanged.length ? <Section title="Already satisfied" skin={props.skin}>{parsed().unchanged.map((file) => fileSection(file))}</Section> : null}{parsed().rejected.length ? <Section title="Rejected safely" skin={props.skin} color={props.skin.error}>{parsed().rejected.map((file) => fileSection(file, true))}</Section> : null}<Section title="Transaction safety" skin={props.skin}><MetaGrid skin={props.skin} entries={Object.entries(parsed().technicalSummary)} /><DetailLines skin={props.skin} lines={[parsed().safetyModel, ...parsed().readWriteRecovery]} /></Section></> : <><Section title="Requested operations" skin={props.skin}>{(props.input?.actions ?? []).map((action) => <Section title={displayPath(action.path, 100)} skin={props.skin} meta={action.operation}><DetailLines skin={props.skin} lines={intendedActions(props.input, action.path)} tail={false} /><IntendedDetails input={props.input} path={action.path} skin={props.skin} /></Section>)}</Section><RawEvidence skin={props.skin} text={lifecycle().error || props.output} /></>} />
}
