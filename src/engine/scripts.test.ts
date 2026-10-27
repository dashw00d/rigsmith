import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { blowCut } from './scripts.ts'

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
})
