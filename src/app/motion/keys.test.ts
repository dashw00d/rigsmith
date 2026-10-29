// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { motionAction, motionKeyAllowed } from './keys.ts'

const key = (key: string, o: { ctrl?: boolean, meta?: boolean, shift?: boolean, alt?: boolean } = {}) => ({ key, ctrlKey: o.ctrl ?? false, metaKey: o.meta ?? false, shiftKey: o.shift ?? false, altKey: o.alt ?? false })
const target = (matches: boolean) => ({ closest: () => (matches ? {} : null) })

describe('Motion\'s keys', () => {
  it('undoes and redoes with Ctrl (or Cmd) Z, Shift for redo, and Ctrl Y', () => {
    expect(motionAction(key('z', { ctrl: true }))).toBe('undo')
    expect(motionAction(key('Z', { ctrl: true, shift: true }))).toBe('redo')
    expect(motionAction(key('z', { meta: true }))).toBe('undo')
    expect(motionAction(key('y', { ctrl: true }))).toBe('redo')
  })

  it('edits keys with Ctrl D, C, V, A and leaves the pose tools theirs', () => {
    expect(motionAction(key('d', { ctrl: true }))).toBe('duplicate')
    expect(motionAction(key('c', { ctrl: true }))).toBe('copy')
    expect(motionAction(key('v', { ctrl: true }))).toBe('paste')
    expect(motionAction(key('a', { ctrl: true }))).toBe('all')
    expect(motionAction(key('C', { ctrl: true, shift: true }))).toBeNull()
    expect(motionAction(key('v', { ctrl: true, alt: true }))).toBeNull()
    expect(motionAction(key('o', { alt: true }))).toBeNull()
  })

  it('maps the plain ones', () => {
    expect(motionAction(key('Delete'))).toBe('delete')
    expect(motionAction(key('Backspace'))).toBe('delete')
    expect(motionAction(key('Escape'))).toBe('deselect')
    expect(motionAction(key('G'))).toBe('move')
    expect(motionAction(key('r'))).toBe('rotate')
    expect(motionAction(key('k'))).toBe('key')
    expect(motionAction(key('f'))).toBe('fit')
    expect(motionAction(key('F', { shift: true }))).toBe('fitSelection')
    expect(motionAction(key('['))).toBe('regionStart')
    expect(motionAction(key('x'))).toBeNull()
  })

  it('works with the focus on a button but not in a field', () => {
    expect(motionKeyAllowed({ defaultPrevented: false, target: target(false) as unknown as EventTarget })).toBe(true)
    expect(motionKeyAllowed({ defaultPrevented: false, target: target(true) as unknown as EventTarget })).toBe(false)
    expect(motionKeyAllowed({ defaultPrevented: true, target: null })).toBe(false)
  })
})
