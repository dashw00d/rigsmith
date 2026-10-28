// Real-library naturalization acceptance: body sizes, contacts, hand constraints,
// finite rotations and independent source-frame sampling. Does not modify assets.
// node tools/dev/verify_naturalize.ts <report.json> [character-id ...] [--dense] [--clips id,id]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { body, character, entrySource, isBone, load, ROOT, WORKSPACE } from '../lib/node3d.ts'
import { captureRest, retarget, retargetOffsets } from '../../src/engine/retarget.ts'
import { JointLimits, type Rom } from '../../src/engine/limits.ts'
import { bodyColliderFor } from '../../src/engine/bodycollide.ts'
import { NaturalRig, PoseModel, naturalizeClip, naturalizeFrames, restSoles, type NaturalizeClipOptions, type PoseModelData } from '../../src/engine/posespace.ts'

const [output, ...args] = process.argv.slice(2)
const dense = args.includes('--dense')
const clipsAt = args.indexOf('--clips')
const clipIds = clipsAt < 0 ? undefined : args[clipsAt + 1]?.split(',')
if (clipsAt >= 0 && !clipIds?.length) throw new Error('--clips needs comma-separated clip IDs')
const only = args.filter((a, i) => a !== '--dense' && a !== '--clips' && (clipsAt < 0 || i !== clipsAt + 1))
if (!output) throw new Error('Pass an output report path')
const model = new PoseModel(JSON.parse(readFileSync(path.join(ROOT, 'static/templates/rom/human-pose.json'), 'utf8')) as PoseModelData)
const rom = JSON.parse(readFileSync(path.join(ROOT, 'static/templates/rom/human.json'), 'utf8')) as Rom
const mannequin = (await load(path.join(WORKSPACE, 'library/mannequin/ybot.glb'))).scene
const sourceRest = captureRest(mannequin, isBone)
const defaults = (JSON.parse(readFileSync(path.join(ROOT, 'static/templates/tests.json'), 'utf8')) as Record<string, Array<{ id: string, name: string, url?: string }>>).human
for (const id of ['Walking', 'Running', 'Jumping']) defaults.push({ id: `mixamo-${id}`, name: id })
const tests = clipIds === undefined ? defaults : clipIds.map(id => defaults.find(t => t.id === id) ?? { id, name: id })
const sources = await Promise.all(tests.map(t => entrySource({ clipId: t.id, url: t.url })))

/** Change in local angular velocity, including its direction. Both clips use the
 * same actual frame spacing, so sparse samples are never reported as 30 FPS. */
