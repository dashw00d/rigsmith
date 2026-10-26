// Natural two-handed grips, from the library: the frames of the Mixamo clips where both hands hold one straight shaft (a
// rifle, a staff, a great sword, a bayonet, a pole, a carried log), each with the upper body's pose and the grip in the
// chest frame, thinned to a few hundred or thousand diverse ones (src/engine/twohandpose.ts finds the nearest to a grip).
//
//   node tools/twohand_poses.ts [--limit N] [--max 1500] [--cache FILE] [--stats]
//
// A frame qualifies when each fist (src/engine/clipedit.ts handGrip: where the fingers close, and the line a shaft takes
// through them) lies on the line through the other's: the two grip lines run along the hand-to-hand line (each within
// `ANGLE` of it and of one another), each fist within `OFF` of the other's grip line, the hands `near`..`far` apart (the Y
// Bot's metres: it is 1.8 m, and a mocap hand closes loosely, so the offsets and angles are generous: golf clubs and bats
// qualify as readily as spears), the fingers closed, the body upright (not a plank), and held for `RUN` sampled frames running (a hand crossing the line
// on its way past is not a hold). Names and descriptions decide nothing; they are only reported beside the result.
//
// --cache FILE keeps the scan (the loose candidates with their metrics) so the thresholds can be tuned without
// reading the library again; --stats prints what the thresholds keep.
//
// Writes static/templates/rom/human-twohand.json (see TwoHandData in src/engine/twohandpose.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { handGrip } from '../src/engine/clipedit.ts'
import { captureRest } from '../src/engine/retarget.ts'
import { bodyScale, gripOfPose, mirrorGrip, POSE_BONES, worldOfBones, type Grip, type TwoHandData } from '../src/engine/twohandpose.ts'
import { isBone, load, ROOT, WORKSPACE } from './lib/node3d.ts'

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const LIMIT = Number(arg('--limit') ?? Infinity)
const MAX = Number(arg('--max') ?? 1500)
const CACHE = arg('--cache')
const STATS = process.argv.includes('--stats')
const EVERY = 2

// thresholds
const T = {
  near: Number(arg('--near') ?? 0.08), far: Number(arg('--far') ?? 0.80),   // the fists' distance (the Y Bot's metres: it is 1.8 m tall)
  angle: Number(arg('--angle') ?? 50),       // degrees: a grip line against the hand-to-hand line (hands 20 cm or more apart: closer, that line is the fists' noise)
  between: Number(arg('--between') ?? 50),   // degrees: the two grip lines against each other
  offBase: Number(arg('--off') ?? 0.07),     // a fist's distance from the other's grip line: this (m) plus
  offSlope: Number(arg('--slope') ?? 0.2),   //   this times the fists' distance (mocap hands close loosely round what they hold)
  curl: Number(arg('--curl') ?? 25),         // degrees: the fingers' closing (mean of the four knuckles), at least
  curlNamed: Number(arg('--curl-named') ?? 10),   //   (a clip named for what it holds: its hands may be loose)
  lean: Number(arg('--lean') ?? 60),         // degrees: the torso's lean from upright, at most (not on the floor: a plank, a push-up)
  hips: Number(arg('--hips') ?? 0.45),       // m: the hips' height, at least (the Y Bot's hips stand at 1.0)
  run: Number(arg('--run') ?? 3),            // sampled frames running
}

interface Cand {
  clip: number
  frame: number
  dist: number; angL: number; angR: number; angLR: number; offL: number; offR: number; curl: number; lean: number; hips: number
  grip: Grip
  turns: number[]
}
interface Scan { clips: string[], names: string[], descriptions: string[], size: number, rise: number, frames: number, skipped: string[], cands: Cand[] }

const deg = THREE.MathUtils.radToDeg
const lineAngle = (a: THREE.Vector3, b: THREE.Vector3): number => deg(Math.acos(Math.min(1, Math.abs(a.dot(b)))))
const offLine = (p: THREE.Vector3, o: THREE.Vector3, d: THREE.Vector3): number => p.clone().sub(o).cross(d).length()

