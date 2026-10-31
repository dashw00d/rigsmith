// @vitest-environment node
// The body's solids (src/engine/bodycollide.ts): fitted to a character's own mesh, clean on the library's poses, and the
// pose solver (src/engine/posespace.ts, NaturalOptions.collide) kept out of them: a hand pushed into the chest comes out,
// a free reach is unchanged, a live drag stays quick.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { loadGlbFile as load } from './headless.ts'
import { canonical, captureRest, retargetOffsets } from './retarget.ts'
import { BoundShape, buildBodyCollider, CharacterCollider, colliderFor, shaftObstacles, type BodyShape } from './bodycollide.ts'
import { BODY, DIM, NaturalRig, PoseModel, createBodySolver, encodeSource, restSoles, type PoseModelData } from './posespace.ts'

const ROOT = path.resolve(__dirname, '../..')
const LIBRARY = path.join(ROOT, 'workspace/library')
const YBOT = path.join(LIBRARY, 'mannequin', 'ybot.glb')
const MODEL = path.join(ROOT, 'static/templates/rom/human-pose.json')
const SPEARMAN = path.join(ROOT, 'workspace/characters/spearman-da04d7/rigged.glb')
const SKIRMISHER = path.join(ROOT, 'workspace/characters/skirmisher-19c713/rigged.glb')
const have = existsSync(YBOT) && existsSync(MODEL) && existsSync(path.join(LIBRARY, 'manifest.json'))

const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true
const wp = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3())
const wq = (o: THREE.Object3D): THREE.Quaternion => o.getWorldQuaternion(new THREE.Quaternion())
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const bonesOf = (scene: THREE.Object3D): Map<string, THREE.Bone> => { const m = new Map<string, THREE.Bone>(); scene.traverse(o => { if (isBone(o)) m.set(canonical(o.name), o as THREE.Bone) }); return m }

async function ybot (): Promise<{ scene: THREE.Group, bones: Map<string, THREE.Bone>, rig: NaturalRig, model: PoseModel }> {
  const model = new PoseModel(JSON.parse(readFileSync(MODEL, 'utf8')) as PoseModelData)
  const { scene } = await load(YBOT)
  scene.updateMatrixWorld(true)
  const bones = bonesOf(scene)
  return { scene, bones, rig: new NaturalRig(model, bones), model }
}

/** A library clip's pose at `t` on the Y Bot. */
async function poseFromClip (b: Awaited<ReturnType<typeof ybot>>, id: string, t: number): Promise<void> {
  const clip = await load(path.join(LIBRARY, 'clips', `${id}.glb`))
  const mixer = new THREE.AnimationMixer(clip.scene)
  mixer.clipAction(clip.animations[0]).play()
  mixer.setTime(t)
  clip.scene.updateMatrixWorld(true)
  const src = new Map<string, THREE.Object3D>()
  clip.scene.traverse(o => { if (isBone(o)) src.set(canonical(o.name), o) })
  const turns = BODY.map((n, i) => (i === 0 ? wq(src.get(n)!) : src.get(n)!.quaternion.clone()))
  const p = new Float64Array(DIM)
  const yaw = encodeSource(b.model, turns, p)
  b.rig.apply({ p, yaw, hips: wp(src.get('Hips')!).multiplyScalar(b.rig.scale) })
  b.scene.updateMatrixWorld(true)
}

const IDLES = ['mixamo-Breathing_Idle', 'mixamo-Box_Idle', 'mixamo-Action_Idle_To_Standing_Idle']
const FEET = ['LeftFoot', 'RightFoot']

describe('elliptical capsule end caps', () => {
  it('approaches the axial radius continuously and keeps the side radii', () => {
    const shape: BodyShape = {
      segments: [{ name: 'segment', a: 'a', b: 'b', ext: 1, tip: [0,0,0], off: [0,0,0], u1: [1,0,0], u2: [0,0,1], r1: .2, r2: .05 }],
      pairs: [], slack: [], quick: 0, bones: ['a','b'],
    }
    const bound = new BoundShape(shape, name => name === 'a' ? 0 : 1)
    bound.update([0,0,0, 0,1,0], [0,0,0,1, 0,0,0,1])
    const point = (x: number, y: number, z: number): number => bound.depthOf(0, [x,y,z], [x,y,z], 0)
    expect(point(0,1.03,0)).toBeCloseTo(.02, 8)
    expect(point(1e-6,1.03,0)).toBeCloseTo(point(0,1.03,0), 6)
    expect(point(1e-6,1.12,0)).toBe(0)
    expect(point(.15,.5,0)).toBeCloseTo(.05, 8)
    expect(point(0,.5,.04)).toBeCloseTo(.01, 8)
  })
})

