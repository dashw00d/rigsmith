// The Events track's pure parts: the vocabulary (built-ins, the character's own names, a typed name spelled as the
// character spells it, what a new event starts with), the edits as commands (worked out in played time through the
// slot's time map, stored in source time; the measured blow picked by hand when moved), the playhead's crossings, and
// footsteps found on the feet (a pure footfall reader and the sampling on a posed rig).
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { applyCommands } from '../../../model/commands.ts'
import { makeCharacter, makeGear, makeSlot } from '../../../model/fixtures.ts'
import { resolveTime } from '../../../model/timemap.ts'
import type { Character, ClipEvent, Slot } from '../../../model/types.ts'
import { addEvent, crossed, MEASURED_HIT, measuredHit, moveEdge, moveEvents, playedEvents, removeEvents, toggleSpan, type TimeView } from './edit.ts'
import { footfalls, footsteps, newSteps } from './footsteps.ts'
import { canonical, defaultsFor, nameProblem, newEventId, releaseBone, rowsOf, vocabulary } from './vocabulary.ts'

const FRAMES = 30
const plain: TimeView = { toPlayed: u => u, toSource: v => v, snap: (v, free) => (free === true ? v : Math.round(v * FRAMES) / FRAMES) }

function withSlots (...clips: Slot[]): Character {
  return makeCharacter({ clips })
}