async function scan (): Promise<Scan> {
  const manifest = JSON.parse(readFileSync(path.join(WORKSPACE, 'library', 'manifest.json'), 'utf8')) as { clips: Array<{ id: string, name: string, description?: string, file: string, source: string, duplicateOf?: string | null }> }
  const pool = manifest.clips.filter(c => c.source === 'mixamo-catalog' && (c.duplicateOf ?? null) === null).slice(0, LIMIT)
  const out: Scan = { clips: [], names: [], descriptions: [], size: 0, rise: 0, frames: 0, skipped: [], cands: [] }
  let reference: Map<string, THREE.Quaternion> | null = null
  for (const [k, c] of pool.entries()) {
    const g = await load(path.join(WORKSPACE, 'library', c.file))
    const clip = g.animations[0]
    if (clip === undefined) continue
    const scene = g.scene
    const rest = captureRest(scene, isBone)
    const scale = bodyScale(rest)
    const left = handGrip(rest, 'Left'); const right = handGrip(rest, 'Right')
    if (scale === null || left === null || right === null || POSE_BONES.some(b => !rest.bones.has(b))) { out.skipped.push(`${c.id} (no arms/hands)`); continue }
    // (all the library's clips are on the Y Bot's rest: the stored turns are on it; one that isn't is left out)
    const here = new Map(POSE_BONES.map(b => [b, rest.bones.get(b)!.localQuaternion.clone()]))
    if (reference === null) { reference = here; out.size = scale.size; out.rise = scale.rise }
    else if (POSE_BONES.some(b => here.get(b)!.angleTo(reference!.get(b)!) > 0.02) || Math.abs(scale.size - out.size) > 0.01) { out.skipped.push(`${c.id} (another rest)`); continue }
    const nodes = new Map<string, THREE.Bone>()
    scene.traverse(o => { if (isBone(o)) nodes.set(rest.bones.get(o.name)?.name ?? o.name, o as THREE.Bone) })
    const names = new Map<string, THREE.Bone>()
    for (const b of rest.bones.values()) names.set(b.name, b.node as THREE.Bone)
    const world = worldOfBones(names)
    const fist = { Left: left.fist, Right: right.fist }
    const index = out.clips.length
    out.clips.push(c.id); out.names.push(c.name); out.descriptions.push(c.description ?? '')
    const mixer = new THREE.AnimationMixer(scene)
    mixer.clipAction(clip).play()
    const n = Math.max(1, Math.round(clip.duration * 30))
    const fingers = ['Left', 'Right'].flatMap(side => ['Index1', 'Middle1', 'Ring1', 'Pinky1'].map(f => `${side}Hand${f}`)).filter(f => names.has(f))
    for (let f = 0; f <= n; f += EVERY) {
      mixer.setTime(f / 30)
      scene.updateMatrixWorld(true)
      out.frames++
      const pg = gripOfPose(world, fist, scale)
      if (pg === null) continue
      const [fl, fr] = pg.fists
      const d = fr.clone().sub(fl)
      const dist = d.length() / scale.size
      d.normalize()
      const axes = (['Left', 'Right'] as const).map(side => (side === 'Left' ? left : right).axis.clone().applyQuaternion(names.get(`${side}Hand`)!.getWorldQuaternion(new THREE.Quaternion())).normalize())
      const angL = lineAngle(axes[0], d); const angR = lineAngle(axes[1], d); const angLR = lineAngle(axes[0], axes[1])
      const offL = offLine(fr, fl, axes[0]) / scale.size; const offR = offLine(fl, fr, axes[1]) / scale.size
      // (loose: keep what could qualify at the loosest thresholds worth trying)
      if (dist * scale.size < 0.08 || dist * scale.size > 1.2 || angLR > 75 || offL * scale.size > 0.25 || offR * scale.size > 0.25) continue
      let curl = 0
      for (const fn of fingers) curl += deg(names.get(fn)!.quaternion.angleTo(rest.bones.get(fn)!.localQuaternion))
      curl /= Math.max(1, fingers.length)
      const q: number[] = [pg.tilt.x, pg.tilt.y, pg.tilt.z, pg.tilt.w]
      for (const b of POSE_BONES.slice(1)) { const o = names.get(b)!.quaternion; q.push(o.x, o.y, o.z, o.w) }
      const neck = world.position('Neck')!; const hipsAt = world.position('Hips')!
      const lean = deg(Math.acos(Math.max(-1, Math.min(1, neck.clone().sub(hipsAt).normalize().y))))
      out.cands.push({ clip: index, frame: f, dist: dist, angL, angR, angLR, offL, offR, curl, lean, hips: hipsAt.y, grip: pg.grip, turns: q })
    }
    mixer.stopAllAction()
    mixer.uncacheRoot(scene)
    if (k % 400 === 399) process.stderr.write(`${k + 1} / ${pool.length} scanned, ${out.cands.length} loose candidates\n`)
  }
  return out
}

