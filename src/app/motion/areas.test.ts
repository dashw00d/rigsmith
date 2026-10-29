// The areas' items in the timeline's cross-track selection (lanes.ts AreaItems): the selected events moved, copied,
// pasted (in this clip or another) and deleted in played time and stored in source time, the gear strips' switches and
// hidden spans deleted, each edit a list of commands the reducer takes.
import { describe, expect, it } from 'vitest'
import { applyCommands } from '../../model/commands.ts'
import { makeCharacter, makeGear, makeSlot } from '../../model/fixtures.ts'
import type { Character, Slot } from '../../model/types.ts'
import { eventItems } from './events/items.ts'
import { MEASURED_HIT } from './events/edit.ts'
import { gearItems } from './gear/items.ts'
import type { AreaView, SelectedItem } from './lanes.ts'

const FRAMES = 30
// (a time map that isn't the identity: the clip's start played slower than its end)
const toPlayed = (u: number): number => u ** 0.8
const toSource = (v: number): number => v ** 1.25

function viewOf (c: Character, slot: Slot, cut?: { start: number, end: number, blow: number }): AreaView {
  return {
    character: c, slot, frames: FRAMES, toPlayed, toSource,
    snap: (v, free) => (free === true ? v : Math.round(v * FRAMES) / FRAMES),
    baked: (cut === undefined ? null : { cut }) as AreaView['baked'],
  }
}

const at = (frame: number): number => toSource(frame / FRAMES)
const frameOf = (u: number): number => Math.round(toPlayed(u) * FRAMES * 1e6) / 1e6
const sel = (id: string, u = 0): SelectedItem => ({ track: 'events', id, u })

function setup (): { c: Character, slot: Slot } {
  const slot = makeSlot({
    id: 'a', name: 'Attack', loop: false,
    events: [
      { id: 'e1', name: 'release', u: at(6), sound: 'mix:bowshot', bone: 'LeftHand', volume: 0.5 },
      { id: 'e2', name: 'draw', u: at(2), to: at(5) },
      { id: 'e3', name: 'hit', u: at(12) },
    ],
  })
  return { c: makeCharacter({ clips: [slot, makeSlot({ id: 'b', name: 'Run' })] }), slot }
}

