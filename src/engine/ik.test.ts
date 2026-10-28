// @vitest-environment node
// Reaching, crouching and the floor on the Y Bot, within the library's joint limits (skipped without the library).
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { loadGlbFile as load } from './headless.ts'
import { canonical } from './retarget.ts'
import { JointLimits, type Rom } from './limits.ts'
import { keepOffFloor, moveHips, reach, soleHeights, type Leg } from './ik.ts'

const ROOT = path.resolve(__dirname, '../..')
const YBOT = path.join(ROOT, 'workspace/library/mannequin/ybot.glb')
const have = existsSync(YBOT)
const rom = JSON.parse(readFileSync(path.join(ROOT, 'static/templates/rom/human.json'), 'utf8')) as Rom

async function ybot (): Promise<{ scene: THREE.Group, b: (n: string) => THREE.Bone, limits: JointLimits }> {
  const { scene } = await load(YBOT)
  const bones = new Map<string, THREE.Bone>()
  scene.traverse(o => { if ((o as THREE.Bone).isBone) bones.set(canonical(o.name), o as THREE.Bone) })
  scene.updateMatrixWorld(true)
  const parentOf = (n: string): string | null => { const p = bones.get(n)?.parent; return p !== undefined && p !== null && (p as THREE.Bone).isBone ? canonical(p.name) : null }
  return { scene, b: n => bones.get(n)!, limits: new JointLimits(rom, null, parentOf) }
}
const nameOf = (bone: THREE.Bone): string => canonical(bone.name)
const at = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3())
const leg = (b: (n: string) => THREE.Bone, s: string): Leg => ({ upper: b(`${s}UpLeg`), lower: b(`${s}Leg`), end: b(`${s}Foot`), ball: b(`${s}ToeBase`), tip: b(`${s}Toe_End`) })

describe.skipIf(!have)('reaching and crouching', () => {
  it('puts a hand where it is dragged, the joints in range', async () => {
    const { b, limits } = await ybot()
    const shoulder = at(b('LeftArm'))
    const target = shoulder.clone().add(new THREE.Vector3(0.15, -0.25, 0.3))
    const miss = reach({ upper: b('LeftArm'), lower: b('LeftForeArm'), end: b('LeftHand') }, target, { limits, nameOf })
    expect(miss).toBeLessThan(0.02)
    for (const n of ['LeftArm', 'LeftForeArm', 'LeftHand']) expect(limits.within(n, b(n).quaternion), n).toBe(true)
  })

  it('crouches with the feet where they stand, the knees bending forward', async () => {
    const { b, limits } = await ybot()
    const legs = [leg(b, 'Left'), leg(b, 'Right')]
    const feet = legs.map(l => at(l.end))
    const kneeZ = at(b('LeftLeg')).z
    moveHips(b('Hips'), new THREE.Vector3(0, -0.3, 0), legs, { limits, nameOf })
    legs.forEach((l, i) => { expect(at(l.end).distanceTo(feet[i])).toBeLessThan(0.005) })
    expect(at(b('LeftLeg')).z).toBeGreaterThan(kneeZ + 0.05)
    for (const n of ['LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg']) expect(limits.within(n, b(n).quaternion)).toBe(true)
  })

  it('stops the hips where the legs fold no further', async () => {
    const { b, limits } = await ybot()
    const legs = [leg(b, 'Left'), leg(b, 'Right')]
    const hips = at(b('Hips')).y
    const went = moveHips(b('Hips'), new THREE.Vector3(0, -3, 0), legs, { limits, nameOf })
    expect(went.y).toBeGreaterThan(-hips)
    expect(at(b('Hips')).y).toBeGreaterThan(0.1)
  })

  it('keeps a foot off the floor', async () => {
    const { b, limits } = await ybot()
    const legs = [leg(b, 'Left')]
    const soles = legs.map(soleHeights)
    // the foot pointed down (whichever way about its x takes the toes down): its toes go under the floor
    const rest = b('LeftFoot').quaternion.clone()
    const tipAt = (a: number): number => { b('LeftFoot').quaternion.copy(rest).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a)); b('LeftFoot').updateMatrixWorld(true); return at(b('LeftToe_End')).y }
    const down = tipAt(0.6) < tipAt(-0.6) ? 0.6 : -0.6
    tipAt(down)
    const low = Math.min(at(b('LeftToeBase')).y - soles[0][1], at(b('LeftToe_End')).y - soles[0][2])
    expect(low).toBeLessThan(-0.01)
    keepOffFloor(legs, 0, soles, { limits, nameOf })
    expect(at(b('LeftToeBase')).y).toBeGreaterThan(soles[0][1] - 1e-3)
    expect(at(b('LeftToe_End')).y).toBeGreaterThan(soles[0][2] - 1e-3)
  })
})
