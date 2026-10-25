// Does the viewer's path for an entry (src/state/animator.svelte.ts scripted(): retarget, its speed, the scripts on a
// posable copy, back to speed 1) give the clip the game export made? Compares durations and every rotation track.
// node tools/dev/script_parity.ts <game models dir> <unit> <character id> <entry> [...]
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone } from 'three/addons/utils/SkeletonUtils.js'
import { captureRest, retarget } from '../../src/engine/retarget.ts'
import { applyScripts, retime } from '../../src/engine/scripts.ts'

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
const [models, unit, cid, ...names] = process.argv.slice(2)
const c = JSON.parse(readFileSync(path.join(ROOT, 'workspace/characters', cid, 'character.json'), 'utf8'))
const { scene } = await load(path.join(ROOT, 'workspace/characters', cid, c.files.rigged))
scene.updateMatrixWorld(true)
const rest = captureRest(scene, isBone)
const clipOf = async (e: { clipId: string, url?: string, inPlace: boolean }): Promise<THREE.AnimationClip> => {
  const src = e.url !== undefined ? await load(path.join(ROOT, 'static', e.url.split('#')[0])) : await load(path.join(ROOT, 'workspace/library/clips', `${e.clipId}.glb`))
  const anim = e.url !== undefined ? src.animations.find(a => a.name === decodeURIComponent(e.url!.split('#')[1]))! : src.animations[0]
  return retarget(src.scene, captureRest(src.scene, isBone), anim, rest, { fps: 30, inPlace: e.inPlace })
}
const game = await load(path.join(models, `${unit}.glb`))
for (const name of names) {
  const entry = c.animations.find((a: { name: string }) => a.name === name)
  const clips = new Map([[name, retime(await clipOf(entry), entry.speed)]])
  for (const s of c.scripts ?? []) if (s.enabled && s.kind === 'pace' && s.clip === name) { const like = c.animations.find((a: { name: string }) => a.name === s.like); clips.set(like.name, retime(await clipOf(like), like.speed)) }
  const { clips: out } = await applyScripts(clone(scene), clips, c.scripts ?? [], async id => await clipOf({ clipId: id, inPlace: true }))
  const viewer = retime(out.get(name)!, 1 / entry.speed)    // what the viewer plays, at timeScale = speed
  const exported = game.animations.find(a => a.name === name)!
  let worst = 0
  const mixerA = new THREE.AnimationMixer(new THREE.Object3D()); void mixerA
  for (const t of exported.tracks.filter(t => t.name.endsWith('.quaternion') && !t.name.startsWith('root'))) {
    const v = viewer.tracks.find(x => x.name === t.name)
    if (v === undefined) continue
    const ia = t.createInterpolant(); const ib = v.createInterpolant()
    for (let k = 0; k <= 20; k++) {
      const time = exported.duration * k / 20
      const a = new THREE.Quaternion().fromArray(ia.evaluate(time) as unknown as number[])
      const b = new THREE.Quaternion().fromArray(ib.evaluate(time * entry.speed) as unknown as number[])
      worst = Math.max(worst, THREE.MathUtils.radToDeg(a.angleTo(b)))
    }
  }
  console.log(`${unit} ${name}: exported ${exported.duration.toFixed(3)} s, viewer ${(viewer.duration / entry.speed).toFixed(3)} s at ${entry.speed}x; worst rotation gap ${worst.toFixed(3)} deg`)
}
