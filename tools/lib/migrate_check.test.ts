// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { humanJoints, makeCharacter, makeGear } from '../../src/model/fixtures.ts'
import { migrate } from '../../src/model/migrate.ts'
import { DEFAULT_FIST } from '../../src/model/select.ts'
import type { Character, Vec3 } from '../../src/model/types.ts'
import type { GameSpec } from '../../src/model/unit.ts'
import type { V1AnimationEntry, V1Character, V1Garment, V1GripScript, V1PullSocket } from '../../src/model/v1.ts'
import { folkProblems, formatHashes, handProblems, jointProblems, parseHashes, refKey, v1Grips, v1HandAt } from './migrate_check.ts'

function v1 (over: Partial<V1Character> = {}): V1Character {
  return {
    id: 'hero-abc123',
    name: 'Hero',
    createdAt: 1,
    updatedAt: 2,
    source: { file: 'source/original.glb', originalName: 'hero.glb', bytes: 100 },
    status: 'rigged',
    kind: 'mesh',
    joints: humanJoints('full'),
    fingers: 'full',
    files: { model: 'model.glb', rigged: 'rigged.glb' },
    animations: [],
    ...over,
  }
}

const garment = (over: Partial<V1Garment> = {}): V1Garment => ({
  id: 'bow', name: 'Weapons_LeftHand', file: 'garments/bow/model.glb', status: 'ready', mode: 'rigid', policy: 'body',
  bone: 'LeftHand', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, hideBody: false, ...over,
})
const grip = (side: 'Left' | 'Right', clip: string, over: Partial<V1GripScript> = {}): V1GripScript =>
  ({ id: `${side}-${clip}`, kind: 'grip', enabled: true, side, clip, ...over })
const pull = (over: Partial<V1PullSocket> = {}): V1PullSocket =>
  ({ id: 'string', name: 'String', bone: 'RightHand', grip: [0, 0, 0], rest: [0, 0, 0], ...over })
const entry = (name: string): V1AnimationEntry => ({ clipId: `mixamo-${name}`, name, inPlace: true, loop: true, speed: 1 })
const shifted = (p: Vec3, d: number): Vec3 => [p[0] + d, p[1], p[2]]

describe('jointProblems', () => {
  it('passes a plain migration and one with joints placed by hand', () => {
    expect(jointProblems(v1(), migrate(v1()).character)).toEqual({ problems: [], info: [] })
    const auto = humanJoints('full')
    const edited = v1({ autoJoints: auto, jointsEdited: true, joints: { ...auto, Head: shifted(auto.Head, 0.05) } })
    const c = migrate(edited).character
    expect(Object.keys(c.skeleton.overrides)).toEqual(['Head'])
    expect(jointProblems(edited, c)).toEqual({ problems: [], info: [] })
  })

  it('says which joints moved, were lost or were added', () => {
    const auto = humanJoints('full')
    const edited = v1({ autoJoints: auto, jointsEdited: true, joints: { ...auto, Head: shifted(auto.Head, 0.05) } })
    const c = migrate(edited).character
    c.skeleton.overrides = {}
    expect(jointProblems(edited, c).problems).toEqual(['joints moved: Head by 5.0e-2'])
    const fewer = v1({ joints: { ...auto, Extra: [0, 0, 0] } })
    expect(jointProblems(fewer, migrate(fewer).character).problems).toEqual(['joints lost: Extra'])
    const more = migrate(v1()).character
    const short = v1({ joints: Object.fromEntries(Object.entries(auto).filter(([j]) => j !== 'Neck')) })
    expect(jointProblems(short, more).problems).toEqual(['joints added: Neck'])
  })

  it('needs the detected joints alone to cover the skeleton', () => {
    const c = migrate(v1()).character
    const head = c.skeleton.detected!.Head
    delete c.skeleton.detected!.Head
    c.skeleton.overrides = { Head: head }
    expect(jointProblems(v1(), c).problems).toEqual(['without its overrides the skeleton lacks Head'])
  })

  it('only notes a joint within the placed-by-hand threshold', () => {
    const auto = humanJoints('full')
    const nudged = v1({ autoJoints: auto, jointsEdited: true, joints: { ...auto, Head: shifted(auto.Head, 5e-8) } })
    expect(jointProblems(nudged, migrate(nudged).character)).toEqual({
      problems: [], info: ['1 joint within 1e-7 of before (below the placed-by-hand threshold)'],
    })
  })
})

