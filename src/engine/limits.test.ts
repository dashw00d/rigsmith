// @vitest-environment node
// Joint limits on the Y Bot with the ranges measured on the library (static/templates/rom/human.json); skipped when
// the local library (its mannequin and clips) isn't built.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { canonical } from './retarget.ts'
import { JointLimits, type Rom } from './limits.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images in tests') }

const ROOT = path.resolve(__dirname, '../..')
const LIBRARY = path.join(ROOT, 'workspace/library')
const have = existsSync(path.join(LIBRARY, 'mannequin', 'ybot.glb'))
const rom = JSON.parse(readFileSync(path.join(ROOT, 'static/templates/rom/human.json'), 'utf8')) as Rom

async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  const data = readFileSync(file)
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  return await new Promise((resolve, reject) => { new GLTFLoader().parse(buffer, '', r => { resolve(r) }, reject) })
}

async function ybot (): Promise<{ scene: THREE.Group, bones: Map<string, THREE.Bone>, limits: JointLimits }> {
  const { scene } = await load(path.join(LIBRARY, 'mannequin', 'ybot.glb'))
  const bones = new Map<string, THREE.Bone>()
  scene.traverse(o => { if ((o as THREE.Bone).isBone) bones.set(canonical(o.name), o as THREE.Bone) })
  const parentOf = (b: string): string | null => { const p = bones.get(b)?.parent; return p !== undefined && p !== null && (p as THREE.Bone).isBone ? canonical(p.name) : null }
  return { scene, bones, limits: new JointLimits(rom, null, parentOf) }
}

/** Where a bone's child ends up (world) with the bone turned about its own local axis by `deg`. */
function bend (bones: Map<string, THREE.Bone>, scene: THREE.Object3D, bone: string, child: string, axis: THREE.Vector3, deg: number): { local: THREE.Quaternion, at: THREE.Vector3 } {
  const b = bones.get(bone)!
  const rest = b.quaternion.clone()
  b.quaternion.copy(rest).multiply(new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(deg)))
  scene.updateMatrixWorld(true)
  const out = { local: b.quaternion.clone(), at: bones.get(child)!.getWorldPosition(new THREE.Vector3()) }
  b.quaternion.copy(rest)
  scene.updateMatrixWorld(true)
  return out
}

describe.skipIf(!have)('joint limits from the library', () => {
  it('lets a knee bend one way and not the other', async () => {
    const { scene, bones, limits } = await ybot()
    // (the shin's turn about its own x: one way the foot goes back, a knee bending; the other forward)
    const a = bend(bones, scene, 'LeftLeg', 'LeftFoot', new THREE.Vector3(1, 0, 0), 90)
    const b = bend(bones, scene, 'LeftLeg', 'LeftFoot', new THREE.Vector3(1, 0, 0), -90)
    const back = a.at.z < b.at.z ? a : b
    const forward = a.at.z < b.at.z ? b : a
    expect(limits.within('LeftLeg', back.local)).toBe(true)
    expect(limits.within('LeftLeg', forward.local)).toBe(false)
    // and put back where a knee can be
    expect(limits.within('LeftLeg', limits.clamp('LeftLeg', forward.local))).toBe(true)
  })

  it('stops a forearm twisting round', async () => {
    const { bones, limits } = await ybot()
    const fore = bones.get('LeftForeArm')!
    const spun = fore.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(170)))
    expect(limits.within('LeftForeArm', spun)).toBe(false)
    const held = limits.clamp('LeftForeArm', spun)
    expect(limits.within('LeftForeArm', held)).toBe(true)
    // (only the twist came back: it still points the same way)
    const axis = new THREE.Vector3(0, 1, 0)
    expect(axis.clone().applyQuaternion(held).angleTo(axis.clone().applyQuaternion(spun))).toBeLessThan(0.05)
  })

  it('finds real motion within range', async () => {
    const { scene, bones, limits } = await ybot()
    const clip = (await load(path.join(LIBRARY, 'clips', 'mixamo-Jumping_Jacks.glb'))).animations[0]
    const mixer = new THREE.AnimationMixer(scene)
    mixer.clipAction(clip).play()
    let checked = 0; let out = 0
    for (let t = 0; t < clip.duration; t += 0.2) {
      mixer.setTime(t)
      for (const [name, b] of bones) { if (!limits.has(name)) continue; checked++; if (!limits.within(name, b.quaternion)) out++ }
    }
    expect(checked).toBeGreaterThan(200)
    expect(out / checked).toBeLessThan(0.02)
  })
})