describe('events in the selection', () => {
  it('own the events track only', () => {
    expect(eventItems.owns('events')).toBe(true)
    expect(eventItems.owns('body:Hips')).toBe(false)
    expect(gearItems.owns('held:g1')).toBe(true)
    expect(gearItems.owns('shown:g1')).toBe(true)
    expect(gearItems.owns('gear:g1')).toBe(false)
  })

  it('span from the earliest to the latest end, as they play', () => {
    const { c, slot } = setup()
    const span = eventItems.span!(viewOf(c, slot), [sel('e1'), sel('e2')])!
    expect(span[0] * FRAMES).toBeCloseTo(2, 6)
    expect(span[1] * FRAMES).toBeCloseTo(6, 6)
  })

  it('move by the played distance the timeline gives, a span keeping its frames', () => {
    const { c, slot } = setup()
    const edit = eventItems.move!(viewOf(c, slot), [sel('e1'), sel('e2')], 3 / FRAMES)!
    const next = applyCommands(c, edit.commands).character.clips[0]
    const byId = Object.fromEntries((next.events ?? []).map(e => [e.id, e]))
    expect(frameOf(byId.e1.u)).toBeCloseTo(9, 4)
    expect(frameOf(byId.e2.u)).toBeCloseTo(5, 4)
    expect(frameOf(byId.e2.to!)).toBeCloseTo(8, 4)
    expect(byId.e3.u).toBe(slot.events![2].u)
    expect(edit.selection.map(s => s.id).sort()).toEqual(['e1', 'e2'])
    expect(edit.selection.find(s => s.id === 'e1')!.u).toBe(byId.e1.u)
  })

  it('pick the measured blow by hand when it moves with the selection', () => {
    const slot = makeSlot({ id: 'a', name: 'Attack', events: [] })
    const c = makeCharacter({ clips: [slot] })
    const edit = eventItems.move!(viewOf(c, slot, { start: 0, end: 1, blow: 0.4 }), [sel(MEASURED_HIT)], 2 / FRAMES)!
    const next = applyCommands(c, edit.commands).character.clips[0]
    expect(next.events).toHaveLength(1)
    expect(next.events![0].name).toBe('hit')
    expect(toPlayed(next.events![0].u)).toBeCloseTo(0.4 + 2 / FRAMES, 6)
    expect(edit.selection).toEqual([{ track: 'events', id: next.events![0].id, u: next.events![0].u }])
  })

  it('copy and paste at another frame with what each had, new ids, and no second hit', () => {
    const { c, slot } = setup()
    const view = viewOf(c, slot)
    const clip = eventItems.copy!(view, [sel('e1'), sel('e2'), sel('e3')])!
    expect(clip.first * FRAMES).toBeCloseTo(2, 6)
    const edit = eventItems.paste!(view, clip, 15 / FRAMES)!
    const next = applyCommands(c, edit.commands).character.clips[0]
    const added = (next.events ?? []).filter(e => !['e1', 'e2', 'e3'].includes(e.id))
    expect(added.map(e => e.name).sort()).toEqual(['draw', 'release'])
    const release = added.find(e => e.name === 'release')!
    expect(frameOf(release.u)).toBeCloseTo(19, 4)
    expect(release).toMatchObject({ sound: 'mix:bowshot', bone: 'LeftHand', volume: 0.5 })
    const draw = added.find(e => e.name === 'draw')!
    expect([frameOf(draw.u), frameOf(draw.to!)].map(Math.round)).toEqual([15, 18])
    expect(edit.selection.map(s => s.id).sort()).toEqual(added.map(e => e.id).sort())
  })

  it('paste into another clip, the hit too where it has none, leaving out what falls past the end', () => {
    const { c, slot } = setup()
    const clip = eventItems.copy!(viewOf(c, slot), [sel('e1'), sel('e3')])!
    const run = c.clips[1]
    const edit = eventItems.paste!(viewOf(c, run), clip, 20 / FRAMES)!
    const next = applyCommands(c, edit.commands).character.clips[1]
    // (release at 20, the hit 6 frames on at 26; from frame 26 the hit would be past the end)
    expect((next.events ?? []).map(e => [e.name, Math.round(frameOf(e.u))])).toEqual([['release', 20], ['hit', 26]])
    expect(eventItems.paste!(viewOf(c, run), clip, 26 / FRAMES)!.commands).toHaveLength(1)
  })

  it('are deleted, the measured blow staying measured', () => {
    const { c, slot } = setup()
    const commands = eventItems.remove!(viewOf(c, slot), [sel('e1'), sel(MEASURED_HIT), { track: 'body:Hips', id: '0', u: 0 }])
    expect(applyCommands(c, commands).character.clips[0].events!.map(e => e.id)).toEqual(['e2', 'e3'])
  })
})

describe('gear strips in the selection', () => {
  it('delete the switches and the hidden spans selected, one update a piece', () => {
    const g = makeGear({ id: 'g1', attach: { kind: 'bone', bone: 'RightHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } })
    const slot = makeSlot({
      id: 'a', name: 'Attack',
      gear: { g1: { keys: [], heldBy: [{ u: 0.3, bone: 'LeftHand' }, { u: 0.6, bone: 'RightHand' }], shown: [{ u: 0.1, shown: false }, { u: 0.2, shown: true }, { u: 0.8, shown: false }] } },
    })
    const c = makeCharacter({ gear: [g], clips: [slot] })
    const commands = gearItems.remove!(viewOf(c, slot), [{ track: 'held:g1', id: '0', u: 0.3 }, { track: 'held:g1', id: '-1', u: 0 }, { track: 'shown:g1', id: '1', u: 0.8 }])
    expect(commands).toHaveLength(1)
    const track = applyCommands(c, commands).character.clips[0].gear!.g1
    expect(track.heldBy).toEqual([{ u: 0.6, bone: 'RightHand' }])
    expect(track.shown).toEqual([{ u: 0.1, shown: false }, { u: 0.2, shown: true }])
  })
})