/** The candidates that pass the thresholds, then those held for `run` sampled frames running. Lengths are in units of the
 * body's size: the thresholds are the Y Bot's metres over it. */
function qualify (cands: Cand[], size: number, hinted: (clip: number) => boolean): Cand[] {
  const pass = cands.filter(c => {
    const m = c.dist * size
    const off = (T.offBase + T.offSlope * m) / size
    return m >= T.near && m <= T.far && c.angLR <= T.between && c.offL <= off && c.offR <= off && c.curl >= (hinted(c.clip) ? T.curlNamed : T.curl) &&
      (m < 0.2 || (c.angL <= T.angle && c.angR <= T.angle)) && c.lean <= T.lean && c.hips >= T.hips
  })
  // runs: consecutive sampled frames of one clip
  const kept: Cand[] = []
  let run: Cand[] = []
  const flush = (): void => { if (run.length >= T.run) kept.push(...run); run = [] }
  for (const c of pass) {
    const last = run[run.length - 1]
    if (last !== undefined && (last.clip !== c.clip || c.frame - last.frame !== EVERY)) flush()
    run.push(c)
  }
  flush()
  return kept
}

/** Farthest-point sampling on the fists (a pose and its mirror image are one), over the tiers in turn: each takes the candidate
 * farthest from all chosen so far, until `max` are chosen in all or none is further than the tier's `stop` (units of size). */
function thin (cands: Cand[], tiers: Array<{ ids: number[], max: number, stop: number }>): number[] {
  const feat = cands.map(c => [...c.grip.left, ...c.grip.right])
  const mir = cands.map(c => { const m = mirrorGrip(c.grip); return [...m.left, ...m.right] })
  const dist2 = (a: number[], b: number[]): number => { let s = 0; for (let i = 0; i < 6; i++) s += (a[i] - b[i]) ** 2; return s }
  const nearest = new Float64Array(cands.length).fill(Infinity)
  const chosen: number[] = []
  const take = (i: number): void => {
    chosen.push(i)
    for (let j = 0; j < cands.length; j++) { const d = Math.min(dist2(feat[j], feat[i]), dist2(feat[j], mir[i])); if (d < nearest[j]) nearest[j] = d }
  }
  for (const tier of tiers) {
    if (tier.ids.length === 0) continue
    if (chosen.length === 0) {
      // (start at the candidate nearest the mean: the middle of what people do)
      const mean = Array.from({ length: 6 }, (_, i) => tier.ids.reduce((s, id) => s + feat[id][i], 0) / tier.ids.length)
      take(tier.ids.reduce((best, id) => (dist2(feat[id], mean) < dist2(feat[best], mean) ? id : best), tier.ids[0]))
    }
    while (chosen.length < tier.max) {
      let far = -1; let farD = -1
      for (const id of tier.ids) if (nearest[id] > farD) { farD = nearest[id]; far = id }
      if (far < 0 || farD < tier.stop * tier.stop) break
      take(far)
    }
  }
  return chosen
}

const HINT = /rifle|gun|bayonet|staff|spear|pike|sword|2hand|two.?hand|hammer|axe|pole|carry|club|baseball|golf|bat\b|shovel|torch|broom|paddl|digging|heavy|lance|halberd|push|pull|lift|plank|box|swing|bow\b|arrow/i

