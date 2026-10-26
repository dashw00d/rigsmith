import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { applyBoneKeys, applyLift, sampleKeys } from './keys.ts'
import type { ClipKey } from '../../server/workspace.ts'

const turn = (deg: number): ClipKey['q'] => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(deg)).toArray() as ClipKey['q']
const angle = (q: THREE.Quaternion): number => Math.round(THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(q.w)))))

describe('sampleKeys', () => {
  const keys: ClipKey[] = [{ u: 0.2, q: turn(0) }, { u: 0.6, q: turn(40) }]
  it('blends between keys', () => { expect(angle(sampleKeys(keys, 0.4, false).q)).toBe(20) })
  it('holds at a one-shot\'s ends', () => {
    expect(angle(sampleKeys(keys, 0.0, false).q)).toBe(0)
    expect(angle(sampleKeys(keys, 0.9, false).q)).toBe(40)
  })
  it('wraps round a loop', () => {
    // from 40 at 0.6 back to 0 at 1.2 (= 0.2): halfway at 0.9
    expect(angle(sampleKeys(keys, 0.9, true).q)).toBe(20)
    expect(angle(sampleKeys(keys, 0.05, true).q)).toBe(10)
  })
  it('is no change with no keys', () => { expect(sampleKeys([], 0.5, true).q.w).toBe(1) })
})

describe('applyLift and applyBoneKeys', () => {
  const clip = new THREE.AnimationClip('c', 1, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 1, 0, 0, 1.2, 0]),
    new THREE.QuaternionKeyframeTrack('Arm.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ])
  it('lifts the hips throughout', () => {
    const lifted = applyLift(clip, 'Hips', 0.05, new THREE.Vector3())
    const v = lifted.tracks.find(t => t.name === 'Hips.position')!.values
    expect([v[1], v[4]].map(x => Math.round(x * 100) / 100)).toEqual([1.05, 1.25])
  })
  it('turns a keyed bone on top of the clip', () => {
    const keyed = applyBoneKeys(clip, { Arm: [{ u: 0, q: turn(30) }] }, false, () => ({ q: new THREE.Quaternion(), p: new THREE.Vector3() }))
    const t = keyed.tracks.find(x => x.name === 'Arm.quaternion')!
    expect(angle(new THREE.Quaternion().fromArray(Array.from(t.values.slice(0, 4))))).toBe(30)
  })
})
