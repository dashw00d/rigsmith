// @vitest-environment node
// Pushing an arm out of the body (src/engine/pushclear.ts): a hand driven into the chest comes straight back out, no
// further than it must and in front of the body still; a hand on a handle stays where it is (only its elbow may swing);
// an arm already clear is left alone.
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { loadGlbFile as load } from './headless.ts'
import { canonical } from './retarget.ts'
import { buildBodyCollider } from './bodycollide.ts'
import { reach } from './ik.ts'
import { pushClear } from './pushclear.ts'

const ROOT = path.resolve(__dirname, '../..')
const YBOT = path.join(ROOT, 'workspace/library/mannequin/ybot.glb')
const have = existsSync(YBOT)

const wp = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3())
const nameOf = (b: THREE.Bone): string => b.name

async function ybot (): Promise<{ scene: THREE.Group, bones: Map<string, THREE.Bone>, height: number }> {
  const { scene } = await load(YBOT)
  scene.updateMatrixWorld(true)
  const bones = new Map<string, THREE.Bone>()
  scene.traverse(o => { if ((o as THREE.Bone).isBone === true) bones.set(canonical(o.name), o as THREE.Bone) })
  return { scene, bones, height: wp(bones.get('HeadTop_End') ?? bones.get('Head')!).y }
}

/** The left hand reached into the front of the chest. */
function handInChest (b: Awaited<ReturnType<typeof ybot>>): void {
  const arm = b.bones.get('LeftArm')!
  const chest = wp(b.bones.get('Spine1')!)
  const limb = { upper: arm, lower: b.bones.get('LeftForeArm')!, end: b.bones.get('LeftHand')! }
  reach(limb, chest.clone().add(new THREE.Vector3(0.02, 0.02, 0.06)), { nameOf, keepEnd: true })
  b.scene.updateMatrixWorld(true)
}

describe.skipIf(!have)('pushing an arm out of the body', () => {
  it('carries a hand in the chest straight out, a little, and keeps it in front', async () => {
    const b = await ybot()
    const c = buildBodyCollider(b.scene, b.bones)
    handInChest(b)
    const inside = c.selfPenetration()
    expect(inside.pairs.some(([x]) => x === 'LeftHand')).toBe(true)
    const hand = b.bones.get('LeftHand')!
    const was = wp(hand); const chest = wp(b.bones.get('Spine1')!)
    const r = pushClear(b.bones, c, { height: b.height, limits: null, nameOf })
    expect(r.moved.has('LeftArm')).toBe(true)
    expect(c.selfPenetration().pairs.filter(([x, y]) => [x, y].includes('LeftHand')).length).toBe(0)
    const now = wp(hand)
    // (no further than it must: a few centimetres, not across the body)
    expect(now.distanceTo(was)).toBeLessThan(0.15)
    // (still in front of the chest: the Y Bot faces +z)
    expect(now.z).toBeGreaterThan(chest.z)
    console.log(`hand pushed out ${(now.distanceTo(was) * 100).toFixed(1)} cm, ${(inside.worst * 100).toFixed(1)} cm deep before`)
  })

  it('keeps a hand on a handle where it is', async () => {
    const b = await ybot()
    const c = buildBodyCollider(b.scene, b.bones)
    handInChest(b)
    const hand = b.bones.get('LeftHand')!
    const was = wp(hand)
    pushClear(b.bones, c, { height: b.height, limits: null, nameOf, held: new Set(['Left']) })
    expect(wp(hand).distanceTo(was)).toBeLessThan(0.005)
  })

  it('leaves an arm already clear alone', async () => {
    const b = await ybot()
    const c = buildBodyCollider(b.scene, b.bones)
    const r = pushClear(b.bones, c, { height: b.height, limits: null, nameOf })
    expect(r.moved.size).toBe(0)
  })
})
