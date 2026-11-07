// The app's keys. `allowsShortcut` is the old rule for a window key (no focused control, no modifier). The registry
// is for keys anyone can see in the keys sheet (`?`): each says its key, what it does, and when it applies; App runs
// `runShortcut` from one window listener. A key never fires while typing in a field (a button or a swatch keeps the
// keys: the hand is back on the keyboard after a click), nor when a control before it took the key.

/** Window shortcuts must leave focused controls and native editing keys alone. */
export function allowsShortcut (event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false
  return !(event.target instanceof Element && event.target.closest('input, select, textarea, button, a, summary, [role="button"], [role="slider"], [contenteditable]:not([contenteditable="false"])'))
}

/** Whether the key press is typing into something (a field, a list, a slider): no shortcut takes it. */
export function typing (target: EventTarget | null): boolean {
  const t = target as { closest?: (selector: string) => unknown } | null
  return t !== null && typeof t.closest === 'function' &&
    t.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), select, textarea, [role="slider"], [role="listbox"], [role="combobox"], [contenteditable]:not([contenteditable="false"])') !== null
}

export interface Shortcut {
  id: string
  /** As written in the sheet and matched: 'r', '[', 'shift+[', 'ctrl+z', 'ctrl+shift+z', '?', ',' (letters any case). */
  keys: string
  label: string
  /** The sheet's heading it is listed under. */
  group: string
  /** Whether it applies now (unset: always). */
  when?: () => boolean
  run: (e: KeyboardEvent) => void
}

// (the physical key of the punctuation, so Shift+[ is still [ on any layout that types { there)
const CODES: Record<string, string> = { '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', '`': 'Backquote', '-': 'Minus', '=': 'Equal' }

interface Spec { key: string, ctrl: boolean, shift: boolean | null, alt: boolean }

export function parseKeys (keys: string): Spec {
  const parts = keys.toLowerCase().split('+')
  // ('shift++' / a lone '+')
  const key = keys.endsWith('+') && keys.length > 1 ? '+' : parts.at(-1) ?? ''
  const mods = new Set(parts.slice(0, -1))
  // ('?' is Shift+/ already: Shift is whatever types it)
  return { key, ctrl: mods.has('ctrl') || mods.has('mod'), shift: mods.has('shift') ? true : key === '?' ? null : false, alt: mods.has('alt') }
}

/** Whether a key press is the shortcut's keys. */
export function matches (keys: string, e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  const s = parseKeys(keys)
  if (s.ctrl !== (e.ctrlKey || e.metaKey) || s.alt !== e.altKey) return false
  if (s.shift !== null && s.shift !== e.shiftKey) return false
  const code = CODES[s.key]
  if (code !== undefined && e.code === code) return true
  return e.key.toLowerCase() === s.key
}

const registry: Shortcut[] = []
const listeners = new Set<() => void>()

/** Add shortcuts; the function returned takes them away. A later one with the same keys is tried first. */
export function register (...list: Shortcut[]): () => void {
  registry.unshift(...list)
  for (const l of listeners) l()
  return () => {
    for (const s of list) { const i = registry.indexOf(s); if (i >= 0) registry.splice(i, 1) }
    for (const l of listeners) l()
  }
}

/** Every shortcut registered (the sheet). */
export function shortcuts (): readonly Shortcut[] {
  return registry
}

/** Hear when the list changes (the sheet while open). */
export function onShortcuts (fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Run the first shortcut the key press is and that applies now: true when one ran (the key is taken). */
export function runShortcut (e: KeyboardEvent): boolean {
  if (e.defaultPrevented || (e.repeat && !/^[[\],.]$/.test(e.key)) || typing(e.target)) return false
  for (const s of registry) {
    if (!matches(s.keys, e)) continue
    if (s.when !== undefined && !s.when()) continue
    e.preventDefault()
    s.run(e)
    return true
  }
  return false
}

/** The keys as the sheet writes them: 'shift+[' -> 'Shift [', 'ctrl+z' -> 'Ctrl Z'. */
export function keyLabel (keys: string): string[] {
  const s = parseKeys(keys)
  return [...(s.ctrl ? ['Ctrl'] : []), ...(s.alt ? ['Alt'] : []), ...(s.shift === true ? ['Shift'] : []), s.key.length === 1 ? s.key.toUpperCase() : s.key]
}
