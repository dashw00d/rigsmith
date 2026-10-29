import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { applyBoneKeys, applyLift, sampleKeys } from './keys.ts'
import type { ClipKey } from '../model/types.ts'

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
    // (three quarters of the way, eased: two keys turn back at each)
    expect(angle(sampleKeys(keys, 0.05, true).q)).toBe(6)
  })
  it('passes through a middle key without stopping', () => {
    const five: ClipKey[] = [0, 1, 2, 3, 4].map(i => ({ u: i / 4, q: turn(i * 20) }))
    // evenly spaced and in line: inside, the cubic is the straight line through them
    expect(angle(sampleKeys(five, 0.375, false).q)).toBe(30)
    // it moves at a middle key (no hold there), and eases out of the first
    const a = angle(sampleKeys(five, 0.48, false).q); const b = angle(sampleKeys(five, 0.52, false).q)
    expect(b - a).toBeGreaterThan(2)
    expect(angle(sampleKeys(five, 0.02, false).q)).toBeLessThan(1)
  })
  it('is no change with no keys', () => { expect(sampleKeys([], 0.5, true).q.w).toBe(1) })
})

describe('sampleKeys: each span\'s ease', () => {
  const three = (ease?: ClipKey['ease']): ClipKey[] => [{ u: 0, q: turn(0) }, { u: 0.5, q: turn(40), ...(ease !== undefined ? { ease } : {}) }, { u: 1, q: turn(80) }]
  const at = (keys: ClipKey[], u: number): number => angle(sampleKeys(keys, u, false).q)
  it('steps: the key until the next, then a jump', () => {
    expect([at(three('step'), 0.6), at(three('step'), 0.99), at(three('step'), 1)]).toEqual([40, 40, 80])
    expect(at(three('hold'), 0.75)).toBe(40)
  })
  it('runs straight on a linear span, eases out and in on an ease span', () => {
    expect(at(three('linear'), 0.75)).toBe(60)
    // (stopping at both keys: a quarter of the way in, an eased span is behind a straight one)
    expect(at(three('ease'), 0.625)).toBeLessThan(at(three('linear'), 0.625))
    expect(at(three('ease'), 0.75)).toBe(60)
  })
  it('leaves the spans before it as they were: a smooth span is the same with or without eases after it', () => {
    expect(sampleKeys(three('step'), 0.25, false).q.toArray()).toEqual(sampleKeys(three(), 0.25, false).q.toArray())
  })
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
  it('holds the bone entirely over a hold span: the clip\'s own turn stopped at the key', () => {
    // (the clip turns the arm 0 -> 60 degrees; a hold at 0.25 keeps it where the clip had it then until 0.75)
    const turning = new THREE.AnimationClip('t', 1, [new THREE.QuaternionKeyframeTrack('Arm.quaternion', [0, 1], [...turn(0), ...turn(60)])])
    const rest = (): { q: THREE.Quaternion, p: THREE.Vector3 } => ({ q: new THREE.Quaternion(), p: new THREE.Vector3() })
    const keyed = applyBoneKeys(turning, { Arm: [{ u: 0.25, q: turn(0), ease: 'hold' }, { u: 0.75, q: turn(0) }] }, false, rest)
    const t = keyed.tracks.find(x => x.name === 'Arm.quaternion')!
    const at = (time: number): number => { const i = t.times.findIndex(x => Math.abs(x - time) < 1e-6); return angle(new THREE.Quaternion().fromArray(Array.from(t.values.slice(i * 4, i * 4 + 4)))) }
    expect([at(0.5), at(0.7)]).toEqual([15, 15])
    expect(at(0.9)).toBe(54)
  })
})

describe('propKeysOf', () => {
  it('gives back the keys propTracks played', async () => {
    const { propKeysOf, propTracks } = await import('./keys.ts')
    const place = { position: new THREE.Vector3(0.1, 0.2, 0.3), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.5, 0.2)) }
    const keys = [{ u: 0, q: [0, 0, 0, 1] as [number, number, number, number], p: [0, 0, 0] as [number, number, number] },
      { u: 0.5, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.1, -0.2)).toArray() as [number, number, number, number], p: [0.2, -0.1, 0.05] as [number, number, number] },
      { u: 1, q: [0, 0, 0, 1] as [number, number, number, number], p: [0, 0, 0] as [number, number, number] }]
    const clip = new THREE.AnimationClip('c', 1.02, propTracks('spear_place', 1.02, keys, false, place, 2))
    const back = propKeysOf(clip, 'spear_place', place, 2)!
    const again = new THREE.AnimationClip('c', 1.02, propTracks('spear_place', 1.02, back, false, place, 2))
    for (const [a, b] of clip.tracks.map((t, i) => [t, again.tracks[i]] as const)) {
      expect(Array.from(b.times)).toEqual(Array.from(a.times))
      Array.from(a.values).forEach((v, i) => expect(b.values[i]).toBeCloseTo(v, 4))
    }
    expect(propKeysOf(new THREE.AnimationClip('c', 1, propTracks('spear_place', 1, undefined, false, place, 2)), 'spear_place', place, 2)).toBeNull()
  })
})
