import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { HandPose } from '../model/types.ts'
import { bindRest, capturePose, handFrame, handPose, handRest, poseAt, poseClip, poseLocals, withinReach, withJoint } from './handposes.ts'

// A hand on a skinned mesh: a wrist and four fingers (three bones and a tip each), palm down (-y), the index forward
// (+z): the right hand out along -x (a character faces +z, its right is -x), the left along +x. `twist` turns every bone's own axes about its length: a re-rig that names
// the same joints with other local axes.
function hand (side: 'Left' | 'Right', twist = 0): { root: THREE.Object3D, bones: Map<string, THREE.Bone> } {
  const s = side === 'Right' ? -1 : 1
  const root = new THREE.Group()
  const bones = new Map<string, THREE.Bone>()
  const wrist = new THREE.Bone(); wrist.name = `${side}Hand`; root.add(wrist); bones.set(wrist.name, wrist)
  const at = (b: THREE.Bone, world: THREE.Vector3): void => { b.parent!.updateMatrixWorld(true); b.position.copy(b.parent!.worldToLocal(world.clone())) }
  const fingers: Array<[string, number]> = [['Index', 0.03], ['Middle', 0.01], ['Ring', -0.01], ['Pinky', -0.03]]
  for (const [f, z] of fingers) {
    let parent = wrist
    for (let i = 1; i <= 4; i++) {
      const b = new THREE.Bone(); b.name = `${side}Hand${f}${i}`
      parent.add(b)
      b.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), twist)
      at(b, new THREE.Vector3(s * (0.08 + 0.025 * (i - 1)), 0, z))
      bones.set(b.name, b); parent = b
    }
  }
  root.updateMatrixWorld(true)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4))
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  root.add(mesh); mesh.bind(new THREE.Skeleton([...bones.values()]))
  return { root, bones }
}
const tips = (bones: Map<string, THREE.Bone>, side: string): THREE.Vector3[] =>
  ['Index', 'Middle', 'Ring', 'Pinky'].map(f => bones.get(`${side}Hand${f}4`)!.getWorldPosition(new THREE.Vector3()))
// curl every finger joint about the hand's own across axis (z here), toward the palm
function curl (bones: Map<string, THREE.Bone>, side: string, by: number): void {
  for (const [n, b] of bones) {
    if (!/\d$/.test(n) || n.endsWith('4')) continue
    b.updateMatrixWorld(true)
    const world = b.getWorldQuaternion(new THREE.Quaternion())
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, side === 'Right' ? 1 : -1), by)
    const parentWorld = b.parent!.getWorldQuaternion(new THREE.Quaternion())
    b.quaternion.copy(parentWorld.invert().multiply(turn.multiply(world)))
    b.updateMatrixWorld(true)
  }
}

describe('hand poses', () => {
  it('gives back the fingers it was taken from', () => {
    const { root, bones } = hand('Right')
    curl(bones, 'Right', 0.6)
    const want = tips(bones, 'Right')
    const pose = capturePose(root, 'Right', 'Fist')!
    for (const b of bones.values()) if (/\d$/.test(b.name)) b.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0)
    for (const [n, q] of handPose(root, 'Right', pose)) bones.get(n)!.quaternion.copy(q)
    root.updateMatrixWorld(true)
    tips(bones, 'Right').forEach((p, i) => expect(p.distanceTo(want[i])).toBeLessThan(1e-6))
  })

  it("survives a re-rig that turns the bones' own axes", () => {
    const a = hand('Right'); curl(a.bones, 'Right', 0.5)
    const want = tips(a.bones, 'Right')
    const pose = capturePose(a.root, 'Right', 'Grip')!
    const b = hand('Right', 1.1)
    for (const [n, q] of handPose(b.root, 'Right', pose)) b.bones.get(n)!.quaternion.copy(q)
    b.root.updateMatrixWorld(true)
    tips(b.bones, 'Right').forEach((p, i) => expect(p.distanceTo(want[i])).toBeLessThan(1e-6))
  })

  it('closes the other hand the same way, mirrored', () => {
    const r = hand('Right'); curl(r.bones, 'Right', 0.7)
    const want = tips(r.bones, 'Right').map(p => new THREE.Vector3(-p.x, p.y, p.z))
    const pose = capturePose(r.root, 'Right', 'Fist')!
    const l = hand('Left')
    for (const [n, q] of handPose(l.root, 'Left', pose)) l.bones.get(n)!.quaternion.copy(q)
    l.root.updateMatrixWorld(true)
    tips(l.bones, 'Left').forEach((p, i) => expect(p.distanceTo(want[i])).toBeLessThan(1e-6))
  })
})

describe('a fist on the sliders', () => {
  it('opens a closed hand back to straight and closes it again', async () => {
    const { closeFinger, closedness } = await import('./handposes.ts')
    const { root, bones } = hand('Right')
    curl(bones, 'Right', 1.2)
    const fist = capturePose(root, 'Right', 'Fist')!
    // (a joint's whole turn in degrees, read off the quaternion's axis part so it stays exact near zero)
    const turn = (q: [number, number, number, number] | undefined): number => (q === undefined ? 0 : THREE.MathUtils.radToDeg(2 * Math.asin(Math.min(1, Math.hypot(q[0], q[1], q[2])))))
    expect(turn(fist.joints.Index1)).toBeGreaterThan(60)
    const straight = closeFinger(fist, fist, 'Index', 0)
    expect(closedness(straight, fist, 'Index')).toBeCloseTo(0, 6)
    expect(turn(straight.joints.Index2)).toBeCloseTo(0, 4)
    expect(closedness(closeFinger(straight, fist, 'Index', 1), fist, 'Index')).toBeCloseTo(1, 6)
  })
})

