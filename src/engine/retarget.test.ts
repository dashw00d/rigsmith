// @vitest-environment node
// Retargeting checks against real library clips (skipped when the local library isn't built).
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { canonical, captureRest, mainChild, retarget, type RestSkeleton } from './retarget.ts'

// GLTFLoader expects a browser for textures; these tests only need skeletons and clips.
const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images in tests') }

const LIBRARY = path.resolve(__dirname, '../../workspace/library')
const have = existsSync(path.join(LIBRARY, 'manifest.json'))

async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  const data = readFileSync(file)
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  return await new Promise((resolve, reject) => { new GLTFLoader().parse(buffer, '', g => { resolve(g) }, reject) })
}

const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true

/** World direction from each bone to its first child, per bone name. */
function directions (root: THREE.Object3D, rest: RestSkeleton): Map<string, THREE.Vector3> {
  root.updateMatrixWorld(true)
  const out = new Map<string, THREE.Vector3>()
  const nodes = new Map<string, THREE.Object3D>()
  root.traverse(o => { if (rest.bones.has(canonical(o.name)) && (o as THREE.Bone).isBone) nodes.set(canonical(o.name), o) })
  for (const [name, bone] of rest.bones) {
    const child = mainChild(rest, name)
    if (child === null) continue
    const a = nodes.get(name)!.getWorldPosition(new THREE.Vector3())
    const b = nodes.get(child)!.getWorldPosition(new THREE.Vector3())
    if (b.distanceTo(a) > 1e-4) out.set(bone.name, b.sub(a).normalize())
  }
  return out
}

describe.skipIf(!have)('retarget onto the Y Bot mannequin', () => {
  const clips = ['c5dd9d93edee', '594aa124446c', '4358b1d9096c', '086915e942aa'] // Walking, Dying, Draw Arrow, a combat clip

  for (const id of clips) {
    it(`bone directions follow the source (${id})`, async () => {
      const source = await load(path.join(LIBRARY, 'clips', `${id}.glb`))
      const target = await load(path.join(LIBRARY, 'mannequin', 'ybot.glb'))
      const sourceRest = captureRest(source.scene, isBone)
      const targetRest = captureRest(target.scene, isBone)
      const baked = retarget(source.scene, sourceRest, source.animations[0], targetRest, { fps: 15 })

      const sourceMixer = new THREE.AnimationMixer(source.scene)
      sourceMixer.clipAction(source.animations[0]).play()
      const targetMixer = new THREE.AnimationMixer(target.scene)
      targetMixer.clipAction(baked).play()
      let worst = 0
      let worstBone = ''
      const keys = baked.tracks[0].times
      for (let k = 0; k < keys.length; k += Math.max(1, Math.floor(keys.length / 12))) {
        const t = keys[k]
        sourceMixer.setTime(t)
        targetMixer.setTime(t)
        const ds = directions(source.scene, sourceRest)
        const dt = directions(target.scene, targetRest)
        for (const [name, d] of dt) {
          const s = ds.get(name)
          if (s === undefined || name.includes('Hand') && name !== 'LeftHand' && name !== 'RightHand') continue
          const angle = THREE.MathUtils.radToDeg(d.angleTo(s))
          if (angle > worst) { worst = angle; worstBone = name }
        }
      }
      expect(worst, `worst bone ${worstBone}`).toBeLessThan(1.5)
    })
  }
})

describe('retarget creature clips onto a re-proportioned template', () => {
  const STATIC = path.resolve(__dirname, '../../static')
  for (const clipName of ['Walk', 'Run', 'Kick']) {
    it(`horse ${clipName} keeps bone directions`, async () => {
      const source = await load(path.join(STATIC, 'animations', 'horse-animations.glb'))
      const target = await load(path.join(STATIC, 'rigs', 'rig-horse.glb'))
      // Squash the target like a stocky pony: shorter legs and body, so rest directions differ.
      target.scene.traverse(o => { if ((o as THREE.Bone).isBone) o.position.multiply(new THREE.Vector3(1.2, 0.55, 0.7)) })
      const clip = source.animations.find(a => a.name === clipName)!
      const sourceRest = captureRest(source.scene, isBone)
      const targetRest = captureRest(target.scene, isBone)
      const baked = retarget(source.scene, sourceRest, clip, targetRest, { fps: 30 })
      const sourceMixer = new THREE.AnimationMixer(source.scene)
      sourceMixer.clipAction(clip).play()
      const targetMixer = new THREE.AnimationMixer(target.scene)
      targetMixer.clipAction(baked).play()
      let worst = 0
      let worstBone = ''
      const keys = baked.tracks[0].times
      for (let k = 0; k < keys.length; k += Math.max(1, Math.floor(keys.length / 10))) {
        sourceMixer.setTime(keys[k])
        targetMixer.setTime(keys[k])
        const ds = directions(source.scene, sourceRest)
        const dt = directions(target.scene, targetRest)
        for (const [name, d] of dt) {
          const s = ds.get(name)
          // root points at the translating hips, so its "direction" isn't a rotation to compare
          if (s === undefined || name === 'root') continue
          const angle = THREE.MathUtils.radToDeg(d.angleTo(s))
          if (angle > worst) { worst = angle; worstBone = name }
        }
      }
      expect(worst, `worst bone ${worstBone}`).toBeLessThan(1.5)
    })
  }
})
