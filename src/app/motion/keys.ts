// The Motion step's keys (src/app/steps/MotionPanel.svelte): editing the clip playing from the keyboard. Unlike the
// app's other shortcuts (src/ui/shortcuts.ts) they also work with the focus on a button (the toolbar's Move was just
// clicked, the hand is back on the stage); fields and lists keep their own keys. The transport's (Space, frames, keys)
// are the timeline's (src/app/motion/Timeline.svelte). The pose tools' own (Ctrl+Shift+C/V, Ctrl+Alt+C/V, Alt+O) are
// theirs: nothing here takes Shift or Alt with Ctrl but redo.

export type MotionAction =
  | 'undo' | 'redo' | 'delete' | 'deselect' | 'move' | 'rotate' | 'duplicate' | 'copy' | 'paste' | 'all'
  | 'key' | 'solve' | 'fit' | 'fitSelection' | 'regionStart' | 'regionEnd' | 'regionClear'

/** Whether Motion may take this key press (not one a field, a list or a slider needs). */
export function motionKeyAllowed (e: Pick<KeyboardEvent, 'defaultPrevented' | 'target'>): boolean {
  if (e.defaultPrevented) return false
  const t = e.target as { closest?: (selector: string) => unknown } | null
  return !(t !== null && typeof t.closest === 'function' &&
    t.closest('input, select, textarea, [role="slider"], [role="listbox"], [role="combobox"], [contenteditable]:not([contenteditable="false"])') !== null)
}

/** What a key press does in Motion, or null: not Motion's. */
export function motionAction (e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): MotionAction | null {
  const k = e.key.toLowerCase()
  if (e.ctrlKey || e.metaKey) {
    if (e.altKey) return null
    if (k === 'z') return e.shiftKey ? 'redo' : 'undo'
    if (e.shiftKey) return null
    if (k === 'y') return 'redo'
    if (k === 'd') return 'duplicate'
    if (k === 'c') return 'copy'
    if (k === 'v') return 'paste'
    if (k === 'a') return 'all'
    return null
  }
  if (e.altKey) return null
  if (e.key === 'Delete' || e.key === 'Backspace') return 'delete'
  if (e.key === 'Escape') return 'deselect'
  if (e.key === '[') return 'regionStart'
  if (e.key === ']') return 'regionEnd'
  if (e.key === '\\') return 'regionClear'
  if (k === 'f') return e.shiftKey ? 'fitSelection' : 'fit'
  if (e.shiftKey) return null
  if (k === 'g') return 'move'
  if (k === 'r') return 'rotate'
  if (k === 'k') return 'key'
  if (k === 'b') return 'solve'
  return null
}
