/** Window shortcuts must leave focused controls and native editing keys alone. */
export function allowsShortcut (event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false
  return !(event.target instanceof Element && event.target.closest('input, select, textarea, button, a, summary, [role="button"], [role="slider"], [contenteditable]:not([contenteditable="false"])'))
}
