// The key registry (src/ui/shortcuts.ts): keys matched by what they type or, for punctuation, the key pressed (Shift+[
// is still [), modifiers exact, the newest registration first, `when` respected, nothing while typing in a field.
import { describe, expect, it } from 'vitest'
import { keyLabel, matches, register, runShortcut, shortcuts } from './shortcuts.ts'

type Press = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
const press = (key: string, o: Partial<Press> = {}): Press => ({ key, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o })
const event = (key: string, o: Partial<Press> & { target?: unknown, repeat?: boolean } = {}): KeyboardEvent => {
  let prevented = false
  return {
    ...press(key, o), repeat: o.repeat ?? false, target: o.target ?? null,
    get defaultPrevented () { return prevented },
    preventDefault () { prevented = true },
  } as unknown as KeyboardEvent
}

describe('shortcut keys', () => {
  it('match letters in any case, punctuation by its key, modifiers exactly', () => {
    expect(matches('r', press('R'))).toBe(true)
    expect(matches('r', press('r', { ctrlKey: true }))).toBe(false)
    expect(matches('[', press('[', { code: 'BracketLeft' }))).toBe(true)
    expect(matches('[', press('{', { code: 'BracketLeft', shiftKey: true }))).toBe(false)
    expect(matches('shift+[', press('{', { code: 'BracketLeft', shiftKey: true }))).toBe(true)
    expect(matches('ctrl+z', press('z', { metaKey: true }))).toBe(true)
    expect(matches('ctrl+shift+z', press('Z', { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(matches('ctrl+z', press('Z', { ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(matches('?', press('?', { shiftKey: true }))).toBe(true)
    expect(keyLabel('shift+[')).toEqual(['Shift', '['])
    expect(keyLabel('ctrl+shift+z')).toEqual(['Ctrl', 'Shift', 'Z'])
  })

  it('run the newest that applies, never while typing', () => {
    const ran: string[] = []
    const offA = register({ id: 'a', keys: 'r', label: 'A', group: 'G', run: () => ran.push('a') })
    const offB = register({ id: 'b', keys: 'r', label: 'B', group: 'G', when: () => ran.length < 1, run: () => ran.push('b') })
    expect(runShortcut(event('r'))).toBe(true)
    expect(runShortcut(event('r'))).toBe(true)
    expect(ran).toEqual(['b', 'a'])
    const field = { closest: (sel: string) => (sel.includes('input') ? {} : null) }
    expect(runShortcut(event('r', { target: field }))).toBe(false)
    expect(runShortcut(event('r', { repeat: true }))).toBe(false)
    expect(shortcuts().map(s => s.id)).toEqual(['b', 'a'])
    offB(); offA()
    expect(shortcuts()).toEqual([])
    expect(runShortcut(event('r'))).toBe(false)
  })
})