describe('a held shaft as obstacles', () => {
  it('is cut either side of each hold, the hands let through, and nothing is left of a stretch too short', () => {
    const from = new THREE.Vector3(0, 1, 0); const to = new THREE.Vector3(2, 1, 0)
    const parts = shaftObstacles(from, to, 0.02, [1.5, 0.5], 0.1, ['LeftHand', 'RightHand'])
    expect(parts.map(o => [o.from.x, o.to.x])).toEqual([[0, 0.4], [0.6, 1.4], [1.6, 2]].map(([a, b]) => [expect.closeTo(a, 9), expect.closeTo(b, 9)]))
    for (const o of parts) { expect(o.radius).toBe(0.02); expect(o.ignore).toEqual(['LeftHand', 'RightHand']); expect(o.from.y).toBe(1) }
    // (two holds closer than the cuts: no sliver between them; a hold at the end: nothing past it)
    expect(shaftObstacles(from, to, 0.02, [1, 1.21], 0.1, []).map(o => [o.from.x, o.to.x])).toEqual([[0, expect.closeTo(0.9, 9)], [expect.closeTo(1.31, 9), 2]])
    expect(shaftObstacles(from, to, 0.02, [1.95], 0.1, []).map(o => [o.from.x, o.to.x])).toEqual([[0, expect.closeTo(1.85, 9)]])
    expect(shaftObstacles(from, from.clone(), 0.02, [], 0.1, [])).toEqual([])
  })
})

describe('a character\'s collider without a body to fit', () => {
  it('collides with nothing, says why, and is made once per root', () => {
    const root = new THREE.Group()
    const c = colliderFor(root, new Map(), 1.7)
    expect(c).toBeInstanceOf(CharacterCollider)
    expect(c.body).toBeNull()
    expect(c.problem).toMatch(/no skinned mesh/)
    expect(c.shape).toBeNull()
    expect(c.penetration(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 0.1)).toBe(0)
    expect(c.selfPenetration()).toEqual({ worst: 0, pairs: [] })
    expect(c.obstacleDepth(shaftObstacles(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), 0.05, [], 0.1, []))).toBe(0)
    expect(c.handWidth('Left')).toBeNull()
    expect(colliderFor(root, new Map(), 1.7)).toBe(c)
    // (another height is another collider: the hands' surfaces measure by it)
    expect(colliderFor(root, new Map(), 1.8)).not.toBe(c)
  })
})

