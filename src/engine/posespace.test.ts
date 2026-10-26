// @vitest-environment node
// Natural movement (src/engine/posespace.ts) on the Y Bot and a character, against the library's motion captures and the
// plain solvers (ik.ts's reach, twohand.ts); skipped without the local library (and the pose model, tools/posespace.ts).
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { canonical, captureRest, retargetOffsets } from './retarget.ts'
import { JointLimits, type Rom } from './limits.ts'
import { reach, setWorldQuaternion, type Leg } from './ik.ts'
import { handGrip } from './clipedit.ts'
import { solveBody } from './bodysolve.ts'
import { BODY, DIM, NB, NaturalRig, PoseModel, createBodySolver, encodeSource, mirrorPose, naturalizeClip, naturalizeFrames, poseTargets, restSoles, type NaturalGoal, type PoseModelData } from './posespace.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images in tests') }

const ROOT = path.resolve(__dirname, '../..')
const LIBRARY = path.join(ROOT, 'workspace/library')
const YBOT = path.join(LIBRARY, 'mannequin', 'ybot.glb')
const MODEL = path.join(ROOT, 'static/templates/rom/human-pose.json')
const CHARACTER = path.join(ROOT, 'workspace/characters/spearman-da04d7/rigged.glb')
const have = existsSync(YBOT) && existsSync(MODEL) && existsSync(path.join(LIBRARY, 'manifest.json'))
const haveCharacter = have && existsSync(CHARACTER)

const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true
async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  const data = readFileSync(file)
  return await new Promise((resolve, reject) => { new GLTFLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '', r => { resolve(r) }, reject) })
}
const wp = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3())
const wq = (o: THREE.Object3D): THREE.Quaternion => o.getWorldQuaternion(new THREE.Quaternion())
const nameOf = (b: THREE.Bone): string => canonical(b.name)
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

interface Body { soles: Record<string, number>, scene: THREE.Group, bones: Map<string, THREE.Bone>, rig: NaturalRig, limits: JointLimits, model: PoseModel, rom: Rom, offsets: Map<string, THREE.Quaternion> | null, legs: Leg[] }

async function body (file: string, withOffsets: boolean): Promise<Body> {
  const model = new PoseModel(JSON.parse(readFileSync(MODEL, 'utf8')) as PoseModelData)
  const rom = JSON.parse(readFileSync(path.join(ROOT, 'static/templates/rom/human.json'), 'utf8')) as Rom
  const { scene } = await load(file)
  scene.updateMatrixWorld(true)
  let offsets: Map<string, THREE.Quaternion> | null = null
  if (withOffsets) {
    const ybot = (await load(YBOT)).scene
    ybot.updateMatrixWorld(true)
    offsets = retargetOffsets(captureRest(ybot, isBone), captureRest(scene, isBone)).offsets
  }
  const bones = new Map<string, THREE.Bone>()
  scene.traverse(o => { if (isBone(o)) bones.set(canonical(o.name), o as THREE.Bone) })
  const parentOf = (n: string): string | null => { const p = bones.get(n)?.parent; return p !== undefined && p !== null && isBone(p) ? canonical(p.name) : null }
  const limits = new JointLimits(rom, offsets, parentOf)
  const legs = ['Left', 'Right'].map(s => ({ upper: bones.get(`${s}UpLeg`)!, lower: bones.get(`${s}Leg`)!, end: bones.get(`${s}Foot`)!, ball: bones.get(`${s}ToeBase`)!, tip: bones.get(`${s}Toe_End`)! }))
  return { scene, bones, soles: restSoles(bones), rig: new NaturalRig(model, bones, { offsets, limits }), limits, model, rom, offsets, legs }
}

/** A library clip's pose at `t` on a body (its bones' local turns, through the retarget's K when it has them). */
async function poseFromClip (b: Body, id: string, t: number): Promise<Float64Array> {
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
  // (the hips where the clip has them, in the body's size: a pose does not inherit the last solve's shift)
  b.rig.apply({ p, yaw, hips: wp(src.get('Hips')!).multiplyScalar(b.rig.scale) })
  b.scene.updateMatrixWorld(true)
  return p
}

/** The rule-based two-handed solver this one is meant to beat (src/engine/twohand.ts), while it is in the tree. */
interface TwoHandHold { hand: 'Left' | 'Right', bone: string, fist: [number, number, number], shaft: [number, number, number], turn: [number, number, number, number], fistOffset: [number, number, number] }
type HoldTwoHanded = (bones: Map<string, THREE.Bone>, hold: TwoHandHold, opts: { limits: JointLimits | null, nameOf: (b: THREE.Bone) => string, legs: Leg[] }, prev: null) => { miss: number }
const baselinePath = './twohand.ts'
const baseline = await import(/* @vite-ignore */ baselinePath).then(m => (m as { holdTwoHanded: HoldTwoHanded }).holdTwoHanded).catch(() => null)

const IDLES = ['mixamo-Breathing_Idle', 'mixamo-Box_Idle', 'mixamo-Action_Idle_To_Standing_Idle']

describe.skipIf(!have)('the pose model on held-out captures', () => {
  it('rebuilds poses of clips it was not fitted on within its reported errors', async () => {
    const model = new PoseModel(JSON.parse(readFileSync(MODEL, 'utf8')) as PoseModelData)
    expect(model.data.heldOut).toBeDefined()
    const reported = model.data.heldOut!
    const manifest = JSON.parse(readFileSync(path.join(LIBRARY, 'manifest.json'), 'utf8')) as { clips: Array<{ file: string, source: string, duplicateOf?: string | null }> }
    const pool = manifest.clips.filter(c => c.source === 'mixamo-catalog' && (c.duplicateOf ?? null) === null)
    // every 10th clip was held out of the fit (tools/posespace.ts); a spread of them here
    const held = pool.filter((_, k) => k % 10 === 9).filter((_, k) => k % 6 === 0)
    expect(held.length).toBeGreaterThan(20)
    const errors: number[] = []
    const p = new Float64Array(DIM); const r = new Float64Array(DIM)
    for (const c of held) {
      const clip = await load(path.join(LIBRARY, c.file))
      const mixer = new THREE.AnimationMixer(clip.scene)
      mixer.clipAction(clip.animations[0]).play()
      clip.scene.updateMatrixWorld(true)
      const src = new Map<string, THREE.Object3D>()
      clip.scene.traverse(o => { if (isBone(o)) src.set(canonical(o.name), o) })
      const parentQ = wq(src.get('Hips')!.parent!)
      const n = Math.round(clip.animations[0].duration * 30)
      for (let f = 0; f <= n; f += 6) {
        mixer.setTime(f / 30)
        const turns = BODY.map((name, i) => (i === 0 ? parentQ.clone().multiply(src.get(name)!.quaternion) : src.get(name)!.quaternion.clone()))
        encodeSource(model, turns, p)
        model.reconstruct(p, r)
        for (let i = 0; i < NB; i++) {
          const a = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).normalize(), Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]))
          const b = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(r[i * 3], r[i * 3 + 1], r[i * 3 + 2]).normalize(), Math.hypot(r[i * 3], r[i * 3 + 1], r[i * 3 + 2]))
          errors.push(THREE.MathUtils.radToDeg(a.angleTo(b)))
        }
      }
    }
    const sorted = [...errors].sort((a, b) => a - b)
    const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))]
    const med = median(errors)
    console.log(`held-out sample: ${held.length} clips, ${errors.length / NB} frames, ${model.k} components: median ${med.toFixed(2)} deg, 95th ${p95.toFixed(2)} deg (reported ${reported.median} / ${reported.p95})`)
    // (a sample of the held-out clips: near the reported numbers over all of them)
    expect(med).toBeLessThan(reported.median * 1.5 + 0.3)
    expect(p95).toBeLessThan(reported.p95 * 1.5 + 1)
    expect(model.k).toBeLessThan(60)
  })

  it('mirrors a pose to the other side and back', () => {
    const p = Float64Array.from({ length: DIM }, (_, i) => Math.sin(i * 1.7) * 0.5)
    const m = new Float64Array(DIM); const back = new Float64Array(DIM)
    mirrorPose(p, m); mirrorPose(m, back)
    for (let i = 0; i < DIM; i++) expect(back[i]).toBeCloseTo(p[i], 12)
    // the left hand's numbers are the right's, reflected
    const L = BODY.indexOf('LeftHand') * 3; const R = BODY.indexOf('RightHand') * 3
    expect(m[R]).toBeCloseTo(p[L], 12); expect(m[R + 1]).toBeCloseTo(-p[L + 1], 12)
  })
})

