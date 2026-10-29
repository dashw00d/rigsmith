// @vitest-environment node
// The events file the game reads (docs/motion-plan.md §6, tools/lib/unit_export.ts eventsFile): pure, each clip's events
// as exported (a companion's fit repeating or lengthening the clip, the companion's own under its prefix, volume and
// pitch kept only when they change something, times rounded and sorted) and the sound files its events play copied
// beside the build record. Then on the workspace (a scratch copy of its characters with events added: a release with a
// dropped sound, a swing, steps on the archer; hooves on the knight's horse): the units export the very GLBs they did
// without the events, and the events file says where each event lands as the game plays the clip.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as THREE from 'three'
import { afterAll, describe, expect, it } from 'vitest'
import type { BakedEvent, BakedSlot } from '../../src/engine/bake.ts'
import type { Character, Slot } from '../../src/model/types.ts'
import type { GameSpec, UnitEvents, UnitSpec } from '../../src/model/unit.ts'
import { WORKSPACE } from './node3d.ts'
import { copySounds, eventsFile, exportUnit, fitEvents, soundFile } from './unit_export.ts'

const scratch = mkdtempSync(path.join(tmpdir(), 'rigsmith-events-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

const slot = (name: string, loop: boolean): Slot => ({ id: name, name, clip: { id: 'x' }, speed: 1, loop, inPlace: true, adjustments: [] })
const baked = (events: BakedEvent[]): BakedSlot => ({ events } as unknown as BakedSlot)

describe('the events file', () => {
  const slots = [slot('Walk', true), slot('Attack', false)]
  const clips = [new THREE.AnimationClip('Walk', 2.2, []), new THREE.AnimationClip('Attack', 1.0333, [])]
  const b = new Map([
    ['Walk', baked([{ id: 'l', name: 'step.L', t: 0.1, bone: 'LeftFoot' }, { id: 'r', name: 'step.R', t: 0.6, sound: 'mix:hooves_walk', volume: 1 }])],
    ['Attack', baked([{ id: 'h', name: 'hit', t: 0.4500000001 }, { id: 'd', name: 'draw', t: -0.1, to: 0.3, pitch: 1.25 }, { id: 'x', name: 'late', t: 1.2 }, { id: 'w', name: 'swing', t: 0.2, volume: 0.333333 }])],
  ])

  it('lists every clip with its loop and length, its events in it, rounded and sorted, volume and pitch only when not 1', () => {
    const f = eventsFile('archer', slots, clips, b, { walk: 1.005, run: null })
    expect(f).toEqual({
      unit: 'archer', schema: 1, walkStride: 1.005, runStride: null,
      clips: {
        Walk: { loop: true, seconds: 2.2, events: [{ t: 0.1, name: 'step.L', bone: 'LeftFoot' }, { t: 0.6, name: 'step.R', sound: 'mix:hooves_walk' }] },
        // (a span begun before the clip starts with it; an event after its end isn't played)
        Attack: { loop: false, seconds: 1.033, events: [{ t: 0.2, name: 'swing', volume: 0.333 }, { t: 0.45, name: 'hit' }] },
      },
    })
  })

  it("places the unit's events where a companion's fit put its clip, and the companion's under its prefix", () => {
    const f = eventsFile('caravan', slots, clips, b, { walk: null, run: null }, {
      own: new Map([['Walk', { repeat: 2, share: 0.5 }]]),
      companion: { prefix: 'Pony_', events: new Map([['Walk', fitEvents([{ id: 'f', name: 'step.FL', t: 0.5, bone: 'front_leg_foot_l' }], { repeat: 3, share: 1 })]]) },
    })
    expect(f.clips.Walk.events.map(e => [e.name, e.t])).toEqual([['step.L', 0.025], ['step.R', 0.15], ['step.L', 0.275], ['step.R', 0.4]])
    expect(f.companion).toEqual({ prefix: 'Pony_', clips: { Walk: { events: [1, 3, 5].map(k => ({ t: Number((k / 6).toFixed(4)), name: 'step.FL', bone: 'Pony_front_leg_foot_l' })) } } })
    expect(eventsFile('caravan', slots, clips, b, { walk: null, run: null }, { companion: { prefix: 'Pony_', events: new Map() } }).companion).toBeUndefined()
  })

  it("copies the files its events play beside the record, a companion's under its prefix, and silences what is gone", () => {
    const from = path.join(scratch, 'pure')
    mkdirSync(path.join(from, 'unit', 'sounds'), { recursive: true })
    mkdirSync(path.join(from, 'pony', 'sounds'), { recursive: true })
    writeFileSync(path.join(from, 'unit', 'sounds', 'twang.wav'), 'twang')
    writeFileSync(path.join(from, 'pony', 'sounds', 'twang.wav'), 'neigh')
    const to = path.join(from, 'out', 'sounds')
    mkdirSync(to, { recursive: true })
    writeFileSync(path.join(to, 'stale.wav'), 'old')
    const f: UnitEvents = {
      unit: 'u', schema: 1, walkStride: null, runStride: null,
      clips: { Attack: { loop: false, seconds: 1, events: [
        { t: 0.1, name: 'release', sound: 'file:sounds/twang.wav' }, { t: 0.2, name: 'release', sound: 'file:sounds/twang.wav' },
        { t: 0.3, name: 'hit', sound: 'file:sounds/gone.wav' }, { t: 0.4, name: 'swing', sound: 'mix:sword_blow' }, { t: 0.5, name: 'odd', sound: 'file:../x.wav' },
      ] } },
      companion: { prefix: 'Pony_', clips: { Attack: { events: [{ t: 0.5, name: 'neigh', sound: 'file:sounds/twang.wav' }] } } },
    }
    const warned: string[] = []
    expect(copySounds(f, { unit: path.join(from, 'unit'), companion: path.join(from, 'pony') }, to, w => warned.push(w))).toEqual(['twang.wav', 'pony_twang.wav'])
    expect(readdirSync(to).sort()).toEqual(['pony_twang.wav', 'twang.wav'])
    expect(readFileSync(path.join(to, 'pony_twang.wav'), 'utf8')).toBe('neigh')
    expect(f.clips.Attack.events.map(e => e.sound)).toEqual(['file:sounds/twang.wav', 'file:sounds/twang.wav', undefined, 'mix:sword_blow', undefined])
    expect(f.companion!.clips.Attack.events[0].sound).toBe('file:sounds/pony_twang.wav')
    expect(warned).toHaveLength(2)
    expect(soundFile('file:sounds/a-b_c.ogg')).toBe('a-b_c.ogg')
    expect(soundFile('file:sounds/../a.ogg')).toBeNull()
    expect(soundFile('mix:x')).toBeNull()
  })
})

// ---- on the workspace ---------------------------------------------------------------------------------------------

const UNITS = ['archer', 'knight']
const CHARS = ['archer-b8157d', 'knight-3076bf', 'horse-31ad32']
const have = CHARS.every(id => existsSync(path.join(WORKSPACE, 'characters', id, 'character.json')))

/** A workspace whose characters are the real ones, files linked, each record copied for `edit` to change. */
function scratchWorkspace (dir: string, edit: (c: Character) => void): string {
  mkdirSync(path.join(dir, 'characters'), { recursive: true })
  symlinkSync(path.join(WORKSPACE, 'library'), path.join(dir, 'library'))
  cpSync(path.join(WORKSPACE, 'settings.json'), path.join(dir, 'settings.json'))
  for (const id of CHARS) {
    const from = path.join(WORKSPACE, 'characters', id)
    const to = path.join(dir, 'characters', id)
    mkdirSync(to)
    for (const f of readdirSync(from)) if (f !== 'character.json') symlinkSync(path.join(from, f), path.join(to, f))
    const c = JSON.parse(readFileSync(path.join(from, 'character.json'), 'utf8')) as Character
    edit(c)
    writeFileSync(path.join(to, 'character.json'), JSON.stringify(c))
  }
  return dir
}

describe.skipIf(!have)('the events file on the workspace', () => {
  const spec = JSON.parse(readFileSync(path.join(WORKSPACE, 'game', 'units.json'), 'utf8')) as GameSpec
  const unitSpec = (u: string): UnitSpec => ({ ...spec.defaults, ...spec.units[u] }) as UnitSpec

  it('exports the same GLBs, with each event where the game plays it and its sounds beside the record', async () => {
    const plainWs = scratchWorkspace(path.join(scratch, 'plain'), () => {})
    const eventsWs = scratchWorkspace(path.join(scratch, 'events'), c => {
      const s = (name: string): Slot => c.clips.find(x => x.name === name)!
      if (c.id === 'archer-b8157d') {
        s('Attack').events = [
          { id: 'rel', name: 'release', u: 0.5, bone: 'LeftHand', sound: 'file:sounds/twang.wav', volume: 0.8, pitch: 1.1 },
          { id: 'sw', name: 'swing', u: 0.2, to: 0.4, sound: 'mix:sword_blow' },
        ]
        s('Walk').events = [{ id: 'l', name: 'step.L', u: 0.25, bone: 'LeftFoot' }, { id: 'r', name: 'step.R', u: 0.75, bone: 'RightFoot' }]
      }
      if (c.id === 'horse-31ad32') s('Walk').events = [{ id: 'fl', name: 'step.FL', u: 0.5, bone: 'front_leg_foot_l', sound: 'file:sounds/hoof.wav' }]
    })
    mkdirSync(path.join(eventsWs, 'characters', 'archer-b8157d', 'sounds'))
    writeFileSync(path.join(eventsWs, 'characters', 'archer-b8157d', 'sounds', 'twang.wav'), 'RIFF twang')
    mkdirSync(path.join(eventsWs, 'characters', 'horse-31ad32', 'sounds'))
    writeFileSync(path.join(eventsWs, 'characters', 'horse-31ad32', 'sounds', 'hoof.wav'), 'RIFF hoof')

    const out = (ws: string, name: string): { modelsDir: string, workDir: string, workspace: string } =>
      ({ workspace: ws, modelsDir: path.join(scratch, name, 'models'), workDir: path.join(scratch, name, 'work') })
    for (const u of UNITS) {
      await exportUnit(u, unitSpec(u), out(plainWs, 'plain-out'))
      await exportUnit(u, unitSpec(u), out(eventsWs, 'events-out'))
      expect(readFileSync(path.join(scratch, 'events-out', 'models', `${u}.glb`)).equals(readFileSync(path.join(scratch, 'plain-out', 'models', `${u}.glb`)))).toBe(true)
    }

    const archer = JSON.parse(readFileSync(path.join(scratch, 'events-out', 'models', 'archer.events.json'), 'utf8')) as UnitEvents
    // (the archer's Attack has its fit off and plays at speed 1: its source is what plays)
    expect(archer.clips.Attack.events).toEqual([
      { t: 0.2, name: 'swing', to: 0.4, sound: 'mix:sword_blow' },
      { t: 0.5, name: 'release', sound: 'file:sounds/twang.wav', bone: 'LeftHand', volume: 0.8, pitch: 1.1 },
    ])
    expect(archer.clips.Walk).toMatchObject({ loop: true, events: [{ t: 0.25, name: 'step.L', bone: 'LeftFoot' }, { t: 0.75, name: 'step.R', bone: 'RightFoot' }] })
    expect(readFileSync(path.join(scratch, 'events-out', 'work', 'archer', 'sounds', 'twang.wav'), 'utf8')).toBe('RIFF twang')
    const record = JSON.parse(readFileSync(path.join(scratch, 'events-out', 'work', 'archer', 'rigsmith.json'), 'utf8')) as { events: UnitEvents }
    expect(record.events).toEqual(archer)

    // The knight rides: his horse's Walk repeated over its cycles under his, its steps under Horse_.
    const knight = JSON.parse(readFileSync(path.join(scratch, 'events-out', 'models', 'knight.events.json'), 'utf8')) as UnitEvents
    const kr = JSON.parse(readFileSync(path.join(scratch, 'events-out', 'work', 'knight', 'rigsmith.json'), 'utf8')) as { companion: { clips: Record<string, { cycles?: [number, number] }> } }
    const n = kr.companion.clips.Walk.cycles?.[1] ?? 1
    expect(knight.companion?.prefix).toBe('Horse_')
    expect(knight.companion?.clips.Walk.events).toEqual(Array.from({ length: n }, (_, k) => ({
      t: Number(((0.5 + k) / n).toFixed(4)), name: 'step.FL', bone: 'Horse_front_leg_foot_l', sound: 'file:sounds/horse_hoof.wav',
    })))
    expect(readFileSync(path.join(scratch, 'events-out', 'work', 'knight', 'sounds', 'horse_hoof.wav'), 'utf8')).toBe('RIFF hoof')
    expect(knight.clips.Attack.events).toEqual([{ t: 0.45, name: 'hit' }])
    // (without events the file is as it was: the migrated hits alone, no companion)
    const plainKnight = JSON.parse(readFileSync(path.join(scratch, 'plain-out', 'models', 'knight.events.json'), 'utf8')) as UnitEvents
    expect(plainKnight.companion).toBeUndefined()
    expect(existsSync(path.join(scratch, 'plain-out', 'work', 'knight', 'sounds'))).toBe(false)
  }, 120_000)
})
