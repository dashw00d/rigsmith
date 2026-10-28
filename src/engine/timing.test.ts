import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { blowCut, cut, holdFist, retime } from './timing.ts'

const value = (clip: THREE.AnimationClip, name: string, t: number): number[] => {
  const track = clip.tracks.find(x => x.name === name)!
  return Array.from((track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(t) as ArrayLike<number>)
}

describe('blowCut', () => {
  const clip = new THREE.AnimationClip('attack', 1, [new THREE.NumberKeyframeTrack('Hips.position[x]', [0, 0.5, 1], [0, 1, 2])])
  const root = new THREE.Object3D()

  it('keeps an attack whose set blow is on its first or last frame', () => {
    for (const blowU of [0, 1]) {
      const { clip: out } = blowCut(root, clip, { at: 0.5, blowU })
      expect(out.duration).toBeGreaterThan(0.01)
      const times = Array.from(out.tracks[0].times)
      times.slice(1).forEach((t, i) => expect(t).toBeGreaterThan(times[i]))
    }
  })

  it('cuts the start of a late blow so it lands at `at`', () => {
    const { kept, blow } = blowCut(root, clip, { at: 0.5, blowU: 0.75 })
    expect(blow).toBeCloseTo(0.75)
    expect(kept[0]).toBeCloseTo(0.5)
    expect(kept[1]).toBeCloseTo(1)
  })

  it('holds the end of a late blow when told', () => {
    const { clip: out } = blowCut(root, clip, { at: 0.5, blowU: 0.75, late: 'hold' })
    expect(out.duration).toBeCloseTo(1.5)
  })

  it('shortens the end of an early blow', () => {
    const { kept } = blowCut(root, clip, { at: 0.5, blowU: 0.25 })
    expect(kept).toEqual([0, 0.5])
  })
})

describe('cut and retime', () => {
  const clip = new THREE.AnimationClip('c', 1, [new THREE.NumberKeyframeTrack('Hips.position[x]', [0, 1], [0, 1])])

  it('keys a cut at both its ends', () => {
    const out = cut(clip, 0.25, 0.75)
    expect(out.duration).toBeCloseTo(0.5)
    expect(Array.from(out.tracks[0].times)).toEqual([0, 0.5])
    expect(Array.from(out.tracks[0].values)).toEqual([0.25, 0.75])
  })

  it('plays faster without changing the motion', () => {
    const out = retime(clip, 2)
    expect(out.duration).toBeCloseTo(0.5)
    expect(value(out, 'Hips.position[x]', 0.25)[0]).toBeCloseTo(0.5)
    expect(retime(clip, 1)).toBe(clip)
  })
})

describe('holdFist', () => {
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1)
  const pose = new Map([['RightHandIndex1', turn]])
  const clip = new THREE.AnimationClip('c', 1, [new THREE.QuaternionKeyframeTrack('RightHandIndex1.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])])

  it('holds the fist through a clip', () => {
    const out = holdFist(clip, pose)
    expect(value(out, 'RightHandIndex1.quaternion', 0.5)[2]).toBeCloseTo(turn.z)
  })

  it('opens to the clip\'s own hand inside an open window', () => {
    const out = holdFist(clip, pose, [[0.4, 0.6]])
    expect(value(out, 'RightHandIndex1.quaternion', 0.5)[3]).toBeCloseTo(1)
    expect(value(out, 'RightHandIndex1.quaternion', 0.1)[2]).toBeCloseTo(turn.z)
  })
})
