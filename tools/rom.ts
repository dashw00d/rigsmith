// Each joint's range of motion, measured on real motion: the library's Mixamo clips for a person (thousands of motion
// captures: what a body can do), a template's own clips for a creature. Per bone, in its parent's frame: the directions
// the bone points (a grid on the sphere, which cells it reached) and how far it twists about itself. The animation
// editor holds every joint inside them (src/engine/limits.ts).
//
//   node tools/rom.ts human [--limit N]     the library (workspace/library), every other frame of every named clip
//   node tools/rom.ts horse                 static/animations/horse-animations.glb (its template's clips)
//
// Writes static/templates/rom/<rig>.json: { rig, bins: [elevation, azimuth], clips, frames, bones: { name: { axis,
// rest (the reference rest turn: the Y Bot's, a template's), cells (base64 bitmask, elevation-major: a cell with at
// least 3 frames in it, a person's), reached, twist: [min, max] degrees from rest, samples } } }.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { canonical } from '../src/engine/retarget.ts'
import { isBone, load, ROOT, WORKSPACE } from './lib/node3d.ts'

export const BINS: [number, number] = [36, 72]   // 5 degrees

const rig = process.argv[2] ?? 'human'
const limitAt = process.argv.indexOf('--limit')
const limit = limitAt >= 0 ? Number(process.argv[limitAt + 1]) : Infinity

/** A bone's axis in its own frame: towards the child that carries its chain on (its rest offset): the middle finger
 * for a hand, the neck for the chest, else its longest; none for a leaf. */
export function axisOf (b: THREE.Object3D): THREE.Vector3 | null {
  const kids = b.children.filter(c => isBone(c) && c.position.length() > 1e-6)
  if (kids.length === 0) return null
  const named = kids.find(c => /Middle1$|(^|:)Neck$/.test(canonical(c.name)))
  const child = named ?? kids.reduce((a, c) => (c.position.length() > a.position.length() ? c : a))
  return child.position.clone().normalize()
}

/** The cell of a direction (in the parent's frame). */
export function cellOf (d: THREE.Vector3, bins = BINS): number {
  const el = Math.acos(Math.max(-1, Math.min(1, d.y)))
  const az = Math.atan2(d.z, d.x) + Math.PI
  const i = Math.min(bins[0] - 1, Math.floor(el / Math.PI * bins[0]))
  const j = Math.min(bins[1] - 1, Math.floor(az / (2 * Math.PI) * bins[1]))
  return i * bins[1] + j
}

/** A local turn split about the bone's own axis: where the axis points (in the parent's frame), and the twist (radians)
 * about it (of the turn from rest: measure `rest^-1 q`'s, the rest near no twist whatever the bone's frame). */