describe('the hand frame', () => {
  it('faces the back of either hand the same way, so the two hands mirror', () => {
    for (const side of ['Left', 'Right'] as const) {
      const { bones } = hand(side)
      const f = handFrame(n => bones.get(n)?.getWorldPosition(new THREE.Vector3()) ?? null, side)!
      // (palm down, so its back is up; the fingers out along the arm; across toward the index, +z here)
      expect(f.back.y).toBeCloseTo(1, 6)
      expect(f.across.z).toBeCloseTo(1, 6)
      expect(f.forward.x * (side === 'Right' ? -1 : 1)).toBeGreaterThan(0.99)
      expect(f.wrist.length()).toBeLessThan(1e-9)
    }
  })

  it('needs a wrist and knuckles to measure across by', () => {
    const { bones } = hand('Right')
    expect(handFrame(() => null, 'Right')).toBeNull()
    expect(handFrame(n => (n === 'RightHand' || n === 'RightHandIndex1' ? bones.get(n)!.getWorldPosition(new THREE.Vector3()) : null), 'Right')).toBeNull()
  })
})

describe('a pose off a clip, and a pose as a clip', () => {
  it('reads the hand at a time of a clip, the joints it leaves alone as at rest', () => {
    const { root, bones } = hand('Right')
    const rest = new Map([...bones].map(([n, b]) => [n, b.quaternion.clone()]))
    curl(bones, 'Right', 0.8)
    const want = capturePose(root, 'Right', 'Curl')!
    // (every finger joint but the little finger's, from rest at 0 to the curl at 1)
    const tracks = [...bones].filter(([n]) => /[123]$/.test(n) && !n.includes('Pinky'))
      .map(([n, b]) => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, [0, 1], [...rest.get(n)!.toArray(), ...b.quaternion.toArray()]))
    const clip = new THREE.AnimationClip('Curl', 1, tracks)
    // (the clip is read, not played: the bones stay at rest)
    for (const [n, b] of bones) b.quaternion.copy(rest.get(n)!)
    root.updateMatrixWorld(true)
    const got = poseAt(root, 'Right', clip, 1, 'Taken', { clip: 'Curl', at: 1 })!
    for (const k of ['Index1', 'Middle2', 'Ring3']) got.joints[k].forEach((v, i) => expect(v).toBeCloseTo(want.joints[k][i], 5))
    expect(new THREE.Quaternion(...got.joints.Pinky1).angleTo(new THREE.Quaternion())).toBeLessThan(1e-5)
    expect(got).toMatchObject({ name: 'Taken', side: 'Right', from: { clip: 'Curl', at: 1 } })
    const start = poseAt(root, 'Right', clip, 0, 'Start')!
    expect(new THREE.Quaternion(...start.joints.Index2).angleTo(new THREE.Quaternion())).toBeLessThan(1e-5)
    expect(bones.get('RightHandIndex1')!.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-9)
  })

  it('shows a pose as a clip that puts the fingers back as they were', () => {
    const { root, bones } = hand('Left')
    curl(bones, 'Left', 0.6)
    const want = tips(bones, 'Left')
    const pose = capturePose(root, 'Left', 'Grip')!
    for (const b of bones.values()) if (/\d$/.test(b.name)) b.quaternion.identity()
    root.updateMatrixWorld(true)
    const clip = poseClip(root, 'Left', pose)
    expect(clip.name).toBe('Hand pose: Grip')
    const mixer = new THREE.AnimationMixer(root)
    mixer.clipAction(clip).play()
    mixer.setTime(0.5)
    root.updateMatrixWorld(true)
    tips(bones, 'Left').forEach((p, i) => expect(p.distanceTo(want[i])).toBeLessThan(1e-6))
  })
})

describe('shaping a pose', () => {
  it('turns one joint on the hand shown, the pose made over on that hand', () => {
    const { root } = hand('Right')
    const rest = handRest(bindRest(root), 'Right')!
    const blank: HandPose = { id: 'p1', name: 'Blank', side: 'Left', joints: {} }
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5)
    const next = withJoint(rest, 'Right', blank, 'RightHandIndex2', q)
    expect(next).toMatchObject({ id: 'p1', name: 'Blank', side: 'Right' })
    expect(Object.keys(next.joints)).toEqual(['Index2'])
    expect(poseLocals(rest, 'Right', next).get('RightHandIndex2')!.angleTo(q)).toBeLessThan(1e-5)
  })

  it('holds each joint it turns within reach, and adds none', () => {
    const { root, bones } = hand('Right')
    curl(bones, 'Right', 1)
    const fist = capturePose(root, 'Right', 'Fist')!
    const some: HandPose = { ...fist, joints: { Index1: fist.joints.Index1, Middle1: fist.joints.Middle1 } }
    const rest = handRest(bindRest(root), 'Right')!
    // (a reach that keeps the index's knuckle at rest and lets everything else be)
    const reach = { has: (b: string) => b === 'RightHandIndex1', clamp: (b: string) => rest.get(b)!.local.clone() }
    const held = withinReach(rest, some, reach)
    expect(Object.keys(held.joints).sort()).toEqual(['Index1', 'Middle1'])
    expect(new THREE.Quaternion(...held.joints.Index1).angleTo(new THREE.Quaternion())).toBeLessThan(1e-5)
    held.joints.Middle1.forEach((v, i) => expect(v).toBeCloseTo(some.joints.Middle1[i], 5))
    expect(held.side).toBe('Right')
  })
})
