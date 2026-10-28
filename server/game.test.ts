import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportReads, holdFiles, linesFor, modelFileOf, readLog, shipped, spliceUnit, unitChanges, unitProblems, type UnitSpec } from './game.ts'
import { withFiles } from './store.ts'

const sample = `{
 "_doc": ["x"],
 "units": {
  "a": {
   "character": "a-1",
   "height": 2.0,
   "clips": ["Idle"]
  },
  "b": {
   "character": "b-1",
   "height": 1.5,
   "clips": ["Idle", "Walk"]
  }
 }
}
`
const entry: UnitSpec = { character: 'a-2', height: 2.1, budget: 8000, clips: ['Idle', 'Walk'] }

describe('the game units.json splice', () => {
  it('replaces one unit and keeps every other byte', () => {
    const out = spliceUnit(sample, 'a', entry)
    expect(JSON.parse(out).units.a).toEqual(entry)
    expect(out.slice(out.indexOf('  "b"'))).toBe(sample.slice(sample.indexOf('  "b"')))
    expect(out.startsWith('{\n "_doc": ["x"],\n "units": {\n  "a": {\n   "character": "a-2",')).toBe(true)
  })
  it('adds a unit at the end and takes one out', () => {
    const added = spliceUnit(sample, 'c', entry)
    expect(Object.keys(JSON.parse(added).units)).toEqual(['a', 'b', 'c'])
    expect(JSON.parse(spliceUnit(added, 'b', null)).units).toEqual({ a: JSON.parse(sample).units.a, c: entry })
    expect(JSON.parse(spliceUnit(sample, 'b', null)).units).toEqual({ a: JSON.parse(sample).units.a })
  })
  it("leaves the game's own file unchanged when a unit is written back as it is", () => {
    const file = path.join(homedir(), 'dev', 'games', 'emberhold', 'tools', 'rigsmith', 'units.json')
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { return }
    const units = JSON.parse(text).units as Record<string, UnitSpec>
    const name = Object.keys(units).find(u => !/\d\.0\b/.test(JSON.stringify(units[u])) && !text.includes(`"${u}": {\n   "_`))
    if (name === undefined) return
    const again = spliceUnit(text, name, units[name])
    expect(JSON.parse(again)).toEqual(JSON.parse(text))
    // (only that block can differ, and only by how its numbers are written)
    expect(again.slice(0, again.indexOf(`  "${name}": {`))).toBe(text.slice(0, text.indexOf(`  "${name}": {`)))
  })
})

describe("a unit's entry", () => {
  const ok = { slots: ['Idle', 'Walk'], before: null, exists: (id: string) => ['a-1', 'horse-1'].includes(id) }
  const unit = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ character: 'a-1', height: 2, budget: 8000, clips: ['Idle'], ...over })

  it('passes a good one', () => {
    expect(unitProblems(unit(), ok)).toEqual([])
    expect(unitProblems(unit({ lods: [0.5, 0.2], draft: true, models_dir: 'assets/src3d/x', companion: { character: 'horse-1', height: 2.3, prefix: 'Horse_', budget: 7000, material: 'horse', ridden: true } }), ok)).toEqual([])
  })

  it('refuses heights, budgets and levels that make no sense', () => {
    expect(unitProblems(unit({ height: 0 }), ok)).toEqual(['Its height is a number of game units above 0'])
    expect(unitProblems(unit({ budget: '8000' }), ok)).toHaveLength(1)
    expect(unitProblems(unit({ lods: [0.2, 0.4] }), ok)).toHaveLength(1)
    expect(unitProblems(unit({ lods: [1.2] }), ok)).toHaveLength(1)
    expect(unitProblems(unit({ models_dir: '../../elsewhere' }), ok)).toEqual(["Its models_dir is a folder inside the game's repo"])
    expect(unitProblems(unit({ character: 'nobody' }), ok)).toEqual(['There is no character nobody'])
    expect(unitProblems(null, ok)).toEqual(['A unit is an object'])
  })

  it("takes only its character's slot names as clips, and keeps the names it had", () => {
    expect(unitProblems(unit({ clips: ['Idle', 'Run'] }), ok)).toEqual(['Run: not a clip of its character (name a slot in Motion first)'])
    expect(unitProblems(unit({ clips: ['Idle', 'Idle'] }), ok)).toEqual(['Idle is listed twice'])
    const before: UnitSpec = { character: 'a-1', height: 2, budget: 8000, clips: ['Idle', 'Run'] }
    expect(unitProblems(unit({ clips: ['Idle', 'Run'], height: 2.1 }), { ...ok, before })).toEqual([])
    // (no character to check against: the clips aren't judged)
    expect(unitProblems(unit({ clips: ['Run'] }), { ...ok, slots: null })).toEqual([])
  })

  it('checks its companion', () => {
    const companion = { character: 'a-1', height: 0, prefix: 'Horse-', budget: 7000, material: '' }
    expect(unitProblems(unit({ companion }), ok)).toEqual([
      "A unit can't be its own companion", "Its companion's height is a number above 0", "Its companion's bone prefix is a word (Horse_)",
      "Its companion's material names its surface (Atlas_<material>)",
    ])
  })

  it('says what changed, and stops being a draft when shipped', () => {
    const was: UnitSpec = { character: 'a-1', height: 2, budget: 8000, clips: ['Idle'], draft: true }
    expect(unitChanges('a', null, was)).toEqual(['game unit a: made (2 tall, 1 clip)'])
    expect(unitChanges('a', was, { ...was, height: 2.1, draft: undefined })).toEqual(['game unit a: height 2.1', 'game unit a: draft unset'])
    expect(unitChanges('a', was, null)).toEqual(["game unit a: taken off Rigsmith's list"])
    expect(shipped({ ...was, _draft: 'why' })).toEqual({ character: 'a-1', height: 2, budget: 8000, clips: ['Idle'] })
  })

  it('puts its model where its models_dir says', () => {
    expect(modelFileOf('/game', 'knight', {})).toBe(path.join('/game', 'assets', 'models', 'units', 'knight.glb'))
    expect(modelFileOf('/game', 'crew', { models_dir: 'assets/src3d/crew' })).toBe(path.join('/game', 'assets', 'src3d', 'crew', 'crew.glb'))
  })
})

