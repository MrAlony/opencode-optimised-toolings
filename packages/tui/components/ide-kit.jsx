/** @jsxImportSource @opentui/solid */
// Visual primitives for the Alonix IDE.
//
// Every surface composes these so spacing, tone, motion, and focus behaviour
// stay consistent. Components are presentation-only: they never mutate host
// state and never own navigation.

import { createMemo, For, Show } from "solid-js"
import { GLYPH, tonePalette } from "../lib/design.js"
import { fit, fitLeft, pad } from "../lib/layout.js"
import { marquee, progressBar, spinnerFrame, sparkline, stagger, sweepBar, slideIn } from "../lib/motion.js"
import { useClock } from "./runtime.jsx"

function tones(props) {
  return tonePalette(props.tokens, props.tone ?? "neutral")
}

/** Thin horizontal divider that reads as a rule rather than a border box. */
export function Rule(props) {
  return (
    <box
      height={1}
      flexShrink={0}
      backgroundColor={props.color ?? props.tokens.borderFaint}
      marginTop={props.spaced ? 1 : 0}
      marginBottom={props.spaced ? 1 : 0}
    />
  )
}

/** Uppercase section label with an optional trailing count. */
export function SectionLabel(props) {
  return (
    <text fg={props.color ?? props.tokens.faint} wrapMode="none" selectable={false}>
      <b>{String(props.children ?? "").toUpperCase()}</b>
      <Show when={props.meta}>
        <span style={{ fg: props.tokens.faint }}>{"  "}{props.meta}</span>
      </Show>
    </text>
  )
}

/** Small filled chip used for counts and states. */
export function Badge(props) {
  const palette = createMemo(() => tones(props))
  return (
    <box
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.solid ? palette().fg : palette().surface}
    >
      <text fg={props.solid ? props.tokens.inverse : palette().on} wrapMode="none" selectable={false}>
        {props.children}
      </text>
    </box>
  )
}

/**
 * Live status dot. Pulses through the shared clock while `pulse` is true, so a
 * busy workspace is visible without reading any text.
 */
export function StatusDot(props) {
  const clock = useClock(() => props.pulse === true && props.tokens.motion !== false)
  const glyph = createMemo(() => {
    if (!props.pulse || props.tokens.motion === false) return props.glyph ?? GLYPH.dot
    return spinnerFrame(clock(), ["●", "◉", "◎", "◉"], 260, true)
  })
  return (
    <text fg={tones(props).fg} wrapMode="none" selectable={false}>
      {glyph()}
    </text>
  )
}

/** Spinner that falls back to a static glyph when motion is disabled. */
export function Spinner(props) {
  const clock = useClock(() => props.tokens.motion !== false)
  return (
    <text fg={tones(props).fg} wrapMode="none" selectable={false}>
      {spinnerFrame(clock(), props.frames, props.interval ?? 90, props.tokens.motion !== false)}
    </text>
  )
}

/**
 * Progress track. Determinate when `percent` is a number, indeterminate sweep
 * otherwise, so "working" always looks different from "stalled".
 */
export function Gauge(props) {
  const clock = useClock(() => props.active === true && props.tokens.motion !== false)
  const width = createMemo(() => Math.max(4, Math.floor(props.width ?? 12)))
  const bar = createMemo(() => {
    const percent = Number(props.percent)
    if (Number.isFinite(percent)) return progressBar(percent, width())
    return sweepBar(clock(), width(), props.tokens.motion !== false)
  })
  return (
    <text fg={tones(props).fg} wrapMode="none" selectable={false}>
      {bar()}
    </text>
  )
}

/** Compact bar sparkline for trend data. */
export function Sparkline(props) {
  return (
    <text fg={tones(props).fg} wrapMode="none" selectable={false}>
      {sparkline(props.values, props.width ?? 12)}
    </text>
  )
}

/**
 * Label that scrolls horizontally only when it does not fit and only while
 * `active`, so idle rows stay still and readable.
 */
export function ScrollingLabel(props) {
  const clock = useClock(() => props.active === true && props.tokens.motion !== false)
  const text = createMemo(() =>
    marquee(props.children ?? "", props.width ?? 24, clock(), props.active === true && props.tokens.motion !== false),
  )
  return (
    <text fg={props.color ?? props.tokens.text} wrapMode="none" selectable={false}>
      {props.bold ? <b>{text()}</b> : text()}
    </text>
  )
}

/** Key/value line used across panels; the value is right-aligned. */
export function StatLine(props) {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={props.tokens.muted} wrapMode="none" selectable={false}>
        {fit(props.label, props.labelWidth ?? 18)}
      </text>
      <text fg={props.color ?? props.tokens.text} wrapMode="none" selectable={false}>
        {props.children}
      </text>
    </box>
  )
}

/**
 * Panel: the primary container. A tinted left rail replaces a full border box,
 * which keeps vertical rhythm tight in a terminal and still groups content.
 */