describe.skipIf(!have)('a character takes the model through the retarget', () => {
  it('reads and writes the same pose on the Y Bot and on a retargeted character', { skip: !haveCharacter }, async () => {
    const ybot = await body(YBOT, false)
    const char = await body(CHARACTER, true)
    const p = await poseFromClip(ybot, 'mixamo-Box_Idle', 0.4)
    await poseFromClip(char, 'mixamo-Box_Idle', 0.4)
    const back = char.rig.encode()
    let worst = 0
    for (let d = 0; d < DIM; d++) worst = Math.max(worst, Math.abs(back.p[d] - p[d]))
    expect(worst).toBeLessThan(1e-6)
    // (the same pose: each end in the same direction from the hips; a character's proportions differ, so only the directions)
    const ends = ['LeftHand', 'RightHand', 'Head']
    const rel = (b: Body): THREE.Vector3[] => ends.map(n => wp(b.bones.get(n)!).sub(wp(b.bones.get('Hips')!)).normalize())
    ybot.scene.updateMatrixWorld(true); char.scene.updateMatrixWorld(true)
    const a = rel(ybot); const c = rel(char)
    a.forEach((v, i) => { expect(THREE.MathUtils.radToDeg(v.angleTo(c[i])), ends[i]).toBeLessThan(25) })
  })
})

interface Reach { miss: number, ms: number, total: number, ikTotal: number, ikMiss: number, startTotal: number }

/** A hand goal `d` from where the hand is in a clip's pose: the solver's, then plain IK's from the same start. */
async function reachCase (b: Body, id: string, hand: string, d: number[], mode: 'quick' | 'full'): Promise<Reach> {
  await poseFromClip(b, id, 0.3)
  const target = wp(b.bones.get(hand)!).add(new THREE.Vector3(...d).multiplyScalar(b.rig.scale))
  const res = b.rig.solve([{ bone: hand, position: target }], { keep: ['LeftFoot', 'RightFoot'], mode })
  b.scene.updateMatrixWorld(true)
  const miss = wp(b.bones.get(hand)!).distanceTo(target) / b.rig.scale
  const total = b.model.cost(b.rig.encode().p).total
  await poseFromClip(b, id, 0.3)
  const side = hand.replace('Hand', '')
  const ikMiss = reach({ upper: b.bones.get(`${side}Arm`)!, lower: b.bones.get(`${side}ForeArm`)!, end: b.bones.get(hand)! }, target, { limits: b.limits, nameOf }) / b.rig.scale
  b.scene.updateMatrixWorld(true)
  return { miss, ms: res.ms, total, ikTotal: b.model.cost(b.rig.encode().p).total, ikMiss, startTotal: res.startCost.total }
}

const GOALS: number[][] = [[0.2, 0, 0.15], [-0.1, 0.1, 0.3], [0, -0.15, 0.25], [0.15, 0.2, 0.1], [0.25, -0.1, 0.1], [-0.2, 0, 0.2]]

describe.skipIf(!have)('reaching a hand goal', () => {
  it('puts a hand 20-30 cm away within 1 cm, more naturally than two-bone IK, within the time budgets', async () => {
    const b = await body(YBOT, false)
    const full: Reach[] = []; const quick: Reach[] = []
    for (const id of IDLES) for (const hand of ['LeftHand', 'RightHand']) for (const d of GOALS) {
      full.push(await reachCase(b, id, hand, d, 'full'))
      quick.push(await reachCase(b, id, hand, d, 'quick'))
    }
    // plain IK where it reaches (limits and all), against the solver on the same goals
    const both = full.filter(r => r.ikMiss < 0.02)
    const wins = both.filter(r => r.total < r.ikTotal).length
    console.log(`${full.length} goals: full miss median ${(median(full.map(r => r.miss)) * 100).toFixed(2)} cm, worst ${(Math.max(...full.map(r => r.miss)) * 100).toFixed(2)} cm; quick median ${(median(quick.map(r => r.miss)) * 100).toFixed(2)} cm, worst ${(Math.max(...quick.map(r => r.miss)) * 100).toFixed(2)} cm`)
    console.log(`time: full median ${median(full.map(r => r.ms)).toFixed(1)} ms (worst ${Math.max(...full.map(r => r.ms)).toFixed(1)}), quick median ${median(quick.map(r => r.ms)).toFixed(1)} ms (worst ${Math.max(...quick.map(r => r.ms)).toFixed(1)})`)
    console.log(`plain IK missed by over 2 cm in ${full.length - both.length} of ${full.length} (median miss ${(median(full.map(r => r.ikMiss)) * 100).toFixed(1)} cm)`)
    console.log(`where IK reached (${both.length}): Mahalanobis^2 + outside, start ${mean(both.map(r => r.startTotal)).toFixed(1)}, solver ${mean(both.map(r => r.total)).toFixed(1)}, IK ${mean(both.map(r => r.ikTotal)).toFixed(1)}; the solver more natural in ${wins}`)
    console.log(`over all goals: solver ${mean(full.map(r => r.total)).toFixed(1)}, IK ${mean(full.map(r => r.ikTotal)).toFixed(1)}`)
    for (const r of full) expect(r.miss).toBeLessThan(0.01)
    for (const r of quick) expect(r.miss).toBeLessThan(0.01)
    expect(both.length).toBeGreaterThanOrEqual(8)
    expect(mean(both.map(r => r.total))).toBeLessThan(mean(both.map(r => r.ikTotal)))
    expect(wins / both.length).toBeGreaterThan(0.8)
    expect(mean(full.map(r => r.total))).toBeLessThan(mean(full.map(r => r.ikTotal)))
    // (a little slack on the clock: a loaded machine)
    expect(median(quick.map(r => r.ms))).toBeLessThan(30)
    expect(median(full.map(r => r.ms))).toBeLessThan(150)
  })

  it('does the same on a character with its own proportions', { skip: !haveCharacter }, async () => {
    const b = await body(CHARACTER, true)
    const rs: Reach[] = []
    for (const hand of ['LeftHand', 'RightHand']) for (const d of GOALS.slice(0, 4)) rs.push(await reachCase(b, 'mixamo-Breathing_Idle', hand, d, 'full'))
    console.log(`character (scale ${b.rig.scale.toFixed(2)}): miss worst ${(Math.max(...rs.map(r => r.miss)) * 100).toFixed(2)} cm of the Y Bot's size, solver ${mean(rs.map(r => r.total)).toFixed(1)}, IK ${mean(rs.map(r => r.ikTotal)).toFixed(1)}, ${median(rs.map(r => r.ms)).toFixed(1)} ms`)
    for (const r of rs) expect(r.miss).toBeLessThan(0.01)
    expect(mean(rs.map(r => r.total))).toBeLessThan(mean(rs.map(r => r.ikTotal)))
  })

  it('keeps the feet and a held bone where they were', async () => {
    const b = await body(YBOT, false)
    await poseFromClip(b, 'mixamo-Breathing_Idle', 0.3)
    const keep = ['LeftFoot', 'RightFoot', 'RightHand']
    const before = keep.map(n => [wp(b.bones.get(n)!), wq(b.bones.get(n)!)] as const)
    const target = wp(b.bones.get('LeftHand')!).add(new THREE.Vector3(0.1, 0.1, 0.3))
    const res = b.rig.solve([{ bone: 'LeftHand', position: target }], { keep, mode: 'full' })
    b.scene.updateMatrixWorld(true)
    keep.forEach((n, i) => {
      expect(wp(b.bones.get(n)!).distanceTo(before[i][0]), n).toBeLessThan(0.002)
      expect(THREE.MathUtils.radToDeg(wq(b.bones.get(n)!).angleTo(before[i][1])), n).toBeLessThan(2)
    })
    expect(res.keepMiss).toBeLessThan(0.002)
    for (let i = 1; i < NB; i++) if (b.limits.has(BODY[i])) expect(b.limits.within(BODY[i], b.bones.get(BODY[i])!.quaternion), BODY[i]).toBe(true)
  })
})

