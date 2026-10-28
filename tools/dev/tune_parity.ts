// Do a clip's ground, bone keys and prop keys play the same in the viewer and in the game export? Builds an entry the
// viewer's way (animator.scripted: retarget, its speed, the scripts, src/engine/keys.ts on a scene with its props
// attached as the viewer attaches them) and plays the exported unit's clip of the same name; compares every bone's and
// every prop vertex's position, game space mapped back into the character's (the export's scale and floor undone).
// node tools/dev/tune_parity.ts <exported unit.glb> <character id> <height> <clip> [...]
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone } from 'three/addons/utils/SkeletonUtils.js'
import { captureRest, restUpOf, retarget } from '../../src/engine/retarget.ts'
import { applyScripts, handScripts, retime } from '../../src/engine/scripts.ts'
import { applyBoneKeys, applyLift, propTracks } from '../../src/engine/keys.ts'
import { garmentMatrix } from '../../src/engine/placement.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images') }
const warn = console.warn
console.warn = (...a: unknown[]) => { if (!String(a[0]).includes('GLTFLoader')) warn(...a) }
const ROOT = path.resolve(import.meta.dirname, '../..')
const load = async (f: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> => {
  const d = readFileSync(f)
  return await new Promise((resolve, reject) => { new GLTFLoader().parse(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength), '', r => { resolve(r as never) }, reject) })
}
const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true
const [exported, cid, heightArg, ...names] = process.argv.slice(2)
const height = Number(heightArg)
const dir = path.join(ROOT, 'workspace/characters', cid)
const c = JSON.parse(readFileSync(path.join(dir, 'character.json'), 'utf8'))
const { scene } = await load(path.join(dir, c.files.rigged))
scene.updateMatrixWorld(true)
let body: THREE.SkinnedMesh | undefined
scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) body = o as THREE.SkinnedMesh })
const box = new THREE.Box3().setFromBufferAttribute(body!.geometry.attributes.position as THREE.BufferAttribute)
const floor = box.min.y; const s = height / (box.max.y - box.min.y)
const rest = captureRest(scene, isBone)
// the props as the viewer attaches them: bone -> rest frame undone -> placement node -> mesh
const props: Array<{ name: string, mesh: THREE.Mesh }> = []
for (const gm of c.garments ?? []) {
  if (gm.mode !== 'rigid' || gm.status !== 'ready' || (gm.hidden === true && !/^(Gear|Head|Wear)/.test(gm.name))) continue
  const bone = scene.getObjectByName(gm.bone)!
  const r = rest.bones.get(gm.bone)!
  const group = new THREE.Group()
  group.applyMatrix4(new THREE.Matrix4().compose(r.worldPosition, r.worldQuaternion, new THREE.Vector3(1, 1, 1)).invert())
  const place = new THREE.Group(); place.name = `${gm.name.replace(/[^\w]+/g, '_')}_place`
  garmentMatrix(gm).decompose(place.position, place.quaternion, place.scale)
  const src = await load(path.join(dir, gm.file))
  src.scene.updateMatrixWorld(true)
  src.scene.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh === true) { const mm = new THREE.Mesh(m.geometry.clone().applyMatrix4(m.matrixWorld)); place.add(mm); props.push({ name: gm.name, mesh: mm }) } })
  group.add(place); bone.add(group)
}
const clipOf = async (e: { clipId: string, url?: string, inPlace: boolean }): Promise<THREE.AnimationClip> => {
  const src = e.url !== undefined ? await load(path.join(ROOT, 'static', e.url.split('#')[0])) : await load(path.join(ROOT, 'workspace/library/clips', `${e.clipId}.glb`))
  const anim = e.url !== undefined ? src.animations.find(a => a.name === decodeURIComponent(e.url!.split('#')[1]))! : src.animations[0]
  return retarget(src.scene, captureRest(src.scene, isBone), anim, rest, { fps: 30, inPlace: e.inPlace })
}
const game = await load(exported)
let gameBody: THREE.SkinnedMesh | undefined
game.scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && gameBody === undefined) gameBody = o as THREE.SkinnedMesh })
for (const name of names) {
  const entry = c.animations.find((a: { name: string }) => a.name === name)
  const clips = new Map([[name, retime(await clipOf(entry), entry.speed)]])
  for (const sc of c.scripts ?? []) if (sc.enabled && sc.kind === 'pace' && sc.clip === name) { const like = c.animations.find((a: { name: string }) => a.name === sc.like); clips.set(like.name, retime(await clipOf(like), like.speed)) }
  const { clips: out } = await applyScripts(clone(scene), clips, handScripts(c), async id => await clipOf({ clipId: id, inPlace: true }))
  let clip = applyLift(out.get(name)!, 'Hips', entry.lift ?? 0, rest.bones.get('Hips')!.localPosition, restUpOf(rest, 'Hips'))
  clip = applyBoneKeys(clip, entry.keys?.bones, entry.loop, b => { const r = rest.bones.get(b); return r === undefined ? null : { q: r.localQuaternion.clone(), p: r.localPosition.clone() } })
  const tracks = [...clip.tracks]
  for (const gm of c.garments ?? []) {
    const node = `${gm.name.replace(/[^\w]+/g, '_')}_place`
    if (scene.getObjectByName(node) === undefined) continue
    const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const sc = new THREE.Vector3()
    garmentMatrix(gm).decompose(p, q, sc)
    tracks.push(...propTracks(node, clip.duration, entry.keys?.props?.[gm.name], entry.loop, { position: p, quaternion: q }, gm.scale))
  }
  const viewer = new THREE.AnimationClip(name, clip.duration, tracks)
  const exportedClip = game.animations.find(a => a.name === name)!
  // (played once and held: at its very end a looping action wraps to its start, the two at slightly different instants)
  const mv = new THREE.AnimationMixer(scene); const av = mv.clipAction(viewer); av.setLoop(THREE.LoopOnce, 1); av.clampWhenFinished = true; av.play()
  const mg = new THREE.AnimationMixer(game.scene); const ag = mg.clipAction(exportedClip); ag.setLoop(THREE.LoopOnce, 1); ag.clampWhenFinished = true; ag.play()
  let boneGap = 0; let propGap = 0; let n = 0
  const v = new THREE.Vector3(); const w = new THREE.Vector3()
  for (let k = 0; k <= 10; k++) {
    const t = exportedClip.duration * k / 10
    mv.setTime(t); mg.setTime(t); scene.updateMatrixWorld(true); game.scene.updateMatrixWorld(true)
    for (const [bn] of rest.bones) {
      const a = scene.getObjectByName(bn); const b = game.scene.getObjectByName(bn)
      if (a === undefined || b === undefined) continue
      v.setFromMatrixPosition(a.matrixWorld); w.setFromMatrixPosition(b.matrixWorld); w.set(w.x / s, w.y / s + floor, w.z / s)
      boneGap = Math.max(boneGap, v.distanceTo(w))
    }
    for (const pr of props) {
      let gm: THREE.SkinnedMesh | undefined
      game.scene.traverse(o => { if (o.name === pr.name && (o as THREE.SkinnedMesh).isSkinnedMesh) gm = o as THREE.SkinnedMesh })
      if (gm === undefined) continue
      const pa = pr.mesh.geometry.attributes.position; const pg = gm.geometry.attributes.position
      for (let i = 0; i < Math.min(pa.count, pg.count); i += 25) {
        v.fromBufferAttribute(pa, i).applyMatrix4(pr.mesh.matrixWorld)
        w.fromBufferAttribute(pg, i); gm.applyBoneTransform(i, w); w.applyMatrix4(gm.matrixWorld); w.set(w.x / s, w.y / s + floor, w.z / s)
        propGap = Math.max(propGap, v.distanceTo(w)); n++
      }
    }
  }
  console.log(`${name}: ${viewer.duration.toFixed(3)} s vs ${exportedClip.duration.toFixed(3)} s; worst bone gap ${boneGap.toExponential(1)}, worst prop vertex gap ${propGap.toExponential(1)} (${n} samples; the character is about 1 tall)`)
}