describe.skipIf(!have)('the body as solids', () => {
  it('keeps the authored collision fit when a UV repair appends seam copies', async () => {
    const { scene } = await load(YBOT)
    scene.updateMatrixWorld(true)
    const bones = bonesOf(scene)
    const before = buildBodyCollider(scene, bones).shape
    scene.traverse(o => {
      const mesh = o as THREE.SkinnedMesh
      if (!mesh.isSkinnedMesh) return
      const count = mesh.geometry.attributes.position.count
      mesh.userData.surfaceVertexCount = count
      for (const name of ['position', 'skinIndex', 'skinWeight']) {
        const a = mesh.geometry.attributes[name]
        const values = Float32Array.from({ length: count * a.itemSize * 2 }, (_, i) => a.getComponent(Math.floor(i / a.itemSize) % count, i % a.itemSize))
        mesh.geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, a.itemSize))
      }
    })
    expect(buildBodyCollider(scene, bones).shape).toEqual(before)
  })
  it('fits every character\'s own mesh: sections that grow with the body, a pair list, nothing overlapping at rest', async () => {
    const dims: number[] = []
    for (const file of [YBOT, SPEARMAN, SKIRMISHER]) {
      if (!existsSync(file)) continue
      const { scene } = await load(file)
      scene.updateMatrixWorld(true)
      const c = buildBodyCollider(scene, bonesOf(scene))
      expect(c.shape.segments.length).toBe(17)
      expect(c.shape.pairs.length).toBeGreaterThan(40)
      const height = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3()).y
      for (const s of c.shape.segments) {
        expect(s.r1, `${path.basename(path.dirname(file))} ${s.name}`).toBeGreaterThan(0.005 * height)
        expect(s.r1, `${path.basename(path.dirname(file))} ${s.name}`).toBeLessThan(0.2 * height)
        expect(s.r2).toBeLessThanOrEqual(s.r1 * 1.01 + 1e-9 + 10 * s.r2)
      }
      expect(c.selfPenetration().worst, path.basename(path.dirname(file))).toBeLessThan(0.005 * height)
      const chest = c.shape.segments.find(s => s.name === 'Spine1')!
      dims.push((chest.r1 + chest.r2) / height)
    }
    console.log(`chest half-widths over the height: ${dims.map(d => d.toFixed(3)).join(', ')}`)
  })

  it('finds a hand pushed into the chest, a capsule through the body, and nothing in the way of a free hand', async () => {
    const b = await ybot()
    const c = buildBodyCollider(b.scene, b.bones)
    await poseFromClip(b, IDLES[0], 0.3)
    expect(c.selfPenetration().worst).toBeLessThan(0.01)
    const chest = wp(b.bones.get('Spine1')!)
    // (the left hand's wrist driven into the chest: the pose by hand)
    b.bones.get('LeftHand')!.position.set(0, 0, 0)
    const hand = b.bones.get('LeftHand')!
    const to = chest.clone().add(new THREE.Vector3(0, 0.03, 0.05))
    hand.parent!.updateMatrixWorld(true)
    hand.parent!.worldToLocal(to)
    hand.position.copy(to)
    b.scene.updateMatrixWorld(true)
    const inside = c.selfPenetration()
    expect(inside.worst).toBeGreaterThan(0.03)
    expect(inside.pairs.some(([x, y]) => [x, y].includes('LeftHand') && [x, y].includes('Spine1'))).toBe(true)
    // (a capsule of a prop's: along the chest's own axis, in it, and out in front of it)
    const neck = wp(b.bones.get('Neck')!)
    expect(c.penetration(chest.clone(), neck, 0.03)).toBeGreaterThan(0.1)
    expect(c.penetration(chest.clone().add(new THREE.Vector3(0, 0, 0.6)), neck.clone().add(new THREE.Vector3(0, 0, 0.6)), 0.03)).toBe(0)
    expect(c.penetration(chest.clone(), neck, 0.03, ['Spine1', 'Hips', 'Spine', 'Neck', 'LeftArm', 'RightArm', 'LeftHand', 'Head'])).toBeLessThan(c.penetration(chest.clone(), neck, 0.03))
  })

  it('is clean on the library\'s own poses (the allowances are the captures\' own contacts)', async () => {
    const b = await ybot()
    const c = buildBodyCollider(b.scene, b.bones)
    const manifest = JSON.parse(readFileSync(path.join(LIBRARY, 'manifest.json'), 'utf8')) as { clips: Array<{ file: string, source: string, duplicateOf?: string | null }> }
    const pool = manifest.clips.filter(x => x.source === 'mixamo-catalog' && (x.duplicateOf ?? null) === null).filter((_, k) => k % 25 === 0)
    const worst: number[] = []
    for (const cl of pool) {
      const clip = await load(path.join(LIBRARY, cl.file))
      const mixer = new THREE.AnimationMixer(b.scene)
      mixer.clipAction(clip.animations[0]).play()
      for (let f = 0; f <= Math.round(clip.animations[0].duration * 30); f += 10) { mixer.setTime(f / 30); b.scene.updateMatrixWorld(true); worst.push(c.selfPenetration().worst) }
      mixer.stopAllAction(); mixer.uncacheRoot(b.scene)
    }
    const clean = worst.filter(w => w < 0.01).length / worst.length
    console.log(`${pool.length} captures, ${worst.length} frames: ${(clean * 100).toFixed(1)}% within a cm of the allowances, worst ${(Math.max(...worst) * 100).toFixed(1)} cm`)
    expect(clean).toBeGreaterThan(0.93)
  })
})