describe("the game build's output", () => {
  const log = [
    'warning: knight: no blow timing on its Attack: the game lands each hit at 45 % of the clip',
    'warning: archer: Bow left out: hidden',
    '{"unit":"knight","walkStride":1.2}',
    'RIGSMITH_MAPS knight 1024px clan 3.1% glow 0.00% of the texture',
    'HOLDS knight     Attack   Weapons_RightHand  FAIL sinks 0.04  sink 0.040/3',
    'HOLDS knight     Idle     Weapons_RightHand  ok    sink 0.000/0',
    'HOLDS horse_archer Attack Bow  FAIL sinks',
    'HOLDS_DONE 2 problems -> /tmp/holds.json',
    'Traceback (most recent call last):',
  ]

  it("reads a unit's holds failed and warnings", () => {
    const mine = linesFor(log, 'knight', ['knight', 'archer', 'horse_archer'])
    expect(mine).not.toContain('warning: archer: Bow left out: hidden')
    expect(mine).toContain('HOLDS_DONE 2 problems -> /tmp/holds.json')
    expect(mine.some(l => l.includes('horse_archer'))).toBe(false)
    const { holdsFailed, warnings } = readLog(mine, 'knight')
    expect(holdsFailed).toEqual(['HOLDS knight     Attack   Weapons_RightHand  FAIL sinks 0.04  sink 0.040/3'])
    expect(warnings).toEqual(['no blow timing on its Attack: the game lands each hit at 45 % of the clip', 'Traceback (most recent call last):'])
  })
})

describe('an export holds what it reads', () => {
  const horse = { character: 'horse-1', height: 3, prefix: 'Horse_', budget: 4000, material: 'Horse', ridden: true }
  const spec = {
    units: {
      knight: { character: 'knight-1', height: 2, budget: 8000, clips: ['Idle'], companion: horse },
      squire: { character: 'squire-1', height: 1.8, budget: 6000, clips: ['Idle'], companion: horse },
      pony: { character: 'horse-1', height: 3, budget: 4000, clips: ['Idle'] },
    },
  }

  it("reads each unit's character and its companion, once each", () => {
    expect(exportReads(spec, ['knight', 'squire'])).toEqual(['knight-1', 'horse-1', 'squire-1'])
    expect(exportReads(spec, ['pony', 'nobody'])).toEqual(['horse-1'])
    expect(exportReads(spec, [])).toEqual([])
  })

  it('makes the writers of those files wait till it is done', async () => {
    const order: string[] = []
    let entered!: () => void
    let release!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve })
    const held = holdFiles(['test-hold-b', 'test-hold-a', 'test-hold-b'], async () => {
      order.push('export')
      entered()
      await new Promise<void>(resolve => { release = resolve })
      order.push('export done')
      return 'built'
    })
    await inside
    const writers = [
      withFiles('test-hold-a', async () => { order.push('a written') }),
      withFiles('test-hold-b', async () => { order.push('b written') }),
    ]
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(order).toEqual(['export'])
    release()
    expect(await held).toBe('built')
    await Promise.all(writers)
    expect(order.slice(0, 2)).toEqual(['export', 'export done'])
    expect(order.slice(2).sort()).toEqual(['a written', 'b written'])
  })
})