describe.skipIf(!have)('both hands on a shaft', () => {
  it('reaches both fists and turns the chest toward the shaft, against twohand.ts', async () => {
    const b = await body(YBOT, false)
    const ybotRest = (await load(YBOT)).scene
    ybotRest.updateMatrixWorld(true)
    const rest = captureRest(ybotRest, isBone)
    const grip = { Left: handGrip(rest, 'Left')!, Right: handGrip(rest, 'Right')! }
    const bone = (n: string): THREE.Bone => b.bones.get(n)!
    const fist = (s: 'Left' | 'Right'): THREE.Vector3 => grip[s].fist.clone().applyQuaternion(wq(bone(`${s}Hand`))).add(wp(bone(`${s}Hand`)))
    const axis = (s: 'Left' | 'Right'): THREE.Vector3 => grip[s].axis.clone().applyQuaternion(wq(bone(`${s}Hand`))).normalize()
    const shoulders = (): number => { const d = wp(bone('LeftArm')).sub(wp(bone('RightArm'))); return THREE.MathUtils.radToDeg(Math.atan2(d.z, d.x)) }
    const arm = (s: string): { upper: THREE.Bone, lower: THREE.Bone, end: THREE.Bone } => ({ upper: bone(`${s}Arm`), lower: bone(`${s}ForeArm`), end: bone(`${s}Hand`) })
    const rows: Array<Record<string, number>> = []
    for (const id of ['mixamo-Breathing_Idle', 'mixamo-Box_Idle']) {
      for (const angle of [35, 50, 65, 80]) {
        await poseFromClip(b, id, 0.3)
        // the shaft: horizontal, at `angle` from the line across the shoulders, forward on the left; the right fist on it, in front of the chest
        const d = new THREE.Vector3(Math.cos(THREE.MathUtils.degToRad(angle)), 0, Math.sin(THREE.MathUtils.degToRad(angle)))
        const chest = wp(bone('Spine2'))
        const pr = new THREE.Vector3(wp(bone('RightArm')).x + 0.06, chest.y - 0.12, 0.32)
        reach(arm('Right'), pr.clone().sub(grip.Right.fist.clone().applyQuaternion(wq(bone('RightHand')))), { limits: b.limits, nameOf })
        setWorldQuaternion(bone('RightHand'), new THREE.Quaternion().setFromUnitVectors(axis('Right'), d).multiply(wq(bone('RightHand'))))
        reach(arm('Right'), pr.clone().sub(grip.Right.fist.clone().applyQuaternion(wq(bone('RightHand')))), { limits: b.limits, nameOf, keepEnd: true, endFree: true })
        b.scene.updateMatrixWorld(true)
        const right = fist('Right'); const shaft = axis('Right')
        const target = right.clone().addScaledVector(shaft, 0.35)
        const start = b.rig.encode()
        const startYaw = shoulders()
        const snap = BODY.map(n => [bone(n), bone(n).quaternion.clone(), bone(n).position.clone()] as const)
        const restore = (): void => { for (const [x, q, p] of snap) { x.quaternion.copy(q); x.position.copy(p) } b.scene.updateMatrixWorld(true) }
        const axisOff = (): number => { const a = axis('Left').angleTo(shaft); return THREE.MathUtils.radToDeg(Math.min(a, Math.PI - a)) }
        const startMiss = fist('Left').distanceTo(target)

        // twohand.ts: the right hand carries the spear, the left fist goes on the shaft
        const carrier = bone('RightHand')
        const inv = carrier.matrixWorld.clone().invert()
        const locked = new THREE.Quaternion().setFromUnitVectors(axis('Left'), shaft).multiply(wq(bone('LeftHand')))
        const hold: TwoHandHold = {
          hand: 'Left', bone: 'RightHand',
          fist: target.clone().applyMatrix4(inv).toArray() as [number, number, number],
          shaft: shaft.clone().transformDirection(inv).toArray() as [number, number, number],
          turn: wq(carrier).invert().multiply(locked).toArray() as [number, number, number, number],
          fistOffset: grip.Left.fist.toArray() as [number, number, number],
        }
        const t0 = performance.now()
        baseline?.(b.bones, hold, { limits: b.limits, nameOf, legs: b.legs }, null)
        const oldMs = performance.now() - t0
        b.scene.updateMatrixWorld(true)
        const old = baseline === null ? null : { miss: fist('Left').distanceTo(target), carrier: fist('Right').distanceTo(right), axis: axisOff(), yaw: shoulders(), total: b.model.cost(b.rig.encode().p).total, ms: oldMs }
        restore()

        // the natural solver: the right hand kept, the left fist at the point with its grip along the shaft
        const res = b.rig.solve([{ bone: 'LeftHand', at: grip.Left.fist, position: target, axis: { local: grip.Left.axis, world: shaft, either: true } }],
          { keep: ['LeftFoot', 'RightFoot', 'RightHand'], mode: 'full' })
        b.scene.updateMatrixWorld(true)
        const now = { miss: fist('Left').distanceTo(target), carrier: fist('Right').distanceTo(right), axis: axisOff(), yaw: shoulders(), total: res.cost.total, ms: res.ms }
        const feet = b.legs.map(l => wp(l.end))
        restore()
        rows.push({ startMiss, startYaw, startTotal: start.p.length > 0 ? b.model.cost(start.p).total : 0, shaftYaw: angle, oldMiss: old?.miss ?? NaN, oldCarrier: old?.carrier ?? NaN, oldAxis: old?.axis ?? NaN, oldYaw: old?.yaw ?? NaN, oldTotal: old?.total ?? NaN, oldMs: old?.ms ?? NaN, newMiss: now.miss, newCarrier: now.carrier, newAxis: now.axis, newYaw: now.yaw, newTotal: now.total, newMs: now.ms, feet: feet.length })
      }
    }
    const f = (x: number): string => x.toFixed(2)
    for (const r of rows) {
      console.log(`shaft ${r.shaftYaw} deg (start: left fist ${f(r.startMiss * 100)} cm off, shoulders ${f(r.startYaw)} deg): twohand.ts miss ${f(r.oldMiss * 100)} cm, carrier ${f(r.oldCarrier * 100)} cm, shoulders ${f(r.oldYaw)} deg, cost ${f(r.oldTotal)}, ${f(r.oldMs)} ms | natural miss ${f(r.newMiss * 100)} cm, carrier ${f(r.newCarrier * 100)} cm, grip ${f(r.newAxis)} deg off, shoulders ${f(r.newYaw)} deg, cost ${f(r.newTotal)}, ${f(r.newMs)} ms`)
    }
    for (const r of rows) {
      // both reached
      expect(r.newMiss).toBeLessThan(0.01)
      expect(r.newCarrier).toBeLessThan(0.01)
      expect(r.newAxis).toBeLessThan(3)
      // the shoulder line turns toward the shaft (from where the clip has it) once the grip asks for it, and not past it
      // (a shaft near the line across the shoulders is reached without: the chest need not turn)
      if (r.shaftYaw >= 50) expect(r.newYaw - r.startYaw).toBeGreaterThan(3)
      expect(r.newYaw).toBeLessThan(Math.max(r.shaftYaw, r.startYaw) + 5)
    }
    // against the rule-based turn: as well reached, and more natural (the shoulders' line twisting less for the same grip)
    if (baseline !== null) {
      expect(mean(rows.map(r => r.newMiss))).toBeLessThanOrEqual(mean(rows.map(r => r.oldMiss)) + 0.002)
      expect(mean(rows.map(r => r.newTotal))).toBeLessThan(mean(rows.map(r => r.oldTotal)))
    } else console.log('(src/engine/twohand.ts is gone: nothing to compare with)')
  })
})