async function main (): Promise<void> {
  let data: Scan
  if (CACHE !== undefined && existsSync(CACHE)) data = JSON.parse(readFileSync(CACHE, 'utf8')) as Scan
  else {
    const t0 = Date.now()
    data = await scan()
    process.stderr.write(`scanned ${data.clips.length} clips, ${data.frames} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${data.cands.length} loose candidates, ${data.skipped.length} skipped\n`)
    if (CACHE !== undefined) writeFileSync(CACHE, JSON.stringify(data))
  }
  const hintOf = (clip: number): boolean => HINT.test(data.names[clip] + ' ' + data.descriptions[clip])
  const kept = qualify(data.cands, data.size, hintOf)
  const per = new Map<number, number>()
  for (const c of kept) per.set(c.clip, (per.get(c.clip) ?? 0) + 1)
  const top = [...per].sort((a, b) => b[1] - a[1])
  console.log(`qualify: ${kept.length} frames (of ${data.frames} sampled, ${data.cands.length} loose) from ${per.size} of ${data.clips.length} clips`)
  console.log('top clips: ' + top.slice(0, 25).map(([c, n]) => `${data.names[c]} ${n}`).join('; '))
  const hint = HINT
  const odd = top.filter(([c]) => !hint.test(data.names[c] + ' ' + data.descriptions[c]))
  console.log(`clips with no name hint: ${odd.length} (${odd.slice(0, 20).map(([c, n]) => `${data.names[c]} ${n}`).join('; ')})`)
  if (STATS) {
    const pct = (a: number[], f: number): number => a.slice().sort((x, y) => x - y)[Math.floor(f * (a.length - 1))]
    for (const key of ['dist', 'angL', 'angR', 'angLR', 'offL', 'offR', 'curl'] as const) {
      const a = kept.map(c => c[key] * (key === 'dist' || key.startsWith('off') ? data.size : 1))
      console.log(`  ${key}: p5 ${pct(a, 0.05).toFixed(3)} p50 ${pct(a, 0.5).toFixed(3)} p95 ${pct(a, 0.95).toFixed(3)}`)
    }
  }
  if (process.argv.includes('--dry')) return
  // (the names rank: the clips named for what they hold first, then any other grip nothing named is near)
  const hinted = kept.map((c, i) => (hintOf(c.clip) ? i : -1)).filter(i => i >= 0)
  const others = kept.map((_, i) => i).filter(i => !hinted.includes(i))
  const chosen = thin(kept, [{ ids: hinted, max: Math.round(MAX * 0.85), stop: 0.012 }, { ids: others, max: MAX, stop: 0.12 }])
  const clipsUsed = [...new Set(chosen.map(i => kept[i].clip))].sort((a, b) => a - b)
  const remap = new Map(clipsUsed.map((c, i) => [c, i]))
  const r4 = (x: number): number => Math.round(x * 1e4) / 1e4
  const out: TwoHandData = {
    rig: 'human', bones: [...POSE_BONES], size: r4(data.size), rise: r4(data.rise),
    clips: clipsUsed.map(c => data.clips[c]), clip: chosen.map(i => remap.get(kept[i].clip)!), frame: chosen.map(i => kept[i].frame),
    grip: chosen.flatMap(i => [...kept[i].grip.left, ...kept[i].grip.right, ...kept[i].grip.shaft].map(r4)),
    turns: chosen.flatMap(i => kept[i].turns.map(r4)),
    qualified: { frames: kept.length, clips: per.size, scanned: data.clips.length, sampled: data.frames, every: EVERY, thresholds: T },
  }
  const file = path.join(ROOT, 'static', 'templates', 'rom', 'human-twohand.json')
  mkdirSync(path.dirname(file), { recursive: true })
  const text = JSON.stringify(out) + '\n'
  writeFileSync(file, text)
  const used = new Map<number, number>()
  for (const i of chosen) used.set(kept[i].clip, (used.get(kept[i].clip) ?? 0) + 1)
  console.log(`kept ${chosen.length} poses from ${clipsUsed.length} clips -> ${path.relative(ROOT, file)} (${(text.length / 1024).toFixed(0)} KB); most: ` +
    [...used].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c, n]) => `${data.names[c]} ${n}`).join('; '))
}

if (process.argv[1] === import.meta.filename) await main()
