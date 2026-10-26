// @vitest-environment node
// The editor's clip: a library clip retargeted onto a character and taken back (the retarget undone) is the clip it
// was; skipped without the local library and a rigged character.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { captureRest, retarget } from './retarget.ts'
import { unretarget } from './clipedit.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images in tests') }

const ROOT = path.resolve(__dirname, '../..')
const CLIP = path.join(ROOT, 'workspace/library/clips/mixamo-Jumping_Jacks.glb')
const chars = path.join(ROOT, 'workspace/characters')
const rigged = existsSync(chars) ? readdirSync(chars).map(d => path.join(chars, d, 'rigged.glb')).find(f => existsSync(f) && !/horse|pony/.test(f)) : undefined
const have = existsSync(CLIP) && rigged !== undefined

async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  const data = readFileSync(file)
  return await new Promise((resolve, reject) => { new GLTFLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '', r => { resolve(r) }, reject) })
}
const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true

describe.skipIf(!have)('taking an edited clip back to the library', () => {
  it('gives back the clip it was retargeted from', async () => {
    const src = await load(CLIP)
    const target = await load(rigged!)
    const sRest = captureRest(src.scene, isBone)
    const tRest = captureRest(target.scene, isBone)
    const onTarget = retarget(src.scene, sRest, src.animations[0], tRest, { fps: 30 })
    const back = unretarget(onTarget, target.scene, tRest, sRest, src.animations[0])
    // the source as it plays, against what came back, frame by frame: every bone's local turn, and the hips
    const mixer = new THREE.AnimationMixer(src.scene)
    mixer.clipAction(src.animations[0]).play()
    let worst = 0; let hipsWorst = 0
    const per = new Map<string, number>()
    back.rotations.forEach((frame, f) => {
      mixer.setTime(Math.min(f / back.fps, src.animations[0].duration))
      back.bones.forEach((name, b) => {
        const node = sRest.bones.get(name)!.node
        const q = new THREE.Quaternion().fromArray(frame[b])
        const a = THREE.MathUtils.radToDeg(q.angleTo(node.quaternion))
        per.set(name, Math.max(per.get(name) ?? 0, a))
        worst = Math.max(worst, a)
      })
      const hips = sRest.bones.get('Hips')!.node
      hipsWorst = Math.max(hipsWorst, new THREE.Vector3().fromArray(back.hips[f]).distanceTo(hips.position))
    })
    if (worst >= 0.5) console.log([...per].filter(([, a]) => a > 0.5).map(([n, a]) => `${n} ${a.toFixed(1)}`).join(', '), 'in target:', [...per.keys()].filter(n => !tRest.bones.has(n)).join(','))
    expect(worst).toBeLessThan(0.5)
    expect(hipsWorst).toBeLessThan(0.005)
  })
})
