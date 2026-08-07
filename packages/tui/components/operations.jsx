/** @jsxImportSource @opentui/solid */
// Project Delivery Hub. Live telemetry belongs exclusively to Mission Control;
// this surface aggregates delivery state across chats and folders.

import { createMemo, createSignal, For, Show } from "solid-js"
import { GLYPH } from "../lib/design.js"
import { commandCenterModel } from "../lib/command-center.js"
import { fit, fitLeft } from "../lib/layout.js"
import { workspaceSnapshot } from "../lib/workspace.js"
import { Badge, EmptyState, StatusDot } from "./ide-kit.jsx"
import { Button, ClickRow, SegmentedControl } from "./controls.jsx"

function Board(props) {
  return (
    <box flexDirection="column" flexGrow={props.grow ? 1 : 0} flexShrink={0} minHeight={props.minHeight ?? 7} width={props.width} border borderStyle="rounded" borderColor={props.tone === "warning" ? props.tokens.warning : props.tone === "accent" ? props.tokens.accent : props.tokens.borderFaint} backgroundColor={props.tokens.panel}>
      <box flexDirection="row" height={1} flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={props.tokens.surface}>
        <text fg={props.tone === "warning" ? props.tokens.warning : props.tone === "accent" ? props.tokens.accent : props.tokens.muted}>{props.glyph ?? GLYPH.square}</text>
        <text fg={props.tokens.text}>{" "}<b>{props.title}</b></text>
        <box flexGrow={1} />
        <Show when={props.meta !== undefined}><text fg={props.tokens.faint}>{props.meta}</text></Show>
      </box>
      <box flexDirection="column" flexGrow={1} minHeight={0} paddingTop={1} paddingBottom={1}>{props.children}</box>
    </box>
  )
}

function TaskRow(props) {
  const task = () => props.task
  const tone = () => task().status === "in_progress" ? "accent" : task().status === "completed" ? "success" : "neutral"
  return (
    <ClickRow tokens={props.tokens} width={props.width} onSelect={() => props.onOpen?.(task().sessionID)}>
      <StatusDot tokens={props.tokens} tone={tone()} />
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        <text fg={props.tokens.text} wrapMode="none">{fit(task().content, Math.max(12, props.width - 14))}</text>
        <text fg={props.tokens.faint} wrapMode="none">{fit(`${task().projectName} · ${task().sessionTitle}`, Math.max(10, props.width - 10))}</text>
      </box>
      <Badge tokens={props.tokens} tone={tone()}>{task().status === "in_progress" ? "doing" : task().status}</Badge>
    </ClickRow>
  )
}