function acceleration (poses: Float32Array[], dt: number): { rms: number, p95: number, worst: number } {
  if (dt <= 0) return { rms: 0, p95: 0, worst: 0 }
  const values: number[] = []
  const a = new THREE.Quaternion(); const b = new THREE.Quaternion(); const c = new THREE.Quaternion()
  for (let i = 1; i + 1 < poses.length; i++) for (let j = 0; j < poses[i].length; j += 4) {
    a.fromArray(poses[i-1], j).normalize(); b.fromArray(poses[i], j).normalize(); c.fromArray(poses[i+1], j).normalize()
    const left = b.clone().multiply(a.invert()); const right = c.multiply(b.invert())
    values.push(THREE.MathUtils.radToDeg(left.angleTo(right)) / (dt * dt))
  }
  values.sort((a,b) => a-b)
  return { rms: Math.sqrt(values.reduce((s,v) => s+v*v, 0) / Math.max(1, values.length)), p95: values[Math.floor(values.length*.95)] ?? 0, worst: values.at(-1) ?? 0 }
}
const rows = []
for (const id of readdirSync(path.join(WORKSPACE, 'characters'))) {
  if (!existsSync(path.join(WORKSPACE, 'characters', id, 'character.json'))) continue
  const c = character(id)
  if (c.skeleton.template !== 'human' || c.files.rigged === undefined || (only.length > 0 && !only.includes(id))) continue
  const view = await body(id); const root = view.root; const bones = view.bones
  const rest = view.rest!
  const offsets = retargetOffsets(sourceRest, rest).offsets
  const limits = new JointLimits(rom, offsets, n => { const p = bones.get(n)?.parent; return p && isBone(p) ? p.name : null })
  const rig = new NaturalRig(model, bones, { offsets, limits, nameOf: b => b.name })
  const floor = { y: 0, soles: restSoles(bones) }
  const collider = bodyColliderFor(root, bones)
  const saved = [...bones.values()].map(b => ({ b, p: b.position.clone(), q: b.quaternion.clone() }))
  for (let t = 0; t < tests.length; t++) {
    const src = sources[t]
    const clip = retarget(src.scene, captureRest(src.scene, isBone), src.clip, rest, { fps: 30, inPlace: true })
    const mixer = new THREE.AnimationMixer(root)
    const intervals = clip.duration === 0 ? 0 : Math.max(1, Math.round(clip.duration * 30))
    const n = dense ? intervals + 1 : 12
    const times = Array.from({ length: n }, (_, i) => dense ? i * clip.duration / Math.max(intervals, 1) : clip.duration * (i + .5) / n)
    const pose = (i: number): void => {
      mixer.stopAllAction()
      for (const s of saved) { s.b.position.copy(s.p); s.b.quaternion.copy(s.q) }
      const action = mixer.clipAction(clip); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true
      action.reset().play(); mixer.setTime(times[i]); root.updateMatrixWorld(true)
    }
    let sourcePenetration = 0
    const sourcePoses = times.map((_, i) => {
      pose(i); sourcePenetration = Math.max(sourcePenetration, collider.selfPenetration().worst)
      return Float32Array.from(rig.bones.flatMap(b => b.quaternion.toArray()))
    })
    mixer.stopAllAction()
    for (const s of saved) { s.b.position.copy(s.p); s.b.quaternion.copy(s.q) }
    root.updateMatrixWorld(true)
    const start = performance.now()
    let frames
    try {
      const options: NaturalizeClipOptions = { root, fps: 30, referenceClip: clip, goals: () => ['LeftHand', 'RightHand'].map(name => ({ bone: name, position: bones.get(name)!.getWorldPosition(new THREE.Vector3()), turn: bones.get(name)!.getWorldQuaternion(new THREE.Quaternion()), exact: true })), feet: ['LeftFoot', 'RightFoot'], floor, collide: collider, pull: .05, pullOutside: .5, smoothMotion: 15, sweeps: 3 }
      frames = dense ? naturalizeClip(rig, clip, options).frames : naturalizeFrames(rig, { ...options, frames: n, pose, referencePose: pose, goals: i => options.goals(i, times[i]) })
    } finally {
      mixer.stopAllAction(); mixer.uncacheRoot(root)
      for (const s of saved) { s.b.position.copy(s.p); s.b.quaternion.copy(s.q) }
      root.updateMatrixWorld(true)
    }
    const finite = frames.every(f => [...f.q, ...f.hips, f.miss, f.floorMiss, f.turnMiss].every(Number.isFinite))
    const miss = Math.max(...frames.map(f => f.miss)); const under = Math.max(...frames.map(f => f.floorMiss))
    const penetration = Math.max(...frames.map(f => f.penetration ?? 0))
    const contactTolerance = .002 * view.height
    const addedContacts = frames.flatMap((f, i) => (f.penetrationIncrease ?? 0) > contactTolerance ? [{ frame: i, pair: f.increasedPair, increase: f.penetrationIncrease! }] : [])
    const penetrationIncrease = Math.max(...frames.map(f => f.penetrationIncrease ?? 0))
    const dt = clip.duration / (dense ? Math.max(intervals, 1) : n)
    const turnMiss = Math.max(...frames.map(f => f.turnMiss))
    const row = { id, clip: tests[t].id, dense, reference: 'original', frames: n, finite, handMiss: miss, turnMiss, floorMiss: under, sourcePenetration, penetration, penetrationIncrease, contactTolerance, addedContacts, feetSlide: Math.max(...frames.map(f => f.feetMoved.slide)), sourceAcceleration: acceleration(sourcePoses, dt), solvedAcceleration: acceleration(frames.map(f => f.q), dt), seconds: (performance.now() - start) / 1000, ok: finite && miss < .01 * view.height && under < .002 * view.height && turnMiss < .5 }
    rows.push(row)
    console.log(id, tests[t].name, row.ok ? 'OK' : 'FAIL', `hands ${(miss * 1000).toFixed(2)} mm floor ${(under * 1000).toFixed(2)} mm`)
    writeFileSync(output, JSON.stringify(rows, null, 2))
  }
}
if (rows.some(r => !r.ok)) process.exitCode = 1