export function swingTwist (q: THREE.Quaternion, axis: THREE.Vector3): { dir: THREE.Vector3, twist: number } {
  const proj = new THREE.Vector3(q.x, q.y, q.z).dot(axis)
  const twist = 2 * Math.atan2(proj, q.w)
  return { dir: axis.clone().applyQuaternion(q), twist: ((twist + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI }
}

interface Acc { axis: THREE.Vector3, cells: Uint32Array, twists: number[], samples: number }

async function measure (clips: Array<{ scene: THREE.Group, clip: THREE.AnimationClip }>, every: number): Promise<{ acc: Map<string, Acc>, frames: number }> {
  const acc = new Map<string, Acc>()
  let frames = 0
  const qp = new THREE.Quaternion(); const qb = new THREE.Quaternion(); const v = new THREE.Vector3(); const s = new THREE.Vector3()
  for (const { scene, clip } of clips) {
    const bones: THREE.Bone[] = []
    scene.traverse(o => { if (isBone(o) && isBone(o.parent!)) bones.push(o as THREE.Bone) })
    const axes = new Map(bones.map(b => [b, axisOf(b)]))
    const rests = new Map(bones.map(b => [b, b.quaternion.clone()]))
    const mixer = new THREE.AnimationMixer(scene)
    mixer.clipAction(clip).play()
    const n = Math.max(1, Math.round(clip.duration * 30))
    for (let f = 0; f <= n; f += every) {
      mixer.setTime(f / 30)
      scene.updateMatrixWorld(true)
      frames++
      for (const b of bones) {
        const axis = axes.get(b)
        if (axis === null || axis === undefined) continue
        b.parent!.matrixWorld.decompose(v, qp, s)
        b.matrixWorld.decompose(v, qb, s)
        const local = qp.clone().invert().multiply(qb)
        const name = canonical(b.name)
        let a = acc.get(name)
        if (a === undefined) { a = { axis, cells: new Uint32Array(BINS[0] * BINS[1]), twists: [], samples: 0 }; acc.set(name, a) }
        const { dir } = swingTwist(local, axis)
        const { twist } = swingTwist(rests.get(b)!.clone().invert().multiply(local), axis)
        a.cells[cellOf(dir)]++
        a.twists.push(twist)
        a.samples++
      }
    }
    mixer.stopAllAction()
    mixer.uncacheRoot(scene)
  }
  return { acc, frames }
}

/** The cells reached, as bits: a cell counts with `least` frames in it (one bad frame of a capture opens nothing). */
function pack (cells: Uint32Array, least: number): { bits: string, reached: number } {
  const bytes = new Uint8Array(Math.ceil(cells.length / 8))
  let reached = 0
  cells.forEach((c, i) => { if (c >= least) { bytes[i >> 3] |= 1 << (i & 7); reached++ } })
  return { bits: Buffer.from(bytes).toString('base64'), reached }
}

async function main (): Promise<void> {
  const clips: Array<{ scene: THREE.Group, clip: THREE.AnimationClip }> = []
  let every = 2
  if (rig === 'human') {
    const manifest = JSON.parse(readFileSync(path.join(WORKSPACE, 'library', 'manifest.json'), 'utf8')) as { clips: Array<{ id: string, file: string, source: string, duplicateOf?: string | null }> }
    const pool = manifest.clips.filter(c => c.source === 'mixamo-catalog' && (c.duplicateOf ?? null) === null).slice(0, limit)
    for (const [k, c] of pool.entries()) {
      const g = await load(path.join(WORKSPACE, 'library', c.file))
      if (g.animations[0] !== undefined) clips.push({ scene: g.scene, clip: g.animations[0] })
      if (k % 200 === 199) process.stderr.write(`${k + 1} / ${pool.length} loaded\n`)
    }
  } else {
    const spec = JSON.parse(readFileSync(path.join(ROOT, 'static', 'templates', `${rig}.json`), 'utf8')) as { animations?: string }
    if (spec.animations === undefined) throw new Error(`${rig}: no animations`)
    const g = await load(path.join(ROOT, 'static', spec.animations))
    for (const clip of g.animations) if (!/rest.?pose/i.test(clip.name)) clips.push({ scene: g.scene, clip })
    every = 1
  }
  const { acc, frames } = await measure(clips, every)
  // the reference rest (each bone's rest turn, twists are measured from): the Y Bot's for a person, the template's own
  const reference = rig === 'human' ? (await load(path.join(WORKSPACE, 'library', 'mannequin', 'ybot.glb'))).scene : clips[0].scene
  const restOf = new Map<string, THREE.Quaternion>()
  reference.traverse(o => { if (isBone(o)) restOf.set(canonical(o.name), o.quaternion.clone()) })
  const least = rig === 'human' ? 3 : 1
  const bones: Record<string, unknown> = {}
  for (const [name, a] of [...acc].sort()) {
    const t = a.twists.sort((x, y) => x - y)
    const at = (f: number): number => Math.round(THREE.MathUtils.radToDeg(t[Math.min(t.length - 1, Math.floor(f * (t.length - 1)))]) * 10) / 10
    const { bits, reached } = pack(a.cells, least)
    const rest = restOf.get(name) ?? new THREE.Quaternion()
    bones[name] = { axis: a.axis.toArray().map(x => Math.round(x * 1e5) / 1e5), rest: rest.toArray().map(x => Math.round(x * 1e6) / 1e6), cells: bits, reached, twist: [at(0.002), at(0.998)], samples: a.samples }
  }
  const out = path.join(ROOT, 'static', 'templates', 'rom', `${rig}.json`)
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ rig, bins: BINS, clips: clips.length, frames, bones }) + '\n')
  console.log(`${rig}: ${clips.length} clips, ${frames} frames, ${Object.keys(bones).length} bones -> ${path.relative(ROOT, out)}`)
}

if (process.argv[1] === import.meta.filename) await main()