export function Panel(props) {
  const palette = createMemo(() => tones(props))
  return (
    <box flexDirection="column" flexShrink={0} gap={0} marginBottom={props.flush ? 0 : 1}>
      <Show when={props.title}>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={palette().fg} wrapMode="none" selectable={false}>
            {props.glyph ?? GLYPH.square}
          </text>
          <SectionLabel tokens={props.tokens} meta={props.meta} color={props.tokens.faint}>
            {props.title}
          </SectionLabel>
          <Show when={props.accessory}>
            <box flexGrow={1} />
            {props.accessory}
          </Show>
        </box>
      </Show>
      <box
        flexDirection="column"
        flexShrink={0}
        paddingLeft={props.inset === false ? 0 : 1}
        paddingTop={props.title ? 1 : 0}
        gap={props.gap ?? 0}
      >
        {props.children}
      </box>
    </box>
  )
}

/**
 * Selectable row.
 *
 * Selection is expressed with a solid accent bar plus a surface tint rather
 * than colour alone, so it remains legible on low-contrast terminal themes.
 */
export function Row(props) {
  const clock = useClock(() => props.animateIndex !== undefined && props.tokens.motion !== false)
  const entrance = createMemo(() => {
    if (props.animateIndex === undefined || props.tokens.motion === false) return 1
    return stagger(clock(), props.animateIndex)
  })
  const palette = createMemo(() => tones(props))
  const background = createMemo(() => {
    if (props.selected) return props.tokens.selectionStrong
    if (props.hover) return props.tokens.hover
    return undefined
  })
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      gap={1}
      paddingLeft={slideIn(entrance(), 2)}
      paddingRight={1}
      backgroundColor={background()}
      onMouseDown={props.onSelect}
      onMouseOver={props.onHover}
    >
      <text fg={props.selected ? props.tokens.accent : props.tokens.borderFaint} wrapMode="none" selectable={false}>
        {props.selected ? GLYPH.blockHalf : " "}
      </text>
      <Show when={props.leading}>{props.leading}</Show>
      <box flexGrow={1} flexDirection="column" minWidth={0}>
        {props.children}
      </box>
      <Show when={props.trailing}>{props.trailing}</Show>
      <Show when={props.meta}>
        <text fg={props.selected ? palette().on : props.tokens.faint} wrapMode="none" selectable={false}>
          {props.meta}
        </text>
      </Show>
    </box>
  )
}

/** Consistent empty state so blank panels never look broken. */
export function EmptyState(props) {
  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1} paddingBottom={1} gap={0}>
      <text fg={props.tokens.muted} wrapMode="none" selectable={false}>
        {props.glyph ?? GLYPH.ring} {props.title}
      </text>
      <Show when={props.hint}>
        <text fg={props.tokens.faint} wrapMode="none" selectable={false}>
          {"  "}
          {props.hint}
        </text>
      </Show>
    </box>
  )
}

/** Footer hint strip: `key` chips followed by their action. */
export function KeyHints(props) {
  const items = createMemo(() => Array.from(props.hints ?? []).filter((hint) => hint && hint.key))
  return (
    <box flexDirection="row" gap={2} flexShrink={0} flexWrap="wrap">
      <For each={items()}>
        {(hint) => (
          <text fg={props.tokens.faint} wrapMode="none" selectable={false}>
            <span style={{ fg: props.tokens.muted }}>{hint.key}</span> {hint.label}
          </text>
        )}
      </For>
    </box>
  )
}

/** Diff counters rendered as a single aligned unit. */
export function DiffStat(props) {
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <Show when={Number(props.additions) > 0}>
        <text fg={props.tokens.success} wrapMode="none" selectable={false}>
          +{props.additions}
        </text>
      </Show>
      <Show when={Number(props.deletions) > 0}>
        <text fg={props.tokens.error} wrapMode="none" selectable={false}>
          -{props.deletions}
        </text>
      </Show>
    </box>
  )
}

/** Path shown as dim directory + bright filename. */
export function PathLabel(props) {
  return (
    <text fg={props.tokens.text} wrapMode="none" selectable={false}>
      <Show when={props.dir}>
        <span style={{ fg: props.tokens.faint }}>{fitLeft(props.dir, props.dirWidth ?? 18)}/</span>
      </Show>
      {fit(props.name, props.nameWidth ?? 22)}
    </text>
  )
}

/** Fixed-width metric tile for header and deck grids. */
export function MetricTile(props) {
  const palette = createMemo(() => tones(props))
  return (
    <box flexDirection="column" flexShrink={0} width={props.width ?? 12}>
      <text fg={palette().fg} wrapMode="none" selectable={false}>
        <b>{pad(String(props.value), props.width ?? 12)}</b>
      </text>
      <text fg={props.tokens.faint} wrapMode="none" selectable={false}>
        {pad(props.label, props.width ?? 12)}
      </text>
    </box>
  )
}
