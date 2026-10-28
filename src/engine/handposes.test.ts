import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { bendOf, capturePose, handPose, setBend } from './handposes.ts'

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

  it("reads and sets a joint's curl and spread", () => {
    const q = setBend(undefined, 'curl', 40)
    expect(bendOf(q).curl).toBeCloseTo(40, 4)
    expect(bendOf(q).spread).toBeCloseTo(0, 4)
    const both = setBend(q, 'spread', 10)
    expect(bendOf(both).spread).toBeCloseTo(10, 1)
  })
})

describe('a fist on the sliders', () => {
  it('reads a closed hand past 90 and opens it back to straight', async () => {
    const { closeFinger, closedness } = await import('./handposes.ts')
    const { root, bones } = hand('Right')
    curl(bones, 'Right', 1.2)
    const fist = capturePose(root, 'Right', 'Fist')!
    expect(bendOf(fist.joints.Index1).curl).toBeGreaterThan(60)
    const straight = closeFinger(fist, fist, 'Index', 0)
    expect(closedness(straight, fist, 'Index')).toBeCloseTo(0, 6)
    expect(bendOf(straight.joints.Index2).curl).toBeCloseTo(0, 4)
    expect(closedness(closeFinger(straight, fist, 'Index', 1), fist, 'Index')).toBeCloseTo(1, 6)
    expect(bendOf(setBend(fist.joints.Index2, 'curl', 0)).curl).toBeCloseTo(0, 4)
  })
})
