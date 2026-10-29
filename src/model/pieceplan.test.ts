// The Clip strip's gestures as commands (src/model/pieceplan.ts), applied by the reducer: a list that is the clip whole
// again stored as none, a late blow's held end kept when the clip is lengthened, the playhead read through the retime
// markers, the lengths of other slots measured again when they change.
import { describe, expect, it } from 'vitest'
import type { Command } from './command-types.ts'
import { applyCommands } from './commands.ts'
import { makeCharacter, makeSlot } from './fixtures.ts'
import { layoutOf } from './pieces.ts'
import { contentKey, planAppend, planEnd, planInsert, planRemove, type Plan, type PlanSlot } from './pieceplan.ts'
import { fitRange, resolveTime } from './timemap.ts'
import type { Character, Slot } from './types.ts'

let n = 0
const id = (): string => `n${++n}`
const commands = (p: Plan): Command[] => { if ('problem' in p) throw new Error(p.problem); return p.commands }

/** The slot as the timeline sees it after a bake: its time map (the fit's cut from its hit), its played length. */
function seen (c: Character, slotId: string, own = 2): PlanSlot {
  const slot = c.clips.find(s => s.id === slotId)!
  const D = layoutOf(slot.pieces ?? [{ id: 'm', kind: 'clip', clip: slot.clip, from: 0, to: own }]).seconds
  const fit = slot.time?.fit
  const hit = slot.events?.find(e => e.name === 'hit')
  const kept = fit?.enabled === true && hit !== undefined ? fitRange(hit.u * D, D, fit) : undefined
  const map = resolveTime({ seconds: D, speed: 1, time: slot.time, kept })
  return { slot, map, duration: map.duration, seconds: D, cut: kept === undefined ? undefined : { start: kept[0], end: kept[1], blow: hit!.u * D }, own }
}

describe('the strip\'s gestures as commands', () => {
  it('sends the clip\'s own length with every edit, so append then remove is the clip whole again: no list', () => {
    let c = makeCharacter({ clips: [makeSlot({ id: 's', name: 'Idle', clip: { id: 'a' }, bones: { Spine: [{ u: 1 / 3, q: [0, 0, 0, 1] }] } })] })
    c = applyCommands(c, commands(planAppend(seen(c, 's'), { id: 'b', kind: 'clip', clip: { id: 'b' }, from: 0, to: 1 }, 0, id))).character
    expect(c.clips[0].pieces).toHaveLength(2)
    c = applyCommands(c, commands(planRemove(seen(c, 's'), ['b'], id))).character
    expect(c.clips[0].pieces).toBeUndefined()
    expect(c.clips[0].bones!.Spine[0].u).toBeCloseTo(1 / 3, 15)
  })

  it('lengthens a late blow held past the clip\'s end by as much as dragged: the held end kept, the hold covering it', () => {
    // (a 2 s clip, its blow at 1.5 s landed at 0.45 by holding the end: played to 1.5 / 0.45 = 3.33 s)
    const c = makeCharacter({ clips: [makeSlot({ id: 'atk', name: 'Attack', clip: { id: 'a' }, loop: false, time: { fit: { enabled: true, at: 0.45, late: 'hold' } }, events: [{ id: 'h', name: 'hit', u: 0.75 }] })] })
    const s = seen(c, 'atk')
    expect(s.duration).toBeCloseTo(1.5 / 0.45, 9)
    const after = applyCommands(c, commands(planEnd(s, 1 + 0.5 / s.duration, id))).character
    const t = seen(after, 'atk')
    expect(t.duration).toBeCloseTo(1.5 / 0.45 + 0.5, 9)
    expect(after.clips[0].events![0].u * t.seconds).toBeCloseTo(1.5, 9)
    // (insert time at the end: the same)
    const ins = applyCommands(c, commands(planInsert(s, 1, 0.5, id))).character
    expect(seen(ins, 'atk').duration).toBeCloseTo(1.5 / 0.45 + 0.5, 9)
  })

  it('reads the playhead through the retime markers: time put in where the playhead shows', () => {
    // (a 2 s clip whose first half plays in 0.5 s, its second in 1.5 s: played phase 0.5 (1 s) is source second 4/3)
    const c = makeCharacter({ clips: [makeSlot({ id: 's', name: 'Walk', clip: { id: 'a' }, time: { markers: [{ id: 'm', u: 0.5, to: 0.25 }] } })] })
    const plan = commands(planInsert(seen(c, 's'), 0.5, 0.25, id))
    const set = plan.find(x => x.type === 'slot.pieces.set') as Extract<Command, { type: 'slot.pieces.set' }>
    expect(set.pieces![0].to).toBeCloseTo(4 / 3, 12)
  })

  it('keys another slot\'s length by everything it bakes from, so a change to it is measured again', () => {
    const run: Slot = makeSlot({ id: 'run', name: 'Run', clip: { id: 'r' } })
    const piece = { id: 'p', kind: 'slot' as const, slot: 'run', from: 0, to: 1 }
    const before = contentKey(piece, false, { clips: [run] })
    expect(contentKey(piece, false, { clips: [{ ...run, speed: 2 }] })).not.toBe(before)
    expect(contentKey({ id: 'q', kind: 'clip', clip: { id: 'r' }, from: 0, to: 1 }, true, { clips: [] })).toBe('clip:r||1')
  })
})