describe.skipIf(!have)('the drop-in for solveBody', () => {
  it('takes bodysolve.ts solveBody\'s arguments: hand goals (a wrist place and turn) with the feet soft', async () => {
    const b = await body(YBOT, false)
    const solveNatural = createBodySolver(b.model, null)
    const bone = (n: string): THREE.Bone => b.bones.get(n)!
    const nat: Array<{ miss: number, ms: number, total: number, feet: number, turn: number }> = []
    const old: Array<{ miss: number, ms: number, total: number, feet: number, turn: number }> = []
    for (const id of IDLES) {
      for (const d of GOALS.slice(0, 4)) {
        for (const quick of [false, true]) {
          // the left hand asked 20-30 cm away, turned a little; the right hand where it stands
          const goalsAt = async (): Promise<Array<{ hand: 'Left' | 'Right', at: THREE.Vector3, turn: THREE.Quaternion }>> => {
            await poseFromClip(b, id, 0.3)
            return [
              { hand: 'Left', at: wp(bone('LeftHand')).add(new THREE.Vector3(...d)), turn: wq(bone('LeftHand')).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4)) },
              { hand: 'Right', at: wp(bone('RightHand')), turn: wq(bone('RightHand')) },
            ]
          }
          const run = async (solver: typeof solveBody): Promise<typeof nat[number]> => {
            const goals = await goalsAt()
            const feet = b.legs.map(l => wp(l.end))
            const t0 = performance.now()
            const r = solver(b.bones, goals, { limits: b.limits, nameOf, legs: b.legs, height: 1.7, quick }, null)
            const ms = performance.now() - t0
            b.scene.updateMatrixWorld(true)
            return {
              miss: Math.max(...goals.map(g => wp(bone(`${g.hand}Hand`)).distanceTo(g.at))), ms, total: b.model.cost(b.rig.encode().p).total,
              feet: Math.max(...b.legs.map((l, i) => wp(l.end).distanceTo(feet[i]))),
              turn: Math.max(...goals.map(g => THREE.MathUtils.radToDeg(wq(bone(`${g.hand}Hand`)).angleTo(g.turn)))) + 0 * r.miss,
            }
          }
          if (!quick) { nat.push(await run(solveNatural)); old.push(await run(solveBody)) } else { const n = await run(solveNatural); expect(n.miss).toBeLessThan(0.01) }
        }
      }
    }
    const f = (xs: number[]): string => `${(mean(xs) * 100).toFixed(2)} cm (worst ${(Math.max(...xs) * 100).toFixed(2)})`
    console.log(`solveBody: miss ${f(old.map(r => r.miss))}, ${median(old.map(r => r.ms)).toFixed(1)} ms, cost ${mean(old.map(r => r.total)).toFixed(1)}, feet ${f(old.map(r => r.feet))}`)
    console.log(`natural:   miss ${f(nat.map(r => r.miss))}, ${median(nat.map(r => r.ms)).toFixed(1)} ms, cost ${mean(nat.map(r => r.total)).toFixed(1)}, feet ${f(nat.map(r => r.feet))}`)
    for (const r of nat) {
      expect(r.miss).toBeLessThan(0.01)
      expect(r.feet).toBeLessThan(0.03)
      expect(r.turn).toBeLessThan(1)
    }
    expect(mean(nat.map(r => r.miss))).toBeLessThanOrEqual(mean(old.map(r => r.miss)) + 0.001)
    expect(mean(nat.map(r => r.total))).toBeLessThan(mean(old.map(r => r.total)))
  })
})

const FEET = ['LeftFoot', 'RightFoot']

