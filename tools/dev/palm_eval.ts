// After retargeting, does the character's palm face where the clip's palm faces?
// node tools/dev/palm_eval.ts <character.glb> <clip.glb>...  (prints mean/max palm and finger angle errors)
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { canonical, captureRest, retarget, type RestSkeleton } from '../../src/engine/retarget.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images') }
console.error = () => {}
async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  const data = readFileSync(file)
  return await new Promise((resolve, reject) => { new GLTFLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '', r => { resolve(r as never) }, reject) })
}
const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true
const nodes = (root: THREE.Object3D): Map<string, THREE.Object3D> => { const m = new Map<string, THREE.Object3D>(); root.traverse(o => { if (isBone(o) && !m.has(canonical(o.name))) m.set(canonical(o.name), o) }); return m }
const [charPath, ...clipPaths] = process.argv.slice(2)
for (const twist of [false, true]) {
  const errs: number[] = []
  for (const clipPath of clipPaths) {
    const ch = await load(charPath)
    const clip = await load(clipPath)
    const target = captureRest(ch.scene, isBone)
    const source = captureRest(clip.scene, isBone)
    if (!twist) { target.palms = {}; source.palms = {} }
    const palmsT = captureRest(ch.scene, isBone).palms
    const palmsS = captureRest(clip.scene, isBone).palms
    const baked = retarget(clip.scene, source, clip.animations[0], target, { fps: 30 })
    const tm = new THREE.AnimationMixer(ch.scene); tm.clipAction(baked).play()
    const sm = new THREE.AnimationMixer(clip.scene); sm.clipAction(clip.animations[0]).play()
    const tn = nodes(ch.scene); const sn = nodes(clip.scene)
    const restQ = (rest: RestSkeleton, n: string): THREE.Quaternion => rest.bones.get(n)!.worldQuaternion
    for (let f = 0; f < 16; f++) {
      const t = clip.animations[0].duration * f / 15
      tm.setTime(t); sm.setTime(Math.min(t, clip.animations[0].duration))
      ch.scene.updateMatrixWorld(true); clip.scene.updateMatrixWorld(true)
      for (const side of ['Left', 'Right'] as const) {
        const n = side + 'Hand'
        // World palm = rest palm carried by the hand bone's world rotation delta.
        const dq = (node: THREE.Object3D, rest: RestSkeleton): THREE.Quaternion => node.getWorldQuaternion(new THREE.Quaternion()).multiply(restQ(rest, n).clone().invert())
        const pt = palmsT[side]!.clone().applyQuaternion(dq(tn.get(n)!, target))
        const ps = palmsS[side]!.clone().applyQuaternion(dq(sn.get(n)!, source))
        errs.push(THREE.MathUtils.radToDeg(pt.angleTo(ps)))
      }
    }
  }
  errs.sort((a, b) => a - b)
  console.log(`${twist ? 'twist aligned ' : 'direction only'}  palm angle error  median ${errs[errs.length >> 1].toFixed(1)}°  p90 ${errs[Math.floor(errs.length * 0.9)].toFixed(1)}°  max ${errs[errs.length - 1].toFixed(1)}°`)
}
