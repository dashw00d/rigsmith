// The clip editor's keys (src/app/editor/EditPanel.svelte). Unlike the app's other shortcuts (src/ui/shortcuts.ts) they
// also work with the focus on a button: the toolbar's Move or Rotate was just clicked, the user's hand is back on the
// stage. Fields and lists keep their own keys.

export type EditorAction = 'undo' | 'redo' | 'delete' | 'deselect' | 'move' | 'rotate'

/** Whether the editor may take this key press (not one a field, a list or a slider needs). */
export function editorKeyAllowed (e: Pick<KeyboardEvent, 'defaultPrevented' | 'altKey' | 'target'>): boolean {
  if (e.defaultPrevented || e.altKey) return false
  const t = e.target as { closest?: (selector: string) => unknown } | null
  return !(t !== null && typeof t.closest === 'function' &&
    t.closest('input, select, textarea, [role="slider"], [role="listbox"], [role="combobox"], [contenteditable]:not([contenteditable="false"])') !== null)
}

/** What a key press does in the editor: Ctrl+Z undo, Ctrl+Shift+Z (or Ctrl+Y) redo, Delete or Backspace the keys at the
 * frame, Escape deselect, G move, R rotate. Null: not the editor's. */
export function editorAction (e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): EditorAction | null {
  const k = e.key.toLowerCase()
  if (e.ctrlKey || e.metaKey) {
    if (k === 'z') return e.shiftKey ? 'redo' : 'undo'
    if (k === 'y') return 'redo'
    return null
  }
  if (e.key === 'Delete' || e.key === 'Backspace') return 'delete'
  if (e.key === 'Escape') return 'deselect'
  if (k === 'g') return 'move'
  if (k === 'r') return 'rotate'
  return null
}