describe.skipIf(!have)('soft feet', () => {
  it('leaves the feet where they stand for a small reach, and never puts a sole point under the floor', async () => {
    const b = await body(YBOT, false)
    for (const id of IDLES) {
      for (const d of [[0.05, 0, 0.05], [0, 0.1, 0.15], [0.2, 0, 0.15]]) {
        await poseFromClip(b, id, 0.3)
        const target = wp(b.bones.get('LeftHand')!).add(new THREE.Vector3(...d))
        const res = b.rig.solve([{ bone: 'LeftHand', position: target }], { feet: FEET, floor: { y: 0, soles: b.soles }, mode: 'full' })
        b.scene.updateMatrixWorld(true)
        expect(wp(b.bones.get('LeftHand')!).distanceTo(target)).toBeLessThan(0.01)
        expect(res.feetMoved.slide).toBeLessThan(0.01)
        expect(res.feetMoved.twist).toBeLessThan(6)
        expect(res.feetMoved.tilt).toBeLessThan(3)
        for (const [n, h] of Object.entries(b.soles)) expect(wp(b.bones.get(n)!).y - h, n).toBeGreaterThan(-0.001)
      }
    }
  })

  it('lets the feet pivot, tilt or slide when the pose needs it, and is then as natural as planted or more', async () => {
    const b = await body(YBOT, false)
    const rows: Array<{ soft: number, planted: number, slide: number, twist: number, tilt: number, miss: number }> = []
    // a deep reach, a hand almost to the floor, and the far end of a shaft
    const cases: Array<{ id: string, d: number[] }> = [{ id: IDLES[0], d: [0, -0.7, 0.25] }, { id: IDLES[0], d: [0.1, -0.9, 0.4] }, { id: IDLES[1], d: [0.25, -0.2, 0.35] }, { id: IDLES[2], d: [-0.3, -0.5, 0.3] }]
    for (const c of cases) {
      await poseFromClip(b, c.id, 0.3)
      const target = wp(b.bones.get('LeftHand')!).add(new THREE.Vector3(...c.d)); target.y = Math.max(target.y, 0.05)
      // (soft against planted, both without balance: what letting the feet go is worth by itself)
      const soft = b.rig.solve([{ bone: 'LeftHand', position: target }], { feet: FEET, floor: { y: 0, soles: b.soles }, mode: 'full', balance: false })
      b.scene.updateMatrixWorld(true)
      const miss = wp(b.bones.get('LeftHand')!).distanceTo(target)
      for (const [n, h] of Object.entries(b.soles)) expect(wp(b.bones.get(n)!).y - h, n).toBeGreaterThan(-0.001)
      await poseFromClip(b, c.id, 0.3)
      const planted = b.rig.solve([{ bone: 'LeftHand', position: target }], { feet: FEET, planted: true, floor: { y: 0, soles: b.soles }, mode: 'full' })
      b.scene.updateMatrixWorld(true)
      // (planted: the old behaviour, the feet exactly where they were)
      expect(planted.feetMoved.slide).toBe(0)
      rows.push({ soft: soft.cost.total, planted: planted.cost.total, slide: soft.feetMoved.slide, twist: soft.feetMoved.twist, tilt: soft.feetMoved.tilt, miss })
    }
    console.log(rows.map(r => `miss ${(r.miss * 100).toFixed(2)} cm, feet slide ${(r.slide * 100).toFixed(1)} cm twist ${r.twist.toFixed(1)} tilt ${r.tilt.toFixed(1)} deg, cost soft ${r.soft.toFixed(1)} planted ${r.planted.toFixed(1)}`).join('\n'))
    for (const r of rows) {
      expect(r.miss).toBeLessThan(0.01)
      expect(r.soft).toBeLessThan(r.planted + 1)
      // (they move, not past a stride)
      expect(r.slide).toBeLessThan(0.5)
    }
    expect(mean(rows.map(r => r.soft))).toBeLessThan(mean(rows.map(r => r.planted)))
    expect(Math.max(...rows.map(r => r.twist))).toBeGreaterThan(1)
  })

  it('keeps the old behaviour with planted: the feet where they were, to the millimetre', async () => {
    const b = await body(YBOT, false)
    await poseFromClip(b, IDLES[0], 0.3)
    const before = FEET.map(n => [wp(b.bones.get(n)!), wq(b.bones.get(n)!)] as const)
    const res = b.rig.solve([{ bone: 'LeftHand', position: wp(b.bones.get('LeftHand')!).add(new THREE.Vector3(0.1, 0.1, 0.3)) }], { feet: FEET, planted: true, mode: 'full' })
    b.scene.updateMatrixWorld(true)
    FEET.forEach((n, i) => {
      expect(wp(b.bones.get(n)!).distanceTo(before[i][0]), n).toBeLessThan(0.002)
      expect(THREE.MathUtils.radToDeg(wq(b.bones.get(n)!).angleTo(before[i][1])), n).toBeLessThan(2)
    })
    expect(res.keepMiss).toBeLessThan(0.002)
  })

  it('the drop-in: soft feet by default, planted on request, the hips free to lunge and drop', async () => {
    const b = await body(YBOT, false)
    const bone = (n: string): THREE.Bone => b.bones.get(n)!
    const soles = b.legs.map(l => [l.end, l.ball, l.tip].map(x => (x === null ? -Infinity : wp(x).y)))
    const goalsFar = async (ahead: number): Promise<Array<{ hand: 'Left' | 'Right', at: THREE.Vector3, turn: THREE.Quaternion }>> => {
      await poseFromClip(b, IDLES[0], 0.3)
      // a prop that leads: both hands `ahead` further forward than the stance reaches, a little lower
      return (['Left', 'Right'] as const).map(hand => ({ hand, at: wp(bone(`${hand}Hand`)).add(new THREE.Vector3(0, -0.12, ahead)), turn: wq(bone(`${hand}Hand`)) }))
    }
    const run = async (ahead: number, options: { hipsMove?: boolean, planted?: boolean }): Promise<{ miss: number, hipsFwd: number, hipsDown: number, feet: number, under: number, cost: number }> => {
      const solver = createBodySolver(b.model, null, options)
      const goals = await goalsFar(ahead)
      const hips0 = wp(bone('Hips')); const feet0 = b.legs.map(l => wp(l.end))
      const r = solver(b.bones, goals, { limits: b.limits, nameOf, legs: b.legs, height: 1.7, floor: 0, soles }, null)
      b.scene.updateMatrixWorld(true)
      return {
        miss: r.miss, cost: b.model.cost(b.rig.encode().p).total, hipsFwd: wp(bone('Hips')).z - hips0.z, hipsDown: hips0.y - wp(bone('Hips')).y, feet: Math.max(...b.legs.map((l, i) => wp(l.end).distanceTo(feet0[i]))),
        under: Math.max(0, ...b.legs.flatMap((l, i) => [l.end, l.ball, l.tip].map((x, k) => (x === null ? 0 : soles[i][k] - wp(x).y)))),
      }
    }
    for (const ahead of [0.25, 0.45, 0.6, 0.7]) {
      const fixed = await run(ahead, { hipsMove: false })
      const moving = await run(ahead, {})
      const planted = await run(ahead, { planted: true })
      console.log(`prop leading ${ahead * 100} cm: hips fixed miss ${(fixed.miss * 100).toFixed(1)} cm; hips free miss ${(moving.miss * 100).toFixed(2)} cm (hips ${(moving.hipsFwd * 100).toFixed(1)} cm forward, ${(moving.hipsDown * 100).toFixed(1)} down, feet moved ${(moving.feet * 100).toFixed(1)} cm); naturalness cost hips free ${moving.cost.toFixed(1)} vs fixed ${fixed.cost.toFixed(1)}; planted (hips free) miss ${(planted.miss * 100).toFixed(1)} cm (feet moved ${(planted.feet * 100).toFixed(2)} cm)`)
      // (balance and upright stop the body bending over to reach: it lowers into a lunge, hips forward and down, a foot stepping; with the hips held it cannot reach so far)
      if (ahead <= 0.6) expect(moving.miss).toBeLessThan(0.01)
      expect(moving.miss).toBeLessThanOrEqual(fixed.miss + 1e-3)
      expect(moving.under).toBeLessThan(0.001)
      expect(planted.feet).toBeLessThan(0.002)
      expect(fixed.hipsFwd).toBeLessThan(0.001)
      expect(moving.cost).toBeLessThanOrEqual(fixed.cost + 0.5)
      if (ahead >= 0.45) expect(moving.hipsFwd).toBeGreaterThan(0.05)
    }
  })

  it('is quick enough for a live drag with the feet soft', async () => {
    const b = await body(YBOT, false)
    const ms: number[] = []; const misses: number[] = []
    for (const id of IDLES) for (const d of GOALS) {
      await poseFromClip(b, id, 0.3)
      const target = wp(b.bones.get('RightHand')!).add(new THREE.Vector3(...d))
      const res = b.rig.solve([{ bone: 'RightHand', position: target }], { feet: FEET, floor: { y: 0, soles: b.soles }, mode: 'quick' })
      b.scene.updateMatrixWorld(true)
      ms.push(res.ms); misses.push(wp(b.bones.get('RightHand')!).distanceTo(target))
    }
    console.log(`quick, soft feet: median ${median(ms).toFixed(1)} ms (worst ${Math.max(...ms).toFixed(1)}), miss median ${(median(misses) * 100).toFixed(2)} cm worst ${(Math.max(...misses) * 100).toFixed(2)} cm`)
    expect(median(ms)).toBeLessThan(30)
    expect(Math.max(...misses)).toBeLessThan(0.015)
  })
})