describe.skipIf(!have)('the solver keeps body parts out of one another', () => {
  // (collision is an avoid signal, not a bounce (the designer): a weak pull into the chest is turned away, a firm one is met and
  // not fought (the cost saturates: a part deep in another is not shoved either way); neither ends deeper for the collider)
  it('steers a hand pulled weakly toward the chest out of it, and does not fight a firm pull', async () => {
    const b = await ybot()
    const c = buildBodyCollider(b.scene, b.bones)
    const rows: Array<{ off: number, weight: number, without: number, withIt: number, miss: number, pair: string | null }> = []
    for (const id of IDLES) for (const depth of [0.04, 0.08]) for (const weight of [0.1, 1]) {
      await poseFromClip(b, id, 0.3)
      // (a soft pull of the left wrist to a point inside the chest, `depth` behind its front)
      const chest = wp(b.bones.get('Spine1')!)
      const yaw = b.rig.encode().yaw
      const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
      const target = chest.clone().addScaledVector(fwd, 0.12 - depth).add(new THREE.Vector3(0, 0.02, 0))
      const goals = [{ bone: 'LeftHand', position: target, hard: false, weight }]
      const start = b.rig.encode()
      const hold = [...FEET, 'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck']
      const plain = b.rig.solve(goals, { keep: hold, mode: 'full' })
      b.scene.updateMatrixWorld(true)
      const without = c.selfPenetration().worst
      b.rig.apply(start); b.scene.updateMatrixWorld(true)
      const before = c.selfPenetration()
      const res = b.rig.solve(goals, { keep: hold, mode: 'full', collide: c })
      b.scene.updateMatrixWorld(true)
      const withIt = c.selfPenetration()
      rows.push({ off: depth, weight, without, withIt: withIt.worst, miss: res.softMiss, pair: withIt.pairs[0]?.slice(0, 2).join('+') ?? null })
      expect(res.penetration?.worst).toBeCloseTo(withIt.worst, 3)
      const increase = Math.max(0, ...withIt.pairs.map(([a, b, d]) => d - (before.pairs.find(([aa, bb]) => a === aa && b === bb)?.[2] ?? 0)))
      // The public collider omits contacts shallower than ten micrometres.
      expect(Math.abs(res.penetration!.increase! - increase)).toBeLessThan(1.1e-5)
      expect(plain.objective?.end.collide).toBeDefined()
    }
    console.log('hand to the chest, depth m -> overlap without / with (cm), soft miss cm:\n' + rows.map(r => `  ${r.off} at ${r.weight}: ${(r.without * 100).toFixed(1)} -> ${(r.withIt * 100).toFixed(1)}, miss ${(r.miss * 100).toFixed(1)} ${r.pair ?? ''}`).join('\n'))
    for (const r of rows) {
      expect(r.withIt).toBeLessThanOrEqual(r.without + 0.002)
      if (r.weight < 0.5) expect(r.withIt).toBeLessThan(r.without / 2 + 0.002); else expect(r.without).toBeGreaterThan(0.02)
    }
  })

  it('leaves a free reach as it was, and says so in the objective', async () => {
    const b = await ybot()
    const c = buildBodyCollider(b.scene, b.bones)
    const GOALS: number[][] = [[0.2, 0, 0.15], [-0.1, 0.1, 0.3], [0, -0.15, 0.25], [0.15, 0.2, 0.1]]
    let worstMove = 0; let free = 0; let moved = 0
    for (const id of IDLES) for (const hand of ['LeftHand', 'RightHand']) for (const d of GOALS) {
      await poseFromClip(b, id, 0.3)
      const start = b.rig.encode()
      const target = wp(b.bones.get(hand)!).add(new THREE.Vector3(...d))
      const plain = b.rig.solve([{ bone: hand, position: target }], { keep: FEET, mode: 'full' })
      b.scene.updateMatrixWorld(true)
      const plainOverlap = c.selfPenetration().worst
      const at = BODY.map(n => wp(b.bones.get(n)!))
      b.rig.apply(start); b.scene.updateMatrixWorld(true)
      const res = b.rig.solve([{ bone: hand, position: target }], { keep: FEET, mode: 'full', collide: c })
      b.scene.updateMatrixWorld(true)
      // (a reach that clears the body is the same with the collider on; one that does not is not worse)
      if (plainOverlap < 1e-6 && res.objective!.end.collide < 1e-9) { BODY.forEach((n, i) => { worstMove = Math.max(worstMove, wp(b.bones.get(n)!).distanceTo(at[i])) }); free++ } else moved++
      expect(res.penetration!.worst).toBeLessThanOrEqual(plainOverlap + 0.002)
      expect(res.miss).toBeLessThan(plain.miss + 0.003)
    }
    console.log(`${free} free reaches of ${3 * 2 * GOALS.length} (the other ${moved} brush an arm or the body): the most any joint moved with the collider on: ${(worstMove * 1000).toFixed(2)} mm`)
    expect(free).toBeGreaterThan(10)
    expect(worstMove).toBeLessThan(0.005)
  })

  it('is as quick for a live drag with the collider (a few ms)', async () => {
    const b = await ybot()
    const c = buildBodyCollider(b.scene, b.bones)
    const soles = restSoles(b.bones)
    const run = async (collide: boolean): Promise<number[]> => {
      const ms: number[] = []
      for (const id of IDLES) for (const d of [[0.2, 0, 0.15], [-0.1, 0.1, 0.3], [0, -0.15, 0.25], [0.15, 0.2, 0.1], [0.25, -0.1, 0.1], [-0.2, 0, 0.2]]) {
        await poseFromClip(b, id, 0.3)
        const target = wp(b.bones.get('RightHand')!).add(new THREE.Vector3(...d))
        ms.push(b.rig.solve([{ bone: 'RightHand', position: target }], { feet: FEET, floor: { y: 0, soles }, mode: 'quick', collide: collide ? c : undefined }).ms)
      }
      return ms
    }
    await run(true)
    const off: number[] = []; const on: number[] = []
    for (let k = 0; k < 3; k++) { off.push(...await run(false)); on.push(...await run(true)) }
    console.log(`quick drag: ${median(off).toFixed(2)} ms without (worst ${Math.max(...off).toFixed(1)}), ${median(on).toFixed(2)} ms with the collider (worst ${Math.max(...on).toFixed(1)})`)
    // (a loaded machine: the collider's own cost is a few ms at most)
    expect(median(on)).toBeLessThan(median(off) * 1.6 + 3)
    expect(median(on)).toBeLessThan(25)
  })

  it('is the same body through the character\'s collider, which also reads the hands\' surfaces and held shafts', async () => {
    const b = await ybot()
    const solid = buildBodyCollider(b.scene, b.bones)
    const c = new CharacterCollider(b.scene, b.bones, 1.8)
    expect(c.shape?.segments.map(x => [x.name, x.r1, x.r2])).toEqual(solid.shape.segments.map(x => [x.name, x.r1, x.r2]))
    await poseFromClip(b, IDLES[0], 0.3)
    const chest = wp(b.bones.get('Spine1')!)
    // (a shaft through the chest, held by the left hand: as deep as the plain collider says, the hand let through)
    const shaft = shaftObstacles(chest.clone().add(new THREE.Vector3(-0.4, 0, 0)), chest.clone().add(new THREE.Vector3(0.4, 0, 0)), 0.02, [], 0.05, ['LeftHand'])
    const depth = c.obstacleDepth(shaft)
    expect(depth).toBeGreaterThan(0.01)
    expect(depth).toBeCloseTo(Math.max(...shaft.map(o => solid.penetration(o.from, o.to, o.radius, o.ignore))), 9)
    expect(c.obstacleDepth(shaft, solid.shape.segments.map(x => x.name))).toBe(0)
    expect(c.handWidth('Left')).toBeGreaterThan(0.03)
    // (a hand's skinned surface, built once)
    const hand = c.hand('Left')
    expect(hand).not.toBeNull()
    expect(c.hand('Left')).toBe(hand)
    expect(hand!.positions.length).toBeGreaterThan(0)
  })

  it('goes through the editor\'s body solve (createBodySolver { collide })', async () => {
    const b = await ybot()
    const c = buildBodyCollider(b.scene, b.bones)
    const solver = createBodySolver(b.model, null, { collide: c })
    await poseFromClip(b, IDLES[0], 0.3)
    const chest = wp(b.bones.get('Spine1')!)
    const yaw = b.rig.encode().yaw
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
    const at = chest.clone().addScaledVector(fwd, 0.04).add(new THREE.Vector3(0, 0.02, 0))
    const legs = ['Left', 'Right'].map(s => ({ upper: b.bones.get(`${s}UpLeg`)!, lower: b.bones.get(`${s}Leg`)!, end: b.bones.get(`${s}Foot`)!, ball: b.bones.get(`${s}ToeBase`)!, tip: b.bones.get(`${s}Toe_End`)! }))
    const r = solver(b.bones, [{ hand: 'Left', at, turn: wq(b.bones.get('LeftHand')!) }], { limits: null, nameOf: (x: THREE.Bone) => canonical(x.name), legs, height: 1.7, quick: false }, null)
    b.scene.updateMatrixWorld(true)
    expect(r.state).toBeDefined()
    console.log(`the body solve with the wrist 8 cm inside the chest's front: overlap ${(c.selfPenetration().worst * 100).toFixed(1)} cm, hand off its goal ${(wp(b.bones.get('LeftHand')!).distanceTo(at) * 100).toFixed(1)} cm`)
  })
})

// (kept so an unused import of the retarget helpers is a type error only when they are really unused)
void captureRest; void retargetOffsets