describe('v1Grips (v1 handScripts)', () => {
  it('lets a grip of the character\'s own win over what the hand carries', () => {
    const axe = garment({ id: 'axe', name: 'Axe', bone: 'RightHand' })
    expect(v1Grips(v1({ garments: [axe], scripts: [grip('Right', 'mixamo-X')] }))).toEqual([{ side: 'Right', clip: 'mixamo-X' }])
    expect(v1Grips(v1({ garments: [axe], scripts: [grip('Right', 'mixamo-X', { enabled: false })] })))
      .toEqual([{ side: 'Right', clip: DEFAULT_FIST }])
  })

  it('closes a hand only on shown, ready, rigid gear, unless its carry pose is open', () => {
    expect(v1Grips(v1({ garments: [garment({ carryPose: 'mixamo-Y', carryOpen: { Idle: [[0.1, 0.2]] } })] })))
      .toEqual([{ side: 'Left', clip: 'mixamo-Y', open: { Idle: [[0.1, 0.2]] } }])
    for (const g of [garment({ carryPose: 'open' }), garment({ hidden: true }), garment({ status: 'importing' }), garment({ mode: 'clothing' })]) {
      expect(v1Grips(v1({ garments: [g] }))).toEqual([])
    }
  })

  it('reads a pose that is gone as the default fist', () => {
    const poses = [{ id: 'p1', name: 'Pinch', side: 'Right' as const, joints: {} }]
    expect(v1Grips(v1({ handPoses: poses, scripts: [grip('Right', 'pose:p1'), grip('Left', 'pose:gone')] })).map(g => g.clip))
      .toEqual(['pose:p1', DEFAULT_FIST])
  })

  it('adds a pulling hand with a pose, held only in its holds, above the fists', () => {
    const bow = garment({ pulls: [pull({ pose: 'mixamo-Z', holds: { Shoot: [[0.2, 0.5]] } }), pull({ id: 'b', pose: 'open' }), pull({ id: 'c', bone: 'Spine2', pose: 'mixamo-Z' })] })
    expect(v1Grips(v1({ garments: [bow] }))).toEqual([
      { side: 'Left', clip: DEFAULT_FIST },
      { side: 'Right', clip: 'mixamo-Z', during: { Shoot: [[0.2, 0.5]] } },
    ])
  })
})

describe('v1HandAt', () => {
  const grips = [
    { side: 'Right' as const, clip: 'mixamo-X', open: { Idle: [[0.4, 0.6]] as Array<[number, number]> } },
    { side: 'Right' as const, clip: 'pose:p1', during: { Idle: [[0.8, 0.9]] as Array<[number, number]> } },
  ]
  it('shows what is under a grip where it lets go, and a pull only where it holds', () => {
    expect(v1HandAt(grips, 'Right', 'Idle', 0.1)).toBe('fist:mixamo-X')
    expect(v1HandAt(grips, 'Right', 'Idle', 0.5)).toBe('none')
    expect(v1HandAt(grips, 'Right', 'Idle', 0.85)).toBe('pose:p1')
    expect(v1HandAt(grips, 'Right', 'Walk', 0.5)).toBe('fist:mixamo-X')
    expect(v1HandAt(grips, 'Left', 'Idle', 0.1)).toBe('none')
  })

  it('names schema 2 references the same way', () => {
    expect(refKey('default')).toBe(`fist:${DEFAULT_FIST}`)
    expect(refKey('clip')).toBe('none')
    expect(refKey({ fist: 'mixamo-X' })).toBe('fist:mixamo-X')
    expect(refKey({ pose: 'p1' })).toBe('pose:p1')
  })
})