/** A clip of the first `n` frames of a library clip played on `b`, its hands asked somewhere else, baked by plain two-bone IK: the edit a naturalize pass starts from. */
async function editedClip (b: Body, id: string, n: number, move: (t: number) => { left: THREE.Vector3, right: THREE.Vector3 }): Promise<{
  clip: THREE.AnimationClip, targets: Array<{ left: THREE.Vector3, right: THREE.Vector3, leftTurn: THREE.Quaternion, rightTurn: THREE.Quaternion }>, q: Float32Array[]
}> {
  const lib = await load(path.join(LIBRARY, 'clips', `${id}.glb`))
  const base = lib.animations[0]
  const mixer = new THREE.AnimationMixer(b.scene)
  const times = Array.from({ length: n }, (_, i) => i / 30)
  const targets: Array<{ left: THREE.Vector3, right: THREE.Vector3, leftTurn: THREE.Quaternion, rightTurn: THREE.Quaternion }> = []
  const q: Float32Array[] = []
  const hips: number[] = []
  for (const t of times) {
    mixer.stopAllAction(); const a = mixer.clipAction(base); a.reset(); a.play(); mixer.setTime(t)
    b.scene.updateMatrixWorld(true)
    const m = move(t)
    const ls = b.bones.get('LeftHand')!; const rs = b.bones.get('RightHand')!
    const goal = { left: wp(ls).add(m.left), right: wp(rs).add(m.right), leftTurn: wq(ls), rightTurn: wq(rs) }
    targets.push(goal)
    for (const [side, at, turn] of [['Left', goal.left, goal.leftTurn], ['Right', goal.right, goal.rightTurn]] as const) {
      const arm = { upper: b.bones.get(`${side}Arm`)!, lower: b.bones.get(`${side}ForeArm`)!, end: b.bones.get(`${side}Hand`)! }
      reach(arm, at, { limits: b.limits, nameOf, keepEnd: false })
      setWorldQuaternion(arm.end, turn)
    }
    const f = new Float32Array(NB * 4)
    BODY.forEach((n2, j) => { b.bones.get(n2)!.quaternion.toArray(f, j * 4) })
    q.push(f)
    hips.push(...b.bones.get('Hips')!.position.toArray())
  }
  mixer.stopAllAction(); mixer.uncacheRoot(b.scene)
  const tracks = base.tracks.filter(tr => !BODY.some(n2 => tr.name === `${n2}.quaternion`) && tr.name !== 'Hips.position')
  BODY.forEach((n2, j) => {
    const v = new Float32Array(times.length * 4)
    q.forEach((f, i) => v.set(f.subarray(j * 4, j * 4 + 4), i * 4))
    tracks.push(new THREE.QuaternionKeyframeTrack(`${n2}.quaternion`, times, v))
  })
  tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, hips))
  return { clip: new THREE.AnimationClip('edited', (n - 1) / 30, tracks), targets, q }
}

