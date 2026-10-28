import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Placement } from '../model/types.ts'
import { placementMatrix } from './placement.ts'
import { catalogItem, catalogPlacement, defaultScale, gripFrame, gripPoint, gripToRest, type RestBody } from './props.ts'
import { captureRest } from './retarget.ts'

/** An arm down to a hand with a finger, turned and (optionally) scaled like an imported rig's bones. */
function arm (scale = 1): { root: THREE.Object3D, hand: THREE.Bone, body: RestBody } {
  const root = new THREE.Object3D()
  const bone = (name: string, parent: THREE.Object3D, at: [number, number, number]): THREE.Bone => {
    const b = new THREE.Bone()
    b.name = name
    b.position.set(...at)
    parent.add(b)
    return b
  }
  const hips = bone('Hips', root, [0, 1, 0])
  hips.scale.setScalar(scale)
  const shoulder = bone('RightArm', hips, [-0.2, 0.45, 0])
  shoulder.quaternion.setFromEuler(new THREE.Euler(0.2, -0.3, -1.2))
  const forearm = bone('RightForeArm', shoulder, [0, 0.28, 0])
  forearm.quaternion.setFromEuler(new THREE.Euler(0.4, 0, 0.1))
  const hand = bone('RightHand', forearm, [0, 0.25, 0])
  hand.quaternion.setFromEuler(new THREE.Euler(0, 0.6, 0.2))
  bone('RightHandMiddle1', hand, [0.01, 0.09, 0.005])
  root.updateMatrixWorld(true)
  return { root, hand, body: { rest: captureRest(root, o => (o as THREE.Bone).isBone === true), height: 1.75 } }
}

/** Where the old catalog props put a model: bone -> grip frame (its anchor and turn, the bone's scale undone) ->
 * offset (bone lengths, degrees, scale). */
function oldWorld (body: RestBody, hand: THREE.Bone, place: Placement): THREE.Matrix4 {
  const frame = gripFrame(body, 'RightHand')!
  const mount = new THREE.Object3D()
  mount.quaternion.copy(frame.quaternion)
  mount.position.copy(frame.anchor)
  mount.scale.setScalar(1 / (hand.getWorldScale(new THREE.Vector3()).x || 1))
  const holder = new THREE.Object3D()
  holder.position.set(place.position[0] * frame.unit, place.position[1] * frame.unit, place.position[2] * frame.unit)
  holder.rotation.set(...place.rotation.map(d => THREE.MathUtils.degToRad(d)) as [number, number, number])
  holder.scale.setScalar(place.scale)
  mount.add(holder)
  hand.add(mount)
  hand.updateMatrixWorld(true)
  const m = holder.matrixWorld.clone()
  mount.removeFromParent()
  return m
}

/** Where gear is worn now: bone -> its rest frame undone -> the placement (src/engine/garments.ts boneFrame). */
function newWorld (body: RestBody, hand: THREE.Bone, place: Placement): THREE.Matrix4 {
  const rest = body.rest!.bones.get('RightHand')!
  const restFrame = new THREE.Matrix4().compose(rest.worldPosition, rest.worldQuaternion, new THREE.Vector3(1, 1, 1))
  return hand.matrixWorld.clone().multiply(restFrame.invert()).multiply(placementMatrix(place))
}

const close = (a: THREE.Matrix4, b: THREE.Matrix4): void => {
  a.elements.forEach((v, i) => expect(v).toBeCloseTo(b.elements[i], 3))
}

describe('catalog placements', () => {
  const kept: Placement = { position: [0.1, -0.2, 0.3], rotation: [-30, 10, 75], scale: 1.1 }

  it('puts a grip-frame placement where the old props put it', () => {
    const { hand, body } = arm()
    close(newWorld(body, hand, gripToRest(body, 'RightHand', kept)!), oldWorld(body, hand, kept))
  })

  it('does so on a scaled rig too', () => {
    const { hand, body } = arm(0.01)
    close(newWorld(body, hand, gripToRest(body, 'RightHand', kept)!), oldWorld(body, hand, kept))
  })

  it('knows nothing of a bone the skeleton lacks', () => {
    const { body } = arm()
    expect(gripToRest(body, 'LeftHand', kept)).toBeNull()
    expect(gripPoint(body, 'LeftHand')).toEqual([0, 0, 0])
  })

  it('holds things at the palm: part way toward the farthest finger', () => {
    const { body } = arm()
    const [x, y, z] = gripPoint(body, 'RightHand')
    expect(Math.hypot(x, y, z)).toBeCloseTo(Math.hypot(0.01, 0.09, 0.005) * 0.75, 3)
  })

  it('starts a new piece from its table placement, sized to the character', () => {
    const { hand, body } = arm()
    const item = catalogItem('sword_B.glb')!
    const place = catalogPlacement(body, item, 'RightHand')!
    expect(place.scale).toBeCloseTo(defaultScale(1.75), 3)
    expect(new THREE.Vector3(...place.position).distanceTo(hand.getWorldPosition(new THREE.Vector3()))).toBeLessThan(0.3)
  })
})
