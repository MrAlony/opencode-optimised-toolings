/** @jsxImportSource @opentui/solid */
// Stable mouse-and-keyboard controls for the Alonix IDE.
//
// Pointer movement must never mount/unmount children or change a control's
// width. OpenTUI dispatches enter/leave events across nested renderables, so
// hover-driven structure causes visible flicker. These controls keep geometry
// fixed and express state through persistent fills, selection, and focusable
// native inputs.

import { createMemo, For, onMount, Show } from "solid-js"
import { buttonSurface, GLYPH } from "../lib/design.js"
import { fit } from "../lib/layout.js"
import { spinnerFrame } from "../lib/motion.js"
import { useClock } from "./runtime.jsx"

function activationKey(event) {
  const name = String(event?.name ?? "").toLowerCase()
  return name === "return" || name === "enter" || name === "space"
}

/** Always-visible action with fixed geometry and pointer + keyboard activation. */
export function Button(props) {
  const tokens = () => props.tokens
  const disabled = () => props.disabled === true
  const size = () => props.size ?? "md"
  const variant = () => props.variant ?? (props.primary ? "primary" : "secondary")
  const surface = createMemo(() =>
    buttonSurface(tokens(), {
      variant: variant(),
      tone: props.tone,
      disabled: disabled(),
    }),
  )

  const press = (event) => {
    event?.stopPropagation?.()
    if (!disabled()) props.onPress?.(event)
  }

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      height={size() === "lg" ? 3 : 1}
      minWidth={props.minWidth}
      width={props.width}
      paddingLeft={size() === "sm" ? 1 : 2}
      paddingRight={size() === "sm" ? 1 : 2}
      justifyContent="center"
      backgroundColor={surface().background}
      focusable={!disabled()}
      onKeyDown={(event) => {
        if (!activationKey(event)) return
        event?.preventDefault?.()
        press(event)
      }}
      onMouseUp={press}
    >
      <box flexDirection="row" flexShrink={0} height={1} gap={1} alignItems="center">
        <Show when={props.glyph}>
          <text fg={surface().foreground} wrapMode="none" selectable={false}>
            {props.glyph}
          </text>
        </Show>
        <text fg={surface().foreground} wrapMode="none" selectable={false}>
          {variant() === "primary" || variant() === "danger" ? <b>{props.children}</b> : props.children}
        </text>
        <Show when={props.shortcut && !disabled()}>
          <box flexGrow={1} />
          <text fg={surface().hint} wrapMode="none" selectable={false}>
            {props.shortcut}
          </text>
        </Show>
      </box>

    </box>
  )
}

/**
 * Native OpenTUI input with explicit focus and consistent IDE styling.
 * `onInput` receives the current string; Enter delegates to `onSubmit`.
 *
 * Large buttons intentionally remain single-line. OpenTUI can paint sibling
 * text renderables into the same terminal row inside a fixed-height button,
 * which previously overprinted labels and descriptions into unreadable text.
 */
export function TextInput(props) {
  let input
  const tokens = () => props.tokens

  onMount(() => {
    if (!props.autoFocus) return
    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.focus()
    }, 1)
  })

  return (
    <box flexDirection="column" flexShrink={0} gap={props.label ? 1 : 0}>
      <Show when={props.label}>
        <text fg={tokens().muted} wrapMode="none" selectable={false}>
          {props.label}
        </text>
      </Show>
      <box
        flexDirection="row"
        flexShrink={0}
        height={1}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={tokens().raised}
      >
        <Show when={props.glyph}>
          <text fg={tokens().accent} wrapMode="none" selectable={false}>
            {props.glyph}{" "}
          </text>
        </Show>
        <input
          ref={(value) => {
            input = value
            props.ref?.(value)
          }}
          width="100%"
          value={props.value ?? ""}
          placeholder={props.placeholder ?? ""}
          placeholderColor={tokens().faint}
          backgroundColor={tokens().raised}
          focusedBackgroundColor={tokens().selection}
          textColor={tokens().text}
          focusedTextColor={tokens().text}
          cursorColor={tokens().accent}
          onInput={(value) => props.onInput?.(String(value ?? ""))}
          onKeyDown={(event) => {
            const name = String(event?.name ?? "").toLowerCase()
            if ((name === "return" || name === "enter") && props.onSubmit) {
              event?.preventDefault?.()
              props.onSubmit(String(input?.value ?? props.value ?? ""))
              return
            }
            props.onKeyDown?.(event)
          }}
          onMouseDown={(event) => event?.target?.focus?.()}
        />
      </box>
      <Show when={props.hint}>
        <text fg={tokens().faint} wrapMode="wrap" selectable={false}>
          {props.hint}
        </text>
      </Show>
    </box>
  )
}