describe.skipIf(!have)('naturalizing a whole clip', () => {
  it('meets the hands on every frame, smooths the corrections, holds the floor and beats the plain edit', async () => {
    const b = await body(YBOT, false)
    const N = 40
    // the edit: both hands carried on a prop that swings 20 cm out and across, and leads 20 cm forward
    const edit = await editedClip(b, IDLES[0], N, t => ({
      left: new THREE.Vector3(0.1 * Math.sin(t * 4), 0.06 * Math.sin(t * 3) + 0.04, 0.2 + 0.08 * Math.cos(t * 4)),
      right: new THREE.Vector3(0.1 * Math.sin(t * 4), 0.06 * Math.sin(t * 3) + 0.04, 0.2 + 0.08 * Math.cos(t * 4)),
    }))
    const goals = (i: number): NaturalGoal[] => [
      { bone: 'LeftHand', position: edit.targets[i].left, turn: edit.targets[i].leftTurn, exact: true },
      { bone: 'RightHand', position: edit.targets[i].right, turn: edit.targets[i].rightTurn, exact: true },
    ]
    const common = { feet: FEET, floor: { y: 0, soles: b.soles }, goals: (i: number) => goals(i) }
    // the plain edit: its hand misses and how natural it is (the clip as baked, every frame)
    const mixer = new THREE.AnimationMixer(b.scene)
    const plain: Array<{ miss: number, total: number }> = []
    for (let i = 0; i < N; i++) {
      mixer.stopAllAction(); const a = mixer.clipAction(edit.clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.reset(); a.play(); mixer.setTime(i / 30)
      b.scene.updateMatrixWorld(true)
      plain.push({ miss: Math.max(wp(b.bones.get('LeftHand')!).distanceTo(edit.targets[i].left), wp(b.bones.get('RightHand')!).distanceTo(edit.targets[i].right)), total: b.model.cost(b.rig.encode().p).total })
    }
    mixer.stopAllAction(); mixer.uncacheRoot(b.scene)
    // the pass (sweeps and smoothing), against every frame on its own
    const t0 = performance.now()
    const smooth = naturalizeClip(b.rig, edit.clip, { ...common, fps: 30, smooth: 40, sweeps: 2 })
    const msFrame = (performance.now() - t0) / (smooth.frames.length * 2)
    const solo = naturalizeClip(b.rig, edit.clip, { ...common, fps: 30, smooth: 0, sweeps: 1 })
    const stiff = naturalizeClip(b.rig, edit.clip, { ...common, fps: 30, smooth: 400, sweeps: 2 })
    expect(smooth.frames.length).toBe(N)
    // the jitter of a correction: how much it changes from one frame to the next (the edit's own motion left out)
    const jitter = (frames: Array<{ q: Float32Array }>): number => {
      let total = 0; let count = 0
      for (let i = 0; i + 1 < frames.length; i++) {
        for (let j = 0; j < NB; j++) {
          const corr = (k: number): THREE.Quaternion => new THREE.Quaternion().fromArray(edit.q[k], j * 4).invert().multiply(new THREE.Quaternion().fromArray(frames[k].q, j * 4))
          total += THREE.MathUtils.radToDeg(corr(i).angleTo(corr(i + 1))); count++
        }
      }
      return total / count
    }
    // how much the pose changes from frame to frame (what plays): the edit's own against the result's (a plain edit's arms flip at their limits)
    const motion = (frames: Array<{ q: Float32Array }>): number => {
      let total = 0; let count = 0
      for (let i = 0; i + 1 < frames.length; i++) for (let j = 0; j < NB; j++) { total += THREE.MathUtils.radToDeg(new THREE.Quaternion().fromArray(frames[i].q, j * 4).angleTo(new THREE.Quaternion().fromArray(frames[i + 1].q, j * 4))); count++ }
      return total / count
    }
    const editMotion = motion(edit.q.map(q => ({ q })))
    const feetSlide = Math.max(...smooth.frames.map(f => f.feetMoved.slide))
    console.log(`plain IK edit: hand miss mean ${(mean(plain.map(r => r.miss)) * 100).toFixed(1)} cm worst ${(Math.max(...plain.map(r => r.miss)) * 100).toFixed(1)} cm, cost ${mean(plain.map(r => r.total)).toFixed(1)}`)
    console.log(`naturalized (2 sweeps, smooth 40): miss mean ${(mean(smooth.misses) * 100).toFixed(3)} cm worst ${(Math.max(...smooth.misses) * 100).toFixed(3)} cm, cost ${mean(smooth.frames.map(f => f.cost.total)).toFixed(1)}, correction jitter ${jitter(smooth.frames).toFixed(2)} deg/frame, feet slide worst ${(feetSlide * 100).toFixed(1)} cm, floor miss worst ${(Math.max(...smooth.frames.map(f => f.floorMiss)) * 1000).toFixed(2)} mm, ${msFrame.toFixed(1)} ms per frame-solve`)
    console.log(`pose motion per frame: edit ${editMotion.toFixed(2)} deg, naturalized ${motion(smooth.frames).toFixed(2)} deg, each frame alone ${motion(solo.frames).toFixed(2)} deg`)
    console.log(`each frame alone: miss worst ${(Math.max(...solo.misses) * 100).toFixed(3)} cm, cost ${mean(solo.frames.map(f => f.cost.total)).toFixed(1)}, correction jitter ${jitter(solo.frames).toFixed(2)} deg/frame`)
    console.log(`correction jitter by smoothing weight: none ${jitter(solo.frames).toFixed(3)}, 40 ${jitter(smooth.frames).toFixed(3)}, 400 ${jitter(stiff.frames).toFixed(3)} deg/frame (worst hand miss at 400: ${(Math.max(...stiff.misses) * 100).toFixed(3)} cm)`)
    expect(jitter(stiff.frames)).toBeLessThan(jitter(smooth.frames))
    expect(Math.max(...stiff.misses)).toBeLessThan(0.01)
    for (const f of smooth.frames) {
      expect(f.miss).toBeLessThan(0.01)
      expect(f.floorMiss).toBeLessThan(0.001)
    }
    expect(jitter(smooth.frames)).toBeLessThan(jitter(solo.frames))
    expect(mean(smooth.frames.map(f => f.cost.total))).toBeLessThan(mean(plain.map(r => r.total)))
    expect(msFrame).toBeLessThan(150)
    // the new clip plays: the hands are where the frames say, on the character, between the frames' own values too
    const mixer2 = new THREE.AnimationMixer(b.scene)
    for (const i of [0, 13, N - 1]) {
      mixer2.stopAllAction(); const a = mixer2.clipAction(smooth.clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.reset(); a.play(); mixer2.setTime(i / 30)
      b.scene.updateMatrixWorld(true)
      expect(wp(b.bones.get('LeftHand')!).distanceTo(edit.targets[i].left)).toBeLessThan(0.012)
      expect(wp(b.bones.get('RightHand')!).distanceTo(edit.targets[i].right)).toBeLessThan(0.012)
    }
    mixer2.stopAllAction(); mixer2.uncacheRoot(b.scene)
    expect(smooth.clip.tracks.some(tr => tr.name === 'Hips.position')).toBe(true)
  })

  it('drifts toward the most natural pose when asked (pull), the hands still met', async () => {
    const b = await body(YBOT, false)
    const edit = await editedClip(b, IDLES[2], 24, t => ({ left: new THREE.Vector3(0.05, 0.05, 0.2 + t * 0.2), right: new THREE.Vector3(0.05, 0.05, 0.2 + t * 0.2) }))
    const goals = (i: number): NaturalGoal[] => [
      { bone: 'LeftHand', position: edit.targets[i].left, turn: edit.targets[i].leftTurn, exact: true },
      { bone: 'RightHand', position: edit.targets[i].right, turn: edit.targets[i].rightTurn, exact: true },
    ]
    const run = (pull: number): { cost: number, miss: number, away: number } => {
      const r = naturalizeClip(b.rig, edit.clip, { goals: i => goals(i), feet: FEET, floor: { y: 0, soles: b.soles }, sweeps: 1, pull })
      // (how far the pose moved from the edit's, on average over the bones)
      const away = mean(r.frames.map((f, i) => mean(Array.from({ length: NB }, (_, j) => THREE.MathUtils.radToDeg(new THREE.Quaternion().fromArray(f.q, j * 4).angleTo(new THREE.Quaternion().fromArray(edit.q[i], j * 4)))))))
      return { cost: mean(r.frames.map(f => f.cost.total)), miss: Math.max(...r.misses), away }
    }
    const none = run(0); const some = run(0.5)
    console.log(`pull 0: cost ${none.cost.toFixed(1)}, ${none.away.toFixed(2)} deg from the edit; pull 0.5: cost ${some.cost.toFixed(1)}, ${some.away.toFixed(2)} deg from the edit; worst hand miss ${(some.miss * 100).toFixed(3)} cm`)
    expect(some.cost).toBeLessThan(none.cost)
    expect(some.miss).toBeLessThan(0.01)
    expect(some.away).toBeGreaterThan(none.away)
  })

  it('pulls keyed bones toward their edited turns at their weight', async () => {
    const b = await body(YBOT, false)
    const edit = await editedClip(b, IDLES[1], 12, t => ({ left: new THREE.Vector3(0.05, 0.05, 0.2 + t * 0.2), right: new THREE.Vector3(0, 0, 0) }))
    const mixer = new THREE.AnimationMixer(b.scene)
    const pose = (i: number): void => { mixer.stopAllAction(); const a = mixer.clipAction(edit.clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.reset(); a.play(); mixer.setTime(i / 30); b.scene.updateMatrixWorld(true) }
    const headTurn = (frames: Array<{ q: Float32Array }>, i: number): number => {
      const j = BODY.indexOf('Head')
      return THREE.MathUtils.radToDeg(new THREE.Quaternion().fromArray(frames[i].q, j * 4).angleTo(new THREE.Quaternion().fromArray(edit.q[i], j * 4)))
    }
    const run = (weight: number): number => {
      const frames = naturalizeFrames(b.rig, {
        frames: 12, pose, feet: FEET, floor: { y: 0, soles: b.soles }, sweeps: 1,
        goals: i => [{ bone: 'LeftHand', position: edit.targets[i].left, turn: edit.targets[i].leftTurn, exact: true }, ...(weight > 0 ? poseTargets(b.rig, ['Head', 'Spine2'], { weight, position: false }) : [])],
      })
      return mean(frames.map((_, i) => headTurn(frames, i)))
    }
    const free = run(0); const held = run(4)
    console.log(`the head moves ${free.toFixed(2)} deg from the edit when free, ${held.toFixed(2)} deg when keyed at weight 4`)
    expect(held).toBeLessThanOrEqual(free + 0.01)
    expect(held).toBeLessThan(2)
    mixer.stopAllAction(); mixer.uncacheRoot(b.scene)
  })
})

/** The body's centre of mass (segment middles, mass-weighted) and the signed distance of its ground point from the hull of the feet's sole points (positive outside), measured on the bones with nothing of the solver's. */
function balanceOnBones (b: Body, feet: string[]): { margin: number, tiltDeg: number, pitchDeg: number } {
  const bone = (n: string): THREE.Vector3 => wp(b.bones.get(n)!)
  const parts: Array<[string, string | null, number]> = [['Hips', 'Spine', 0.14], ['Spine', 'Spine1', 0.11], ['Spine1', 'Spine2', 0.11], ['Spine2', 'Neck', 0.14], ['Neck', 'Head', 0.02], ['Head', null, 0.07]]
  for (const s of ['Left', 'Right']) parts.push([`${s}Arm`, `${s}ForeArm`, 0.028], [`${s}ForeArm`, `${s}Hand`, 0.016], [`${s}Hand`, null, 0.007], [`${s}UpLeg`, `${s}Leg`, 0.10], [`${s}Leg`, `${s}Foot`, 0.047], [`${s}Foot`, `${s}ToeBase`, 0.014])
  const com = new THREE.Vector3(); let total = 0
  for (const [a, c, m] of parts) { com.addScaledVector(c === null ? bone(a) : bone(a).add(bone(c)).multiplyScalar(0.5), m); total += m }
  com.divideScalar(total)
  // the hull of the sole points (ankle, ball, tip of each standing foot), by Andrew's monotone chain
  const pts: Array<[number, number]> = []
  for (const f of feet) for (const n of [f, f.replace('Foot', 'ToeBase'), f.replace('Foot', 'Toe_End')]) { const p = bone(n); pts.push([p.x, p.z]) }
  pts.sort((u, v) => u[0] - v[0] || u[1] - v[1])
  const cross = (o: number[], a: number[], c: number[]): number => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0])
  const chain = (list: Array<[number, number]>): Array<[number, number]> => { const h: Array<[number, number]> = []; for (const p of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p) } h.pop(); return h }
  const hull = [...chain(pts), ...chain([...pts].reverse())]
  let inside = true; let near = Infinity; let depth = Infinity
  hull.forEach((a, i) => {
    const c = hull[(i + 1) % hull.length]
    const e = [c[0] - a[0], c[1] - a[1]]; const len = Math.hypot(e[0], e[1])
    const t = Math.max(0, Math.min(1, ((com.x - a[0]) * e[0] + (com.z - a[1]) * e[1]) / (len * len)))
    near = Math.min(near, Math.hypot(com.x - a[0] - t * e[0], com.z - a[1] - t * e[1]))
    const side = (e[0] * (com.z - a[1]) - e[1] * (com.x - a[0])) / len
    if (side < 0) inside = false
    depth = Math.min(depth, side)
  })
  const trunk = bone('Neck').sub(bone('Hips'))
  return { margin: inside ? depth : -near, tiltDeg: THREE.MathUtils.radToDeg(Math.atan2(Math.hypot(trunk.x, trunk.z), trunk.y)), pitchDeg: THREE.MathUtils.radToDeg(Math.atan2(trunk.z, trunk.y)) }
}