describe('handProblems', () => {
  it('finds nothing where the migration keeps every hand as it was', () => {
    const raw = v1({
      animations: [entry('Idle'), entry('Shoot')],
      garments: [garment({ carryOpen: { Shoot: [[0.4, 0.6]] }, pulls: [pull({ pose: 'mixamo-Holding_Turn_Right', holds: { Shoot: [[0.2, 0.5]] } })] })],
      scripts: [grip('Right', 'mixamo-Golf_Post-Swing_2', { open: { Idle: [[0.1, 0.3]] } })],
    })
    expect(handProblems(raw, migrate(raw).character)).toEqual([])
  })

  it('reports where a hand now closes differently', () => {
    // (two grips on a hand: the migration keeps the later, so where it lets go the earlier no longer shows)
    const raw = v1({
      animations: [entry('Idle')],
      scripts: [grip('Right', 'mixamo-2hand_Idle'), grip('Right', 'mixamo-Golf_Post-Swing_2', { open: { Idle: [[0.5, 0.6]] } })],
    })
    const problems = handProblems(raw, migrate(raw).character)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^Idle, Right hand, 0\.4\d+-0\.6\d*: v1 fist mixamo-2hand_Idle, now the clip's own hand$/)
  })
})

describe('hash lists', () => {
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const c = 'c'.repeat(64)

  it('reads sha256sum output, paths inside the workspace made relative', () => {
    const text = `${a}  characters/x/rigged.glb\n${'B'.repeat(64)} */ws/characters/x/weight_edits.json\n# made before\n\n${c}  /elsewhere/y.glb\n`
    const hashes = parseHashes(text, '/ws')
    expect([...hashes]).toEqual([['characters/x/rigged.glb', a], ['characters/x/weight_edits.json', b], ['/elsewhere/y.glb', c]])
    expect(parseHashes(formatHashes(hashes), '/ws')).toEqual(hashes)
  })

  it('refuses a line it can\'t read', () => {
    expect(() => parseHashes(`${a}  ok.glb\nnot a hash\n`, '/ws')).toThrow(/Line 2/)
  })
})

describe('folkProblems (schema 4 -> 5)', () => {
  const v4 = (): Character => makeCharacter({
    id: 'folk-x',
    gear: [
      makeGear({ id: 'h1', name: 'Hair_a', role: 'hair', tags: ['fem'] }),
      makeGear({ id: 'b1', name: 'Beard_a', role: 'beard' }),
      makeGear({ id: 'm1', name: 'Outfit_mail_helm', outfit: 'mail', tags: ['covers-hair'] }),
      makeGear({ id: 'm2', name: 'Outfit_mail_forearm_L', outfit: 'mail' }),
      makeGear({ id: 's1', name: 'Outfit_straw_hat', outfit: 'straw' }),
    ],
    look: { layers: [], skins: [{ name: 'asha', file: 'skins/a.png', tags: ['female', 'beardless'] }, { name: 'bran', file: 'skins/b.png' }], clothes: [{ name: 'long', file: 'clothes/l.png', tags: ['long-sleeves'] }, { name: 'short', file: 'clothes/s.png' }] },
  })

  it('passes what the migration makes, and says what an edit broke', () => {
    const old = v4()
    const c = migrate({ ...old, schema: 4 }).character
    expect(folkProblems(old, c)).toEqual([])
    const broken = structuredClone(c)
    broken.folk!.pools.find(p => p.kind === 'hair')!.items[0] = { ref: 'h1' }
    broken.folk!.pools.find(p => p.kind === 'beard')!.excludes = []
    expect(folkProblems(old, broken).join('\n')).toMatch(/skin bran: hair h1 allowed, was \(none\)|hair h1 allowed/)
    expect(folkProblems(old, broken).join('\n')).toMatch(/beards b1 allowed/)
    expect(folkProblems(old, { ...c, folk: undefined })).toEqual(['its outfits, hair and beards were not made a folk section'])
  })

  it('checks the kinds against the units\' outfits', () => {
    const old = v4()
    const units: GameSpec = { units: { guard: { character: 'folk-x', height: 1.8, budget: 1, clips: [], folk: { outfits: ['mail'] } } } }
    const c = migrate({ ...old, schema: 4 }, { units }).character
    expect(folkProblems(old, c, units)).toEqual([])
    expect(folkProblems(old, migrate({ ...old, schema: 4 }).character, units)).toEqual(['kind guard: missing'])
  })
})