/** Fixed-width editor tab; close space never appears or disappears on hover. */
export function Tab(props) {
  const tokens = () => props.tokens
  const clock = useClock(() => props.running === true && tokens().motion !== false)
  const glyph = createMemo(() => {
    if (props.running) return spinnerFrame(clock(), undefined, 90, tokens().motion !== false)
    if (props.pinned) return GLYPH.ring
    return props.slot ? String(props.slot) : GLYPH.bullet
  })

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={1}
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.active ? tokens().selectionStrong : tokens().panel}
      focusable
      onKeyDown={(event) => {
        if (!activationKey(event)) return
        event?.preventDefault?.()
        props.onSelect?.()
      }}
      onMouseUp={() => props.onSelect?.()}
    >
      <text fg={props.running || props.active ? tokens().accent : tokens().faint} wrapMode="none" selectable={false}>
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
        when={!props.pinned}
        fallback={
          <text fg={tokens().panel} wrapMode="none" selectable={false}>
            {" "}
          </text>
        }
      >
        <box
          flexShrink={0}
          onMouseUp={(event) => {
            event?.stopPropagation?.()
            props.onClose?.()
          }}
        >
          <text fg={props.active ? tokens().error : tokens().faint} wrapMode="none" selectable={false}>
            {GLYPH.close}
          </text>
        </box>
      </Show>
    </box>
  )
}

export function Toolbar(props) {
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={props.height ?? 1}
      alignItems="center"
      gap={props.gap ?? 1}
      backgroundColor={props.background ?? props.tokens.panel}
      paddingLeft={props.inset === false ? 0 : 1}
      paddingRight={props.inset === false ? 0 : 1}
    >
      {props.children}
    </box>
  )
}

/** Fixed segmented control; selection changes only on click or keyboard use. */
export function SegmentedControl(props) {
  const tokens = () => props.tokens
  const items = createMemo(() => Array.from(props.items ?? []))
  return (
    <box flexDirection="row" flexShrink={0} height={1} gap={1}>
      <For each={items()}>
        {(item) => {
          const active = () => item.value === props.value
          return (
            <box
              flexDirection="row"
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={active() ? tokens().selectionStrong : tokens().surface}
              focusable
              onKeyDown={(event) => {
                if (!activationKey(event)) return
                event?.preventDefault?.()
                props.onChange?.(item.value)
              }}
              onMouseUp={() => props.onChange?.(item.value)}
            >
              <text fg={active() ? tokens().text : tokens().muted} wrapMode="none" selectable={false}>
                {active() ? <b>{item.label}</b> : item.label}
              </text>
              <Show when={item.count !== undefined && item.count !== null}>
                <text fg={active() ? tokens().accent : tokens().faint} wrapMode="none" selectable={false}>
                  {" "}{item.count}
                </text>
              </Show>
            </box>
          )
        }}
      </For>
    </box>
  )
}

/** Stable list row. Pointer motion updates selection without local hover state. */
export function ClickRow(props) {
  const tokens = () => props.tokens
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      minHeight={props.height ?? 1}
      gap={1}
      paddingRight={1}
      backgroundColor={props.selected ? tokens().selectionStrong : props.background ?? tokens().panel}
      focusable={props.focusable !== false}
      onMouseMove={() => props.onHover?.()}
      onMouseDown={() => props.onHover?.()}
      onMouseUp={() => props.onSelect?.()}
      onKeyDown={(event) => {
        if (!activationKey(event)) return
        event?.preventDefault?.()
        props.onSelect?.()
      }}
    >
      <text fg={props.selected ? tokens().accent : tokens().borderFaint} wrapMode="none" selectable={false}>
        {props.selected ? GLYPH.pointer : " "}
      </text>
      {props.children}
    </box>
  )
}

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