function ReviewRow(props) {
  const session = () => props.session
  return (
    <box flexDirection="row" flexShrink={0} width={props.width} gap={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="column" flexGrow={1} minWidth={0} onMouseUp={() => props.onOpen?.(session().id)} focusable>
        <text fg={props.tokens.text} wrapMode="none"><b>{fit(session().title, Math.max(12, props.width - 28))}</b></text>
        <text fg={props.tokens.faint} wrapMode="none">{fit(`${session().projectName} · ${session().changedFiles} files · ${session().activeTodos} open tasks`, Math.max(10, props.width - 24))}</text>
      </box>
      <Button tokens={props.tokens} size="sm" variant="secondary" onPress={() => props.onOpen?.(session().id)}>Open</Button>
      <Button tokens={props.tokens} size="sm" variant="primary" onPress={() => props.onReviewed?.(session().id)}>Reviewed</Button>
    </box>
  )
}

function SessionRow(props) {
  const session = () => props.session
  return (
    <ClickRow tokens={props.tokens} width={props.width} onSelect={() => props.onOpen?.(session().id)}>
      <StatusDot tokens={props.tokens} tone={session().attention ? "warning" : session().lastFailed ? "error" : "neutral"} />
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        <text fg={props.tokens.text} wrapMode="none"><b>{fit(session().title, Math.max(10, props.width - 20))}</b></text>
        <text fg={props.tokens.faint} wrapMode="none">{fit(`${session().projectName} · ${session().activeTodos} open tasks`, Math.max(8, props.width - 12))}</text>
      </box>
      <Show when={session().attention > 0}><Badge tokens={props.tokens} tone="warning">needs you</Badge></Show>
    </ClickRow>
  )
}

function DecisionRow(props) {
  const decision = () => props.decision
  return (
    <box flexDirection="row" flexShrink={0} width={props.width} gap={1} paddingLeft={1} paddingRight={1}>
      <text fg={props.tokens.accent}>{GLYPH.diamond}</text>
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        <text fg={props.tokens.text} wrapMode="wrap">{decision().text}</text>
        <text fg={props.tokens.faint} wrapMode="none">{fit(decision().projectName || "portfolio decision", Math.max(10, props.width - 12))}</text>
      </box>
      <Button tokens={props.tokens} size="sm" variant="secondary" onPress={() => props.onRemove?.(decision().id)}>{GLYPH.close}</Button>
    </box>
  )
}

function CollisionRow(props) {
  const collision = () => props.collision
  return (
    <box flexDirection="row" flexShrink={0} width={props.width} gap={1} paddingLeft={1} paddingRight={1}>
      <text fg={collision().active ? props.tokens.warning : props.tokens.muted}>{GLYPH.diamond}</text>
      <text fg={props.tokens.text} wrapMode="none">{fitLeft(collision().file, Math.max(12, props.width - 20))}</text>
      <box flexGrow={1} />
      <Badge tokens={props.tokens} tone={collision().active ? "warning" : "neutral"}>{collision().owners.length} chats</Badge>
    </box>
  )
}

function ProjectLane(props) {
  const project = () => props.project
  return (
    <ClickRow tokens={props.tokens} width={props.width} onSelect={() => project().latest && props.onOpen?.(project().latest.id)}>
      <StatusDot tokens={props.tokens} tone={project().health === "attention" ? "warning" : "success"} />
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        <text fg={props.tokens.text} wrapMode="none"><b>{fit(project().name, Math.max(10, props.width - 28))}</b></text>
        <text fg={props.tokens.faint} wrapMode="none">{fitLeft(project().worktree || "", Math.max(8, props.width - 18))}</text>
      </box>
      <Show when={project().openTasks > 0}><text fg={props.tokens.muted}>{project().openTasks} tasks</text></Show>
      <Show when={project().reviews > 0}><Badge tokens={props.tokens} tone="warning">{project().reviews} review</Badge></Show>
    </ClickRow>
  )
}

export function OperationsWorkspace(props) {
  const tokens = props.tokens
  const [scope, setScope] = createSignal(props.selectedProjectID ? "selected" : "all")
  const enrichedSessions = createMemo(() => Array.from(props.sessions?.() ?? []).map((session) => {
    const snapshot = workspaceSnapshot(props.api, session.id)
    return {
      ...session,
      todos: snapshot.todos.length ? snapshot.todos : session.todos,
      files: snapshot.files.length ? snapshot.files : session.files,
      activeTodos: snapshot.todos.length ? snapshot.activeTodos : Array.from(session.todos ?? []).filter((item) => item?.status !== "completed" && item?.status !== "cancelled").length,
      completedTodos: snapshot.todos.length ? snapshot.completedTodos : Array.from(session.todos ?? []).filter((item) => item?.status === "completed").length,
      attention: snapshot.attention,
      lastFailed: false,
    }
  }))
  const model = createMemo(() => commandCenterModel({
    sessions: enrichedSessions(),
    projects: props.projects?.(),
    scope: scope(),
    selectedProjectID: props.selectedProjectID,
    reviewed: props.delivery?.reviewed,
    decisions: props.delivery?.decisions,
  }))
  const wide = createMemo(() => props.width >= 104)
  const columnWidth = createMemo(() => wide() ? Math.max(42, Math.floor((props.width - 1) / 2)) : props.width)
  const taskRows = createMemo(() => model().tasks.slice(0, 20))
  const reviewRows = createMemo(() => model().review.slice(0, 12))
  const unresolvedRows = createMemo(() => model().unresolved.slice(0, 12))
  const decisionRows = createMemo(() => model().decisions.slice(0, 12))
  const collisionRows = createMemo(() => model().collisions.slice(0, 10))
  const outcomeRows = createMemo(() => model().outcomes.slice(0, 10))
  const lanes = createMemo(() => model().lanes.slice(0, 20))

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} paddingLeft={1} paddingRight={1} gap={1}>
      <box flexDirection="row" flexShrink={0} minHeight={3} paddingLeft={1} paddingRight={1} alignItems="center" backgroundColor={tokens().surface} gap={1}>
        <box flexDirection="column" flexGrow={1} minWidth={0}>
          <text fg={tokens().text}><b>Project Delivery Hub</b></text>
          <text fg={tokens().muted}>Deliver, review, resolve and remember work across chats. Live telemetry stays in Mission Control.</text>
        </box>
        <SegmentedControl tokens={tokens()} value={scope()} onChange={setScope} items={[{ value: "all", label: "Portfolio" }, { value: "selected", label: "Selected folder", count: props.selectedProjectID ? undefined : 0 }]} />
        <Button tokens={tokens()} variant="primary" glyph={GLYPH.plus} onPress={() => props.onAddDecision?.(model().projects.find((item) => item.current) ?? model().projects[0])}>Add decision</Button>
      </box>

      <box flexDirection="row" flexShrink={0} gap={1} flexWrap="wrap">
        <Badge tokens={tokens()} tone={model().stats.openTasks ? "accent" : "neutral"}>{model().stats.openTasks} open tasks</Badge>
        <Badge tokens={tokens()} tone={model().stats.review ? "warning" : "neutral"}>{model().stats.review} reviews</Badge>
        <Badge tokens={tokens()} tone={model().stats.unresolved ? "warning" : "neutral"}>{model().stats.unresolved} unresolved</Badge>
        <Badge tokens={tokens()} tone={model().stats.collisions ? "warning" : "neutral"}>{model().stats.collisions} overlaps</Badge>
        <Badge tokens={tokens()} tone="neutral">{model().stats.decisions} decisions</Badge>
      </box>

      <Show when={props.ready || model().stats.chats > 0} fallback={<EmptyState tokens={tokens()} title="Building delivery intelligence" hint="Loading folders and chats before calculating project-wide tasks, reviews and risks." />}>
        <scrollbox flexGrow={1} stickyScroll={false}>
          <box flexDirection={wide() ? "row" : "column"} flexShrink={0} gap={1}>
            <Board tokens={tokens()} title="Unified project tasks" glyph={GLYPH.pointer} tone="accent" meta={`${model().stats.openTasks} open`} width={columnWidth()} minHeight={12}>
              <Show when={taskRows().length} fallback={<text fg={tokens().muted}>{"  "}No synced chat tasks in this scope.</text>}>
                <For each={taskRows()}>{(task) => <TaskRow tokens={tokens()} task={task} width={columnWidth()} onOpen={props.onOpen} />}</For>
              </Show>
            </Board>
            <Board tokens={tokens()} title="Review queue" glyph={GLYPH.diamond} tone={reviewRows().length ? "warning" : "neutral"} meta={`${model().stats.changedFiles} files`} width={columnWidth()} minHeight={12}>
              <Show when={reviewRows().length} fallback={<text fg={tokens().muted}>{"  "}No completed change sets are waiting for review.</text>}>
                <For each={reviewRows()}>{(session) => <ReviewRow tokens={tokens()} session={session} width={columnWidth()} onOpen={props.onOpen} onReviewed={props.onReviewed} />}</For>
              </Show>
            </Board>
          </box>

          <box flexDirection={wide() ? "row" : "column"} flexShrink={0} gap={1} marginTop={1}>
            <Board tokens={tokens()} title="Unresolved work" glyph={GLYPH.ring} tone={unresolvedRows().length ? "warning" : "neutral"} meta={unresolvedRows().length} width={columnWidth()} minHeight={10}>
              <Show when={unresolvedRows().length} fallback={<text fg={tokens().muted}>{"  "}No paused chats have unfinished tasks or blockers.</text>}>
                <For each={unresolvedRows()}>{(session) => <SessionRow tokens={tokens()} session={session} width={columnWidth()} onOpen={props.onOpen} />}</For>
              </Show>
            </Board>
            <Board tokens={tokens()} title="Decisions & memory" glyph={GLYPH.diamond} tone="accent" meta={decisionRows().length} width={columnWidth()} minHeight={10}>
              <Show when={decisionRows().length} fallback={<box paddingLeft={2} paddingRight={2} gap={1}><text fg={tokens().muted}>Record constraints and choices the project must remember.</text><Button tokens={tokens()} variant="primary" glyph={GLYPH.plus} onPress={() => props.onAddDecision?.(model().projects.find((item) => item.current) ?? model().projects[0])}>Add first decision</Button></box>}>
                <For each={decisionRows()}>{(decision) => <DecisionRow tokens={tokens()} decision={decision} width={columnWidth()} onRemove={props.onRemoveDecision} />}</For>
              </Show>
            </Board>
          </box>

          <box flexDirection={wide() ? "row" : "column"} flexShrink={0} gap={1} marginTop={1}>
            <Board tokens={tokens()} title="Cross-chat change overlaps" glyph={GLYPH.diamond} tone={collisionRows().length ? "warning" : "neutral"} meta={collisionRows().length} width={columnWidth()} minHeight={8}>
              <Show when={collisionRows().length} fallback={<text fg={tokens().muted}>{"  "}No known files are touched by multiple chats.</text>}>
                <For each={collisionRows()}>{(collision) => <CollisionRow tokens={tokens()} collision={collision} width={columnWidth()} />}</For>
              </Show>
            </Board>
            <Board tokens={tokens()} title="Recent completed outcomes" glyph={GLYPH.ok} tone="neutral" meta={outcomeRows().length} width={columnWidth()} minHeight={8}>
              <Show when={outcomeRows().length} fallback={<text fg={tokens().muted}>{"  "}Completed task outcomes will appear here.</text>}>
                <For each={outcomeRows()}>{(session) => <SessionRow tokens={tokens()} session={session} width={columnWidth()} onOpen={props.onOpen} />}</For>
              </Show>
            </Board>
          </box>

          <box marginTop={1}>
            <Board tokens={tokens()} title="Project health" glyph={GLYPH.square} meta={`${model().stats.projects} folders`} width={props.width} minHeight={10}>
              <Show when={lanes().length} fallback={<text fg={tokens().muted}>{"  "}Add a folder to build the delivery portfolio.</text>}>
                <For each={lanes()}>{(project) => <ProjectLane tokens={tokens()} project={project} width={props.width} onOpen={props.onOpen} />}</For>
              </Show>
            </Board>
          </box>
        </scrollbox>
      </Show>
    </box>
  )
}
