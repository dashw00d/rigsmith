import { describe, expect, it } from 'vitest'
import { makeCharacter, makeSlot } from '../../model/fixtures.ts'
import type { Adjustment, ClipKey } from '../../model/types.ts'
import {
  addableKinds, addWindow, adjustmentText, blowFrame, blowPhase, blowUAt, blowUAtPhase, cardAction, cycleAt, inBakeOrder, overCycles,
  phasesOverCycles, timeAt, clipRefOf, cmPerUnit, defaultInPlace, framesOf, freeWindows, frameOf, handWindows,
  holdFromDistances, keysOf, keysWith, keyText, lateness, liftFromShown, liftShown, moveBefore, moveEdge, nameProblem, phaseIn,
  resolveTarget, rowsOf, snapPhase, speedOptions, trialName, usesOf, windowsText, windowText, type Row,
} from './rules.ts'

const GAME = ['Idle', 'Walk', 'Attack']

describe('slots and trials', () => {
  const c = makeCharacter({
    clips: [
      makeSlot({ id: 's1', name: 'Idle', clip: { id: 'mixamo-Idle' } }),
      makeSlot({ id: 's2', name: 'Walking', clip: { id: 'mixamo-Walking' } }),
      makeSlot({ id: 's3', name: 'Walk', clip: { id: 'mixamo-Walking' } }),
    ],
  })

  it('keeps a url only when it is not the converted clip file', () => {
    expect(clipRefOf({ id: 'mixamo-Idle', url: '/files/library/clips/mixamo-Idle.glb' })).toEqual({ id: 'mixamo-Idle' })
    expect(clipRefOf({ id: 'horse-trot', url: '/animations/horse-base.glb#Trot' })).toEqual({ id: 'horse-trot', url: '/animations/horse-base.glb#Trot' })
  })

  it('puts walks and runs in place', () => {
    expect(defaultInPlace({ inPlace: false, category: 'locomotion' })).toBe(true)
    expect(defaultInPlace({ inPlace: false, category: 'combat' })).toBe(false)
  })

  it('names a trial so it never takes a slot or another clip by its name', () => {
    expect(trialName(c, GAME, { name: 'Jab' })).toBe('Jab')
    expect(trialName(c, GAME, { name: 'Walking', description: 'Walking With A Briefcase' })).toBe('Walking With A Briefcase')
    expect(trialName(c, GAME, { name: 'Attack' })).toBe('Attack 2')
    expect(trialName(c, GAME, { name: 'Walking' })).toBe('Walking 2')
  })

  it('says when a name is taken or empty', () => {
    expect(nameProblem(c, 's2', 'Idle')).toMatch(/Another clip/)
    expect(nameProblem(c, 's2', '  ')).toMatch(/name/)
    expect(nameProblem(c, 's2', 'Walking')).toBeNull()
  })

  it('tells slots from trials using a clip', () => {
    const uses = usesOf(c, 'mixamo-Walking', GAME)
    expect(uses.slots.map(s => s.id)).toEqual(['s3'])
    expect(uses.trials.map(s => s.id)).toEqual(['s2'])
  })

  it('fills the armed slot, else removes only trials, else adds a trial', () => {
    expect(cardAction(c, 'mixamo-Walking', GAME, { slotId: 's1', name: 'Idle' })).toEqual({ kind: 'fill', target: { slotId: 's1', name: 'Idle' } })
    const remove = cardAction(c, 'mixamo-Walking', GAME, null)
    expect(remove.kind === 'remove' && remove.trials.map(s => s.id)).toEqual(['s2'])
    // (a slot's clip is never taken out from a card)
    expect(cardAction(c, 'mixamo-Idle', GAME, null)).toEqual({ kind: 'add' })
    expect(cardAction(c, 'mixamo-Run', GAME, null)).toEqual({ kind: 'add' })
  })

  it('resolves an armed target by id, then by name', () => {
    expect(resolveTarget(c, { slotId: 's1', name: 'Whatever' }).slot?.id).toBe('s1')
    expect(resolveTarget(c, { slotId: 'gone', name: 'Walk' }).slot?.id).toBe('s3')
    expect(resolveTarget(c, { slotId: null, name: 'Attack' })).toEqual({ slot: null, name: 'Attack' })
  })

  it('moves an id before another', () => {
    expect(moveBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moveBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
    expect(moveBefore(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c'])
  })

  it('offers the speeds with the current one', () => {
    expect(speedOptions(0.9)).toContain(0.9)
    expect(speedOptions(1).filter(s => s === 1)).toHaveLength(1)
  })
})

describe('frames', () => {
  it('counts frames of the clip as it plays, per ridden cycle', () => {
    expect(framesOf(2)).toBe(60)
    expect(framesOf(4, 2)).toBe(60)
    expect(frameOf(0.5, 60)).toBe(30)
    expect(snapPhase(0.501, 60)).toBeCloseTo(0.5)
  })

  it('finds the phase within a ridden cycle', () => {
    expect(phaseIn(0.75, 2, true)).toBeCloseTo(0.5)
    expect(phaseIn(1, 1, false)).toBe(1)
    expect(phaseIn(0.25, 1, true)).toBeCloseTo(0.25)
  })
})

describe('windows', () => {
  it('finds room for a new hand pose', () => {
    expect(freeWindows([])).toBeUndefined()
    expect(freeWindows([[0, 1]])).toBeNull()
    expect(freeWindows([[0, 0.3], [0.5, 0.6]])).toEqual([[0.6, 1]])
  })

  it('moves an edge unless it empties or overlaps', () => {
    expect(moveEdge([[0.1, 0.3], [0.5, 0.7]], 0, 1, 0.4)).toEqual([[0.1, 0.4], [0.5, 0.7]])
    expect(moveEdge([[0.1, 0.3], [0.5, 0.7]], 0, 1, 0.6)).toBeNull()
    expect(moveEdge([[0.1, 0.3]], 0, 0, 0.3)).toBeNull()
  })

  it('adds a window where there is room', () => {
    expect(addWindow([], 0.5)).toEqual([[0.5, 0.7]])
    expect(addWindow([[0.6, 0.8]], 0.5)).toEqual([[0.5, 0.6], [0.6, 0.8]])
    expect(addWindow([[0.4, 0.8]], 0.5)).toBeNull()
  })

  it('says windows in frames when they are known, else as parts of the clip', () => {
    expect(windowsText(undefined, 30)).toBe('the whole clip')
    expect(windowsText([[0.1, 0.5]], 30)).toBe('frames 3–15')
    expect(windowsText([[0.1, 0.5]], null)).toBe('10–50%')
    expect(windowsText([[0, 0.255], [0.9, 1]])).toBe('0–26%, 90–100%')
    expect(windowsText([], 30)).toBe('never')
    expect(windowText([0, 1], 30)).toBe('the whole clip')
    expect(windowText([0.5, 0.8])).toBe('50–80%')
  })

  it('collects a hand\'s other poses', () => {
    const slot = makeSlot({
      adjustments: [
        { id: 'a', kind: 'handPose', enabled: true, hand: 'Left', pose: 'clip' },
        { id: 'b', kind: 'handPose', enabled: true, hand: 'Right', pose: 'clip', windows: [[0.2, 0.4]] },
      ],
    })
    expect(handWindows(slot, 'Left')).toEqual([[0, 1]])
    expect(handWindows(slot, 'Right')).toEqual([[0.2, 0.4]])
    expect(handWindows(slot, 'Right', 'b')).toEqual([])
  })
})

describe('keys', () => {
  const k = (u: number, deg = 0): ClipKey => ({ u, q: [Math.sin(deg * Math.PI / 360), 0, 0, Math.cos(deg * Math.PI / 360)] })
  const a: Extract<Row, { kind: 'keys' }> = { id: 'k', kind: 'keys', enabled: true, bones: { Hips: [k(0)] }, gear: { g1: [k(0.5)] } }

  it('reads and sets one target\'s keys', () => {
    const slot = makeSlot({ bones: { Hips: [k(0)] }, gear: { g1: { keys: [{ ...k(0.5), ease: 'step' }] } } })
    expect(keysOf(slot, 'bone:Hips')).toHaveLength(1)
    // (as stored, eases and all)
    expect(keysOf(slot, 'gear:g1')).toEqual([{ ...k(0.5), ease: 'step' }])
    expect(keysOf(undefined, 'bone:Hips')).toEqual([])
    expect(keysWith(a, 'bone:Spine', [k(0.2)])).toEqual({ bones: { Hips: [k(0)], Spine: [k(0.2)] }, gear: { g1: [k(0.5)] } })
    expect(keysWith(a, 'gear:g1', [])).toEqual({ bones: { Hips: [k(0)] } })
    expect(keysWith({ ...a, gear: undefined }, 'bone:Hips', [])).toBeNull()
  })

  it('describes a key', () => {
    expect(keyText(k(0))).toBe('no change')
    expect(keyText(k(0, 30))).toBe('30°')
    expect(keyText({ ...k(0), p: [0, 0.1, 0] })).toBe('0° + move')
  })
})

describe('ground', () => {
  it('shows a lift in cm of the game, else % of the height', () => {
    const perCm = cmPerUnit(2, 1.8)
    expect(liftShown(0.018, perCm, 1.8)).toBe(2)
    expect(liftFromShown(2, perCm, 1.8)).toBeCloseTo(0.018)
    expect(cmPerUnit(null, 1.8)).toBeNull()
    expect(liftShown(0.018, null, 1.8)).toBe(1)
    expect(liftFromShown(1, null, 1.8)).toBeCloseTo(0.018)
  })
})

describe('the blow', () => {
  const cut = { start: 0.3, end: 1.2, uncut: 1.5, blow: 0.7 }

  it('sets the blow from the frame playing, never the first or last', () => {
    expect(blowUAt(cut, 0.9, 0.4)).toBeCloseTo(0.7 / 1.5)
    expect(blowUAt(undefined, 1.5, 0)).toBeNull()
    expect(blowUAt(undefined, 1.5, 1.5)).toBeNull()
    expect(blowUAt(undefined, 1.5, 0.75)).toBeCloseTo(0.5)
  })

  it('finds the blow\'s frame in the clip as played', () => {
    expect(blowFrame(cut)).toBe(12)
    expect(blowPhase(cut)).toBeCloseTo(0.4 / 0.9)
  })

  it('sets the blow from the phase playing, cut or not', () => {
    expect(blowUAtPhase(cut, 0.4 / 0.9, 0.9)).toBeCloseTo(0.7 / 1.5)
    expect(blowUAtPhase(undefined, 0.5, 2)).toBeCloseTo(0.5)
    expect(blowUAtPhase(undefined, 0, 2)).toBeNull()
  })

  it('says what a late blow costs', () => {
    expect(lateness({ at: 0.45 }, cut)).toMatch(/first 0.30 s are cut/)
    expect(lateness({ at: 0.45, late: 'hold' }, { start: 0, end: 1.8, uncut: 1.5, blow: 0.9 })).toMatch(/held 0.30 s/)
    expect(lateness({ at: 0.6 }, cut)).toBeNull()
    expect(lateness({ at: 0.45, window: 0.5 }, cut)).toBeNull()
  })
})

describe('holds', () => {
  it('holds from the first touch to the release, or while drawn', () => {
    const dist = [1, 0.5, 0.02, 0.1, 0.2, 0.9, 1]
    expect(holdFromDistances(dist, 0.03, 0.3, null)).toEqual([0.333, 0.667])
    expect(holdFromDistances(dist, 0.03, 0.3, 5 / 6)).toEqual([0.333, 0.833])
    expect(holdFromDistances([1, 1, 1], 0.03, 0.3, null)).toBeNull()
  })
})

describe('ridden cycles', () => {
  it('finds the cycle and the time of a phase in it', () => {
    expect(cycleAt(0, 3)).toBe(0)
    expect(cycleAt(0.5, 3)).toBe(1)
    expect(cycleAt(1, 3)).toBe(2)
    expect(cycleAt(0.7, 1)).toBe(0)
    expect(timeAt(0.5, 1, 2, 4)).toBeCloseTo(3)
    expect(timeAt(0.25, 0, 1, 2)).toBeCloseTo(0.5)
  })

  it('lays one cycle\'s windows and keys over every cycle', () => {
    expect(overCycles([[0.2, 0.4]], 2)).toEqual([[0.1, 0.2], [0.6, 0.7]])
    expect(overCycles([[0.2, 0.4]], 1)).toEqual([[0.2, 0.4]])
    expect(phasesOverCycles([0.5], 2)).toEqual([0.25, 0.75])
  })
})

describe('the adjustments stack', () => {
  const ground: Adjustment = { id: 'g', kind: 'ground', enabled: true, lift: 0.01 }
  const keys: Row = { id: 'k', kind: 'keys', enabled: true, bones: { Spine: [{ u: 0, q: [0, 0, 0, 1] }] } }
  const blow: Row = { id: 'b', kind: 'blowTiming', enabled: true, at: 0.45 }
  const hold: Adjustment = { id: 'h', kind: 'handleHold', enabled: true, gear: 'bow', handle: 'string', windows: [[0.2, 0.5]] }

  it('lists them in the order the bake applies them', () => {
    expect(inBakeOrder([keys, ground, hold, blow]).map(a => a.id)).toEqual(['b', 'h', 'g', 'k'])
  })

  it('offers only what the slot can take one more of', () => {
    const slot = makeSlot({ id: 's', adjustments: [ground, hold] })
    // (keys always have their row: keying starts there)
    expect(addableKinds(slot, { otherSlots: 0, pulls: 1 })).toEqual(['blowTiming', 'handPose'])
    expect(addableKinds(slot, { otherSlots: 2, pulls: 2 })).toEqual(['blowTiming', 'pace', 'handPose', 'handleHold'])
    expect(addableKinds({ ...slot, time: { fit: { enabled: true, at: 0.45 } } }, { otherSlots: 2, pulls: 2 })).toEqual(['pace', 'handPose', 'handleHold'])
    expect(rowsOf({ ...slot, time: { fit: { enabled: false, at: 0.4 } }, events: [{ id: 'e', name: 'hit', u: 0.6 }] }).map(r => [r.id, r.kind])).toEqual([
      ['g', 'ground'], ['h', 'handleHold'], ['fit', 'blowTiming'], ['keys', 'keys'],
    ])
  })

  it('says each in a few words', () => {
    const c = makeCharacter({ clips: [makeSlot({ id: 'w', name: 'Walk' })] })
    expect(adjustmentText(c, { id: 'p', kind: 'pace', enabled: true, like: 'w' }, { frames: null })).toBe('like Walk')
    expect(adjustmentText(c, blow, { frames: null })).toBe('lands at 45%')
    expect(adjustmentText(c, keys, { frames: null })).toBe('1 bone')
    expect(adjustmentText(c, { id: 'x', kind: 'handPose', enabled: true, hand: 'Left', pose: 'clip', windows: [[0.5, 1]] }, { frames: 30, pose: () => 'open' }))
      .toBe('Left hand open, frames 15–30')
  })
})