describe('the vocabulary', () => {
  const c = withSlots(
    makeSlot({ id: 'a', name: 'Attack', events: [{ id: 'e1', name: 'whoosh', u: 0.2, sound: 'mix:sword_blow', volume: 0.5 }, { id: 'e2', name: 'whoosh', u: 0.6 }] }),
    makeSlot({ id: 'w', name: 'Walk', events: [{ id: 'e3', name: 'step.L', u: 0.1, sound: 'file:sounds/step.wav' }, { id: 'e4', name: 'grunt', u: 0.5 }] }),
  )

  it('lists every built-in in the game\'s order, then the character\'s own names, the most used first', () => {
    const v = vocabulary(c)
    expect(v.map(w => w.name)).toEqual(['hit', 'release', 'swing', 'step.L', 'step.R', 'draw', 'whoosh', 'grunt'])
    expect(v.find(w => w.name === 'whoosh')).toEqual({ name: 'whoosh', builtIn: false, uses: 2 })
    expect(v.find(w => w.name === 'step.L')?.uses).toBe(1)
  })

  it('spells a typed name as the character does, and refuses what is no name', () => {
    expect(canonical(c, ' Step.l ')).toBe('step.L')
    expect(canonical(c, 'WHOOSH')).toBe('whoosh')
    expect(canonical(c, 'Battle_cry')).toBe('Battle_cry')
    expect(canonical(c, '1st')).toBeNull()
    expect(canonical(c, '')).toBeNull()
    expect(nameProblem('a b')).toMatch(/Letters/)
    expect(nameProblem('x'.repeat(33))).toMatch(/32/)
    expect(nameProblem('ok.name-1')).toBeNull()
  })

  it('starts a new event of a used name as the last one with a sound or bone, else as its built-in', () => {
    expect(defaultsFor(c, { id: 'w', time: undefined }, 'whoosh')).toEqual({ sound: 'mix:sword_blow', volume: 0.5 })
    expect(defaultsFor(c, { id: 'a', time: undefined }, 'step.L')).toEqual({ sound: 'file:sounds/step.wav' })
    expect(defaultsFor(c, { id: 'a', time: undefined }, 'step.R')).toEqual({ bone: 'RightFoot' })
    expect(defaultsFor(c, { id: 'a', time: undefined }, 'grunt')).toEqual({})
    expect(defaultsFor(c, { id: 'a', time: { fit: { enabled: true, at: 0.45, hand: 'LeftHand' } } }, 'release')).toEqual({ bone: 'LeftHand' })
  })

  it('releases from the bow hand: the bone a piece with a pull rides', () => {
    const bow = makeGear({ id: 'bow', name: 'Bow', attach: { kind: 'bone', bone: 'LeftHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }, handles: [{ id: 'h', name: 'String', kind: 'pull', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, pull: { bone: 'RightHand' } }] as never })
    expect(releaseBone(makeCharacter({ gear: [bow] }), {})).toBe('LeftHand')
    expect(releaseBone(makeCharacter(), {})).toBe('RightHand')
  })

  it('makes a row per name, built-ins first, and the hit while the fit measures one', () => {
    expect(rowsOf([{ name: 'grunt' }, { name: 'step.R' }, { name: 'hit' }, { name: 'step.R' }, { name: 'aah' }], false)).toEqual(['hit', 'step.R', 'aah', 'grunt'])
    expect(rowsOf([], true)).toEqual(['hit'])
    expect(rowsOf([], false)).toEqual([])
  })

  it('makes ids the slot has not got', () => {
    let n = 0
    const seq = [0.1, 0.1, 0.2]
    const id = newEventId({ events: [{ id: Math.floor(0.1 * 0xffffffff).toString(16).padStart(8, '0'), name: 'hit', u: 0 }] }, () => seq[n++])
    expect(id).toBe(Math.floor(0.2 * 0xffffffff).toString(16).padStart(8, '0'))
  })
})

describe('edits as commands', () => {
  const slot = makeSlot({ id: 'atk', name: 'Attack', loop: false, events: [
    { id: 'h', name: 'hit', u: 0.5 },
    { id: 'd', name: 'draw', u: 0.1, to: 0.3 },
    { id: 's', name: 'swing', u: 0.4, sound: 'mix:sword_blow' },
  ] })
  const c = withSlots(slot)
  const run = (cmds: ReturnType<typeof moveEvents>): Slot => applyCommands(c, cmds).character.clips[0]

  it('adds an event on a frame, in source time, a span inside the clip', () => {
    const cmd = addEvent(slot, 'release', 0.512, plain, { id: 'r', defaults: { bone: 'LeftHand' } })
    expect(cmd).toEqual({ type: 'slot.event.add', slot: 'atk', event: { id: 'r', name: 'release', u: 15 / 30, bone: 'LeftHand' } })
    const span = addEvent(slot, 'draw', 0.9, plain, { id: 'x', span: 0.2 })
    expect(span.type === 'slot.event.add' && span.event.to).toBe(1)
    expect(addEvent(slot, 'swing', 0.512, plain, { id: 'f', free: true }).type === 'slot.event.add' && (addEvent(slot, 'swing', 0.512, plain, { id: 'f', free: true }) as { event: ClipEvent }).event.u).toBe(0.512)
  })

  it('stores through the time map: a fit that cut the clip moves where a played frame is in the source', () => {
    // (a blow at 0.8 of a 2 s source landed at 45 %: the start cut)
    const map = resolveTime({ seconds: 2, speed: 1, kept: [0.8, 2] })
    const view: TimeView = { toPlayed: u => map.toPlayed(u), toSource: v => map.toSource(v), snap: plain.snap }
    const cmd = addEvent(slot, 'release', 0.5, view, { id: 'r' })
    expect(cmd.type === 'slot.event.add' && cmd.event.u).toBeCloseTo(0.4 + 0.5 * 0.6, 9)
  })

  it('moves the selection together, the grabbed one on a frame, none out of the clip', () => {
    const moved = run(moveEvents(slot, ['h', 's'], 'h', 0.104, plain))
    expect(moved.events!.find(e => e.id === 'h')!.u).toBeCloseTo(0.6, 9)
    expect(moved.events!.find(e => e.id === 's')!.u).toBeCloseTo(0.5, 9)
    const span = run(moveEvents(slot, ['d'], 'd', -0.5, plain))
    expect(span.events!.find(e => e.id === 'd')).toMatchObject({ u: 0, to: expect.closeTo(0.2, 9) })
    const late = run(moveEvents(slot, ['d', 'h'], 'h', 0.9, plain))
    expect(late.events!.find(e => e.id === 'h')!.u).toBeCloseTo(1, 9)
    expect(moveEvents(slot, ['h'], 'h', 0.001, plain)).toEqual([])
  })

  it('picks the measured blow by hand when it is moved: a hit event where it was dropped', () => {
    const measured = makeSlot({ id: 'atk', events: [] })
    const cmds = moveEvents(measured, [MEASURED_HIT], MEASURED_HIT, 0.1, plain, { measured: 0.45 })
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toMatchObject({ type: 'slot.event.add', event: { name: 'hit', u: expect.closeTo(17 / 30, 9) } })
    expect(playedEvents(measured, plain, 0.45)).toEqual([{ id: MEASURED_HIT, name: 'hit', t: 0.45, measured: true }])
    expect(playedEvents(slot, plain, 0.45).some(e => e.measured === true)).toBe(false)
    expect(measuredHit({ start: 0.2, end: 1.2, blow: 0.65 })).toBeCloseTo(0.45, 9)
    expect(measuredHit(undefined)).toBeNull()
  })

  it("drags a span's ends, never past each other", () => {
    expect(run(moveEdge(slot, 'd', 'end', 0.7, plain)).events!.find(e => e.id === 'd')).toMatchObject({ u: 0.1, to: 0.7 })
    expect(run(moveEdge(slot, 'd', 'start', 0.9, plain, { minimum: 1 / 30 })).events!.find(e => e.id === 'd')!.u).toBeCloseTo(0.3 - 1 / 30, 9)
    expect(moveEdge(slot, 'h', 'end', 0.9, plain)).toEqual([])
  })

  it('makes a point a span and back, the hit never', () => {
    expect(run(toggleSpan(slot, 's', plain, 0.2)).events!.find(e => e.id === 's')).toMatchObject({ u: 0.4, to: expect.closeTo(0.6, 9) })
    expect(run(toggleSpan(slot, 'd', plain)).events!.find(e => e.id === 'd')!.to).toBeUndefined()
    expect(toggleSpan(slot, 'h', plain)).toEqual([])
  })

  it('removes the events chosen, the measured blow having none', () => {
    expect(run(removeEvents(slot, ['h', 'd', MEASURED_HIT])).events!.map(e => e.id)).toEqual(['s'])
  })

  it('finds what the playhead crossed: forward, round a loop, from the start of a one-shot played again', () => {
    const es = [{ t: 0 }, { t: 0.25 }, { t: 0.5 }, { t: 0.9 }]
    expect(crossed(es, 0.2, 0.5, true)).toEqual([{ t: 0.25 }, { t: 0.5 }])
    expect(crossed(es, 0.8, 0.1, true)).toEqual([{ t: 0 }, { t: 0.9 }])
    expect(crossed(es, 0.95, 0.3, false)).toEqual([{ t: 0 }, { t: 0.25 }])
    expect(crossed(es, 0.5, 0.5, true)).toEqual([])
  })
})

describe('footsteps', () => {
  // (a foot that lifts twice a cycle in a loop: down at frames 0 and 30 of 60; 2 cm of tremble on the ground)
  const walk = Array.from({ length: 61 }, (_, i) => {
    const p = (i % 30) / 30
    return p < 0.5 ? 0.01 * Math.sin(p * 40) : 0.15 * Math.sin((p - 0.5) * 2 * Math.PI)
  })

  it('finds where a foot comes down, not where it trembles, round a loop\'s seam', () => {
    const steps = footfalls(walk.map(h => Math.max(0, h)), true, 0.03)
    expect(steps).toEqual([0, 30])
    expect(footfalls(walk.map(h => Math.max(0, h)), false, 0.03)).toEqual([30, 60])
    expect(footfalls(walk.map(h => 0.2 * Math.max(0, h)), true, 0.05)).toEqual([])
  })

  it('reads them off a clip played on a rig, the lower of the foot and its toe, and leaves the rig as it was', () => {
    const root = new THREE.Object3D()
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.y = 1; root.add(hips)
    const left = new THREE.Bone(); left.name = 'LeftFoot'; left.position.set(0.1, -0.9, 0); hips.add(left)
    const right = new THREE.Bone(); right.name = 'RightFoot'; right.position.set(-0.1, -0.9, 0); hips.add(right)
    root.updateMatrixWorld(true)
    // (one second: the left foot up at 0.25 and down by 0.5, the right up at 0.75 and down by 1)
    const times = [0, 0.25, 0.5, 0.75, 1]
    const clip = new THREE.AnimationClip('Walk', 1, [
      new THREE.VectorKeyframeTrack('LeftFoot.position', times, [0.1, -0.9, 0, 0.1, -0.7, 0, 0.1, -0.9, 0, 0.1, -0.9, 0, 0.1, -0.9, 0]),
      new THREE.VectorKeyframeTrack('RightFoot.position', times, [-0.1, -0.9, 0, -0.1, -0.9, 0, -0.1, -0.9, 0, -0.1, -0.7, 0, -0.1, -0.9, 0]),
    ])
    const steps = footsteps(root, clip, true, 1.8)
    expect(steps.map(s => s.name)).toEqual(['step.L', 'step.R'])
    const l = steps.find(s => s.name === 'step.L')!
    const r = steps.find(s => s.name === 'step.R')!
    expect(l.bone).toBe('LeftFoot')
    expect(l.t).toBeGreaterThan(0.38)
    expect(l.t).toBeLessThan(0.5)
    // (down into the lowest fifth of its lift just before the loop's end)
    expect(r.t).toBeGreaterThan(0.9)
    expect(left.position.y).toBeCloseTo(-0.9, 9)
    expect(newSteps(steps, [{ name: 'step.L', t: l.t + 0.01 }], 0.05).map(s => s.name)).toEqual(['step.R'])
  })
})
