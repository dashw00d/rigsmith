// Actual surface crossings in source and naturalized motion, without modifying
// any asset. Crossing lengths are not penetration depths or enclosed volumes.
// node tools/dev/verify_surfaces.ts report.json character-id clip-id [--frames 24,54]
import { readFileSync, writeFileSync } from 'node:fs'
import * as THREE from 'three'
import { body, entrySource, isBone, load, ROOT, WORKSPACE } from '../lib/node3d.ts'
import { SkinnedSurface } from '../lib/surface.ts'
import { captureRest, retarget, retargetOffsets } from '../../src/engine/retarget.ts'
import { JointLimits, type Rom } from '../../src/engine/limits.ts'
import { bodyColliderFor } from '../../src/engine/bodycollide.ts'
import { NaturalRig, PoseModel, naturalizeClip, restSoles, type PoseModelData } from '../../src/engine/posespace.ts'
import type { SurfaceCrossing } from '../../src/engine/surfacecontact.ts'

const [output,id,clipId,...args] = process.argv.slice(2)
if (!output || !id || !clipId) throw new Error('Pass report.json, character ID and clip ID')
const at = args.indexOf('--frames'), only = at < 0 ? null : new Set(args[at+1].split(',').map(Number))
const view = await body(id), root = view.root, bones = view.bones
const surface = new SkinnedSurface(root), collider = bodyColliderFor(root,bones)
const model = new PoseModel(JSON.parse(readFileSync(`${ROOT}/static/templates/rom/human-pose.json`,'utf8')) as PoseModelData)
const rom = JSON.parse(readFileSync(`${ROOT}/static/templates/rom/human.json`,'utf8')) as Rom
const mannequin = (await load(`${WORKSPACE}/library/mannequin/ybot.glb`)).scene
const offsets = retargetOffsets(captureRest(mannequin,isBone),view.rest!).offsets
const limits = new JointLimits(rom,offsets,n => bones.get(n)?.parent?.name ?? null)
const rig = new NaturalRig(model,bones,{ offsets, limits, nameOf: b => b.name })
const floor = { y: 0, soles: restSoles(bones) }
const source = await entrySource({clipId})
const clip = retarget(source.scene,captureRest(source.scene,isBone),source.clip,view.rest!,{fps:30,inPlace:true})
const saved: Array<{ b: THREE.Object3D, p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3 }> = []
root.traverse(b => saved.push({ b, p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() }))
const restore = (): void => { for (const s of saved) { s.b.position.copy(s.p); s.b.quaternion.copy(s.q); s.b.scale.copy(s.s) } root.updateMatrixWorld(true) }
const bind = surface.crossings(view.height*1e-6)
const key = (c: SurfaceCrossing): string => `${c.a},${c.b}`
const bindPairs = new Set(bind.map(key))
const summary = (crossings: SurfaceCrossing[]): { count: number, length: number, newToBind: number, regions: Record<string, { count: number, length: number }> } => {
  const regions: Record<string, { count: number, length: number }> = {}
  for (const c of crossings) {
    const pair = [surface.regions[c.a],surface.regions[c.b]].sort().join('|')
    regions[pair] ??= { count: 0, length: 0 }; regions[pair].count++; regions[pair].length += c.length
  }
  return { count: crossings.length, length: crossings.reduce((s,c) => s+c.length,0), newToBind: crossings.filter(c => !bindPairs.has(key(c))).length, regions }
}
const solved = naturalizeClip(rig,clip,{ root, referenceClip:clip, fps:30, goals: () => ['LeftHand','RightHand'].map(bone => ({ bone, position: bones.get(bone)!.getWorldPosition(new THREE.Vector3()), turn: bones.get(bone)!.getWorldQuaternion(new THREE.Quaternion()), exact:true })), feet:['LeftFoot','RightFoot'], floor, collide:collider, pull:.05, pullOutside:.5, smoothMotion:15, sweeps:3 })
const mixer = new THREE.AnimationMixer(root)
const rows = []
const start = performance.now()
for (let i = 0; i < solved.times.length; i++) {
  if (only !== null && !only.has(i)) continue
  mixer.stopAllAction(); restore()
  const action = mixer.clipAction(clip); action.setLoop(THREE.LoopOnce,1); action.clampWhenFinished = true; action.reset().play(); mixer.setTime(solved.times[i]); root.updateMatrixWorld(true)
  const sourceCrossings = surface.crossings(view.height*1e-6), sourcePairs = new Set(sourceCrossings.map(key))
  const sourceCapsules = collider.selfPenetration()
  rig.bones.forEach((b,j) => b.quaternion.fromArray(solved.frames[i].q,j*4)); rig.bones[0].position.fromArray(solved.frames[i].hips); root.updateMatrixWorld(true)
  const crossings = surface.crossings(view.height*1e-6), pairs = new Set(crossings.map(key))
  const added = crossings.filter(c => !sourcePairs.has(key(c))).map(c => ({ ...c, regions: [surface.regions[c.a],surface.regions[c.b]] }))
  const row = { frame:i, time:solved.times[i], source:summary(sourceCrossings), solved:summary(crossings), sourceCapsules, solvedCapsules:collider.selfPenetration(), capsuleIncrease:solved.frames[i].penetrationIncrease, added, removed:sourceCrossings.filter(c => !pairs.has(key(c))) }
  rows.push(row)
  if (i%15 === 0 || only !== null) console.log(id,clipId,i,`crossings ${sourceCrossings.length} -> ${crossings.length}, new ${added.length}, added length ${(added.reduce((s,c) => s+c.length,0)*1000).toFixed(1)} mm`)
}
mixer.stopAllAction(); mixer.uncacheRoot(root); restore()
writeFileSync(output,JSON.stringify({ id,clip:clipId,vertices:surface.positions.length/3,triangles:surface.index.length/3,epsilon:view.height*1e-6,bind:summary(bind),seconds:(performance.now()-start)/1000,frames:rows },null,2))
console.log('Surface analysis seconds',(performance.now()-start)/1000)
