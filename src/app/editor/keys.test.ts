// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { editorAction, editorKeyAllowed } from './keys.ts'

const key = (key: string, o: { ctrl?: boolean, meta?: boolean, shift?: boolean } = {}) => ({ key, ctrlKey: o.ctrl ?? false, metaKey: o.meta ?? false, shiftKey: o.shift ?? false })
const target = (matches: boolean) => ({ closest: () => (matches ? {} : null) })

describe('the clip editor\'s keys', () => {
  it('undoes and redoes with Ctrl (or Cmd) Z, Shift for redo, and Ctrl Y', () => {
    expect(editorAction(key('z', { ctrl: true }))).toBe('undo')
    expect(editorAction(key('Z', { ctrl: true, shift: true }))).toBe('redo')
    expect(editorAction(key('z', { meta: true }))).toBe('undo')
    expect(editorAction(key('y', { ctrl: true }))).toBe('redo')
  })

  it('leaves other Ctrl keys alone, and maps the plain ones', () => {
    expect(editorAction(key('s', { ctrl: true }))).toBeNull()
    expect(editorAction(key('g', { ctrl: true }))).toBeNull()
    expect(editorAction(key('Delete'))).toBe('delete')
    expect(editorAction(key('Backspace'))).toBe('delete')
    expect(editorAction(key('Escape'))).toBe('deselect')
    expect(editorAction(key('G'))).toBe('move')
    expect(editorAction(key('r'))).toBe('rotate')
    expect(editorAction(key('x'))).toBeNull()
  })

  it('works with the focus on a button but not in a field', () => {
    expect(editorKeyAllowed({ defaultPrevented: false, altKey: false, target: target(false) as unknown as EventTarget })).toBe(true)
    expect(editorKeyAllowed({ defaultPrevented: false, altKey: false, target: target(true) as unknown as EventTarget })).toBe(false)
    expect(editorKeyAllowed({ defaultPrevented: false, altKey: false, target: null })).toBe(true)
    expect(editorKeyAllowed({ defaultPrevented: true, altKey: false, target: null })).toBe(false)
    expect(editorKeyAllowed({ defaultPrevented: false, altKey: true, target: null })).toBe(false)
  })
})
