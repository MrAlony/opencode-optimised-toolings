/** @jsxImportSource @opentui/solid */
// Mouse-first controls.
//
// The workbench must be fully usable without knowing any shortcut, so every
// control here is a real click target with visible hover feedback. Each also
// advertises its keyboard equivalent, so pointer use teaches the shortcut
// instead of hiding it.

import { createMemo, createSignal, For, Show } from "solid-js"
import { GLYPH, tonePalette } from "../lib/design.js"
import { fit } from "../lib/layout.js"
import { spinnerFrame } from "../lib/motion.js"
import { useClock } from "./runtime.jsx"

/** Clickable button with hover and pressed affordances. */
export function Button(props) {
  const [hover, setHover] = createSignal(false)
  const palette = createMemo(() => tonePalette(props.tokens, props.tone ?? "neutral"))
  const disabled = () => props.disabled === true

  const background = createMemo(() => {
    if (disabled()) return undefined
    if (props.primary) return hover() ? palette().fg : palette().surface
    return hover() ? props.tokens.hover : undefined
  })

  const color = createMemo(() => {
    if (disabled()) return props.tokens.faint
    if (props.primary && hover()) return props.tokens.inverse
    return props.primary || hover() ? palette().on : props.tokens.muted
  })

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={1}
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={background()}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseDown={() => {
        if (!disabled()) props.onPress?.()
      }}
    >
      <Show when={props.glyph}>
        <text fg={color()} wrapMode="none" selectable={false}>
          {props.glyph}
        </text>
      </Show>
      <text fg={color()} wrapMode="none" selectable={false}>
        {props.children}
      </text>
      <Show when={props.shortcut && !disabled()}>
        <text fg={props.tokens.faint} wrapMode="none" selectable={false}>
          {props.shortcut}
        </text>
      </Show>
    </box>
  )
}

/**
 * Editor-style tab with an inline close affordance.
 *
 * The close target only appears on hover or when active, so the strip stays
 * calm while remaining directly clickable.
 */
export function Tab(props) {
  const [hover, setHover] = createSignal(false)
  const tokens = () => props.tokens
  const clock = useClock(() => props.running === true && tokens().motion !== false)

  const glyph = createMemo(() => {
    if (props.running) return spinnerFrame(clock(), undefined, 90, tokens().motion !== false)
    if (props.pinned) return GLYPH.ring
    return props.slot ? String(props.slot) : GLYPH.bullet
  })

  const background = createMemo(() => {
    if (props.active) return tokens().surface
    if (hover()) return tokens().hover
    return undefined
  })

  const showClose = createMemo(() => (hover() || props.active) && !props.pinned)

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={1}
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={background()}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseDown={() => props.onSelect?.()}
    >
      <text
        fg={props.running ? tokens().accent : props.active ? tokens().accent : tokens().faint}
        wrapMode="none"
        selectable={false}
      >
        {glyph()}
      </text>
      <text fg={props.active ? tokens().text : tokens().muted} wrapMode="none" selectable={false}>
        {props.active ? <b>{fit(props.title, props.width ?? 18)}</b> : fit(props.title, props.width ?? 18)}
      </text>
      <Show when={props.attention}>
        <text fg={tokens().warning} wrapMode="none" selectable={false}>
          {GLYPH.diamond}
        </text>
      </Show>
      <Show
        when={showClose()}
        fallback={
          <text fg={tokens().canvas} wrapMode="none" selectable={false}>
            {" "}
          </text>
        }
      >
        <box
          flexShrink={0}
          onMouseDown={(event) => {
            // Closing must not also activate the tab underneath.
            event?.stopPropagation?.()
            props.onClose?.()
          }}
        >
          <text fg={tokens().error} wrapMode="none" selectable={false}>
            {GLYPH.close}
          </text>
        </box>
      </Show>
    </box>
  )
}

/** Horizontal toolbar; children are usually `Button`s. */
export function Toolbar(props) {
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={1}
      gap={props.gap ?? 1}
      backgroundColor={props.background ?? props.tokens.panel}
      paddingLeft={props.inset === false ? 0 : 1}
      paddingRight={props.inset === false ? 0 : 1}
    >
      {props.children}
    </box>
  )
}

/**
 * Segmented control for switching between a small set of views.
 * Each segment is an independent click target.
 */
export function SegmentedControl(props) {
  const tokens = () => props.tokens
  const items = createMemo(() => Array.from(props.items ?? []))
  return (
    <box flexDirection="row" flexShrink={0} height={1} gap={0}>
      <For each={items()}>
        {(item) => {
          const [hover, setHover] = createSignal(false)
          const active = () => item.value === props.value
          return (
            <box
              flexDirection="row"
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={active() ? tokens().selectionStrong : hover() ? tokens().hover : undefined}
              onMouseOver={() => setHover(true)}
              onMouseOut={() => setHover(false)}
              onMouseDown={() => props.onChange?.(item.value)}
            >
              <text fg={active() ? tokens().text : tokens().faint} wrapMode="none" selectable={false}>
                {active() ? <b>{item.label}</b> : item.label}
              </text>
              <Show when={item.count !== undefined && item.count !== null}>
                <text fg={active() ? tokens().accent : tokens().faint} wrapMode="none" selectable={false}>
                  {" "}
                  {item.count}
                </text>
              </Show>
            </box>
          )
        }}
      </For>
    </box>
  )
}

/**
 * A clickable list row with hover feedback.
 *
 * Distinct from `ide-kit`'s `Row`: this one owns its own hover state so the
 * explorer does not need to track a hovered index for every entry.
 */
export function ClickRow(props) {
  const [hover, setHover] = createSignal(false)
  const tokens = () => props.tokens
  const background = createMemo(() => {
    if (props.selected) return tokens().selectionStrong
    if (hover()) return tokens().hover
    return undefined
  })
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={1}
      gap={1}
      paddingRight={1}
      backgroundColor={background()}
      onMouseOver={() => {
        setHover(true)
        props.onHover?.()
      }}
      onMouseOut={() => setHover(false)}
      onMouseDown={() => props.onSelect?.()}
    >
      <text fg={props.selected ? tokens().accent : tokens().borderFaint} wrapMode="none" selectable={false}>
        {props.selected ? GLYPH.blockHalf : " "}
      </text>
      {props.children}
    </box>
  )
}

/** Live activity line: spinner plus what the agent is doing right now. */
export function ActivityLine(props) {
  const tokens = () => props.tokens
  const clock = useClock(() => props.busy === true && tokens().motion !== false)
  return (
    <box flexDirection="row" flexShrink={0} gap={1} height={1}>
      <text fg={props.busy ? tokens().accent : tokens().faint} wrapMode="none" selectable={false}>
        {props.busy ? spinnerFrame(clock(), undefined, 90, tokens().motion !== false) : GLYPH.bullet}
      </text>
      <text fg={props.busy ? tokens().text : tokens().muted} wrapMode="none" selectable={false}>
        {fit(props.children ?? "", props.width ?? 48)}
      </text>
    </box>
  )
}