describe.skipIf(!haveCharacter || !existsSync(path.join(LIBRARY, 'clips', 'custom-Spear_Thrust.glb')))('balance: the spearman\'s thrust with the spear keyed 25 cm further forward', () => {
  it('lunges (hips forward and down, a foot stepping, flat) instead of folding over the spear: upright, balanced, the hands met', async () => {
    const b = await body(CHARACTER, true)
    const duration = (await load(path.join(LIBRARY, 'clips', 'custom-Spear_Thrust.glb'))).animations[0].duration
    const rows: string[] = []
    for (const u of [0.3, 0.4, 0.5]) {
      const goalsAt = async (): Promise<NaturalGoal[]> => {
        await poseFromClip(b, 'custom-Spear_Thrust', u * duration)
        // (both hands on the spear: it leads 25 cm further forward than the clip's thrust)
        return ['LeftHand', 'RightHand'].map(bone => ({ bone, position: wp(b.bones.get(bone)!).add(new THREE.Vector3(0, 0, 0.25)), turn: wq(b.bones.get(bone)!), exact: true }))
      }
      const run = async (balance: boolean): Promise<{ tilt: number, pitch: number, margin: number, miss: number, turn: number, lift: number, footTilt: number, slide: number, hipsFwd: number, hipsDown: number, ms: number, under: number }> => {
        const goals = await goalsAt()
        const hips0 = wp(b.bones.get('Hips')!)
        const res = b.rig.solve(goals, { feet: FEET, floor: { y: 0, soles: b.soles }, mode: 'full', balance })
        b.scene.updateMatrixWorld(true)
        const m = balanceOnBones(b, FEET)
        const hips1 = wp(b.bones.get('Hips')!)
        return {
          tilt: m.tiltDeg, pitch: m.pitchDeg, margin: m.margin, miss: Math.max(...goals.map(g => wp(b.bones.get(g.bone)!).distanceTo(g.position!))), turn: res.turnMiss,
          lift: res.feetMoved.lift, footTilt: res.feetMoved.tilt, slide: res.feetMoved.slide, hipsFwd: hips1.z - hips0.z, hipsDown: hips0.y - hips1.y, ms: res.ms, under: res.floorMiss,
        }
      }
      await goalsAt()
      const start = balanceOnBones(b, FEET)
      const before = await run(false)
      const after = await run(true)
      const cm = (x: number): string => (x * 100).toFixed(1)
      rows.push(`u=${u}: clip pose: trunk ${start.tiltDeg.toFixed(1)} deg, COM ${cm(start.margin)} cm inside | without balance: trunk ${before.tilt.toFixed(1)} deg (pitch ${before.pitch.toFixed(1)}), COM margin ${cm(before.margin)} cm, feet lifted ${cm(before.lift)} cm tilted ${before.footTilt.toFixed(0)} deg | with: trunk ${after.tilt.toFixed(1)} deg (pitch ${after.pitch.toFixed(1)}), COM margin ${cm(after.margin)} cm, hands off ${cm(after.miss)} cm (turn ${after.turn.toFixed(2)} deg), hips ${cm(after.hipsFwd)} cm forward ${cm(after.hipsDown)} down, feet slid ${cm(after.slide)} cm, lifted ${cm(after.lift)} cm, tilted ${after.footTilt.toFixed(1)} deg, ${after.ms.toFixed(0)} ms`)
      // the hands met, the body upright (within 35 degrees) and over its feet, the feet flat and on the floor
      expect(after.miss).toBeLessThan(0.01)
      expect(after.turn).toBeLessThan(1)
      expect(after.tilt).toBeLessThan(35)
      expect(after.pitch).toBeLessThan(35)
      expect(after.margin).toBeGreaterThanOrEqual(0)
      expect(after.under).toBeLessThan(0.001)
      expect(after.lift).toBeLessThan(0.02)
      expect(after.footTilt).toBeLessThan(15)
      // and better than without (more upright, more inside)
      expect(after.tilt).toBeLessThan(before.tilt + 0.5)
      expect(after.margin).toBeGreaterThan(before.margin)
      expect(after.ms).toBeLessThan(250)
    }
    console.log(rows.join('\n'))
  })

  it('the drop-in does the same through solveBody\'s arguments, planted or soft, quick or not', async () => {
    const b = await body(CHARACTER, true)
    const duration = (await load(path.join(LIBRARY, 'clips', 'custom-Spear_Thrust.glb'))).animations[0].duration
    const soles = b.legs.map(l => [l.end, l.ball, l.tip].map(x => (x === null ? -Infinity : wp(x).y)))
    const out: string[] = []
    for (const [label, options, quick] of [['soft', {}, false], ['soft, quick', {}, true], ['planted', { planted: true }, false], ['soft, no balance', { balance: false }, false]] as const) {
      await poseFromClip(b, 'custom-Spear_Thrust', 0.4 * duration)
      const solver = createBodySolver(b.model, b.offsets, options)
      const goals = (['Left', 'Right'] as const).map(hand => ({ hand, at: wp(b.bones.get(`${hand}Hand`)!).add(new THREE.Vector3(0, 0, 0.25)), turn: wq(b.bones.get(`${hand}Hand`)!) }))
      const t0 = performance.now()
      const r = solver(b.bones, goals, { limits: b.limits, nameOf, legs: b.legs, height: 0.7, quick, floor: 0, soles }, null)
      const ms = performance.now() - t0
      b.scene.updateMatrixWorld(true)
      const m = balanceOnBones(b, FEET)
      out.push(`${label}: trunk ${m.tiltDeg.toFixed(1)} deg, COM margin ${(m.margin * 100).toFixed(1)} cm, hands off ${(r.miss * 100).toFixed(2)} cm, ${ms.toFixed(0)} ms`)
      if (label === 'soft') { expect(m.tiltDeg).toBeLessThan(35); expect(m.margin).toBeGreaterThanOrEqual(0); expect(r.miss).toBeLessThan(0.01) }
      if (label === 'soft, quick') { expect(m.tiltDeg).toBeLessThan(35); expect(r.miss).toBeLessThan(0.02) }
    }
    console.log(out.join('\n'))
  })
})
