// The activity drawer's words and the delete check (src/app/activity.ts).
import { describe, expect, it } from 'vitest'
import { makeCharacter, makeGear, makeSlot } from '../model/fixtures.ts'
import { ago, clock, entityLabel, refusal, refusalText, reversal, who } from './activity.ts'

describe('how long ago', () => {
  it('reads short', () => {
    const now = 1_000_000_000
    expect(ago(now - 1000, now)).toBe('just now')
    expect(ago(now - 12_000, now)).toBe('12s ago')
    expect(ago(now - 3 * 60_000 - 5000, now)).toBe('3m ago')
    expect(ago(now - 2 * 3_600_000, now)).toBe('2h ago')
    expect(ago(now - 4 * 86_400_000, now)).toBe('4d ago')
    // (a clock a little ahead of this one)
    expect(ago(now + 3000, now)).toBe('just now')
  })

  it('gives the day only when it is not today', () => {
    const now = new Date(2026, 9, 28, 15, 0)
    expect(clock(new Date(2026, 9, 28, 9, 5).toISOString(), now)).not.toMatch(/Oct/)
    expect(clock(new Date(2026, 9, 3, 9, 5).toISOString(), now)).toMatch(/3/)
    expect(clock('not a time', now)).toBe('')
  })
})

describe('journal entries', () => {
  it('calls the app "you" and a tool by its name', () => {
    expect(who('app')).toBe('you')
    expect(who('agent')).toBe('agent')
  })

  it('offers undo on an undoable entry, redo on an undo, nothing once taken back or when it cannot be', () => {
    const undo = { entities: [] }
    expect(reversal({ undo })).toBe('undo')
    expect(reversal({ undo, undoes: 4 })).toBe('redo')
    expect(reversal({ undo, undoneBy: 9 })).toBeNull()
    expect(reversal({})).toBeNull()
  })

  it('names what an undo would have overwritten', () => {
    const c = makeCharacter({ gear: [makeGear({ id: 'g1', name: 'GearAxe' })], clips: [makeSlot({ id: 's1', name: 'Walk' })] })
    expect(entityLabel(c, 'gear:g1')).toBe('gear GearAxe')
    expect(entityLabel(c, 'gear:gone')).toBe('gear gone')
    expect(entityLabel(c, 'slot:s1')).toBe('clip Walk')
    expect(entityLabel(c, 'skeleton')).toBe('the skeleton')
    expect(entityLabel(null, 'layer:l9')).toBe('texture layer l9')
    expect(entityLabel(c, 'something')).toBe('something')
  })
})

describe('a delete the server refused', () => {
  it('reads riders, units and the busy job from the 409 body', () => {
    expect(refusal({ riders: ['knight-1'], units: [], busy: null })).toEqual({ riders: ['knight-1'], units: [], busy: null })
    expect(refusal({ riders: [], units: ['cavalry'], busy: { label: 'Rig Horse' } })).toEqual({ riders: [], units: ['cavalry'], busy: 'Rig Horse' })
    expect(refusal({ riders: [], units: [], busy: null })).toBeNull()
    expect(refusal('nope')).toBeNull()
  })

  it('says what deleting anyway leaves behind', () => {
    const text = refusalText({ riders: ['k1', 'k2'], units: ['cavalry'], busy: 'Rig Horse' }, id => ({ k1: 'Knight', k2: 'Squire' })[id] ?? id)
    expect(text).toContain('Knight, Squire ride it')
    expect(text).toContain('Game unit cavalry names it')
    expect(text).toContain('Rig Horse is working on it')
  })
})
