import { describe, expect, it } from 'vitest'
import { crossed, findLayerPairs, keepPair, limbOf } from './layers.ts'

// Two parallel sheets a tenth of the height apart: a body sheet (facing +z, bone 1: a thigh) and a coat sheet over it
// (z = 0.1, facing +z, bone 0: the hips), each a 4x4 grid of quads, plus a far post so the height is 1.
function sheets (): { positions: number[], triangles: number[], bone: number[] } {
  const positions: number[] = [], triangles: number[] = [], bone: number[] = []
  for (const [z, b] of [[0, 1], [0.1, 0]] as const) {
    const base = positions.length / 3
    for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) { positions.push(x * 0.1, y * 0.1, z); bone.push(b) }
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const i = base + y * 5 + x
        triangles.push(i, i + 1, i + 6, i, i + 6, i + 5)
      }
    }
  }
  const post = positions.length / 3
  positions.push(2, 0, -2, 2.01, 1, -2, 2, 1, -2.01)
  triangles.push(post, post + 1, post + 2)
  bone.push(1, 1, 1)
  return { positions, triangles, bone }
}
const names = ['Hips', 'LeftUpLeg']
const parents = [-1, 0]

describe('layer pairs', () => {
  it('limbs: the trunk, a leg, an arm', () => {
    expect(limbOf(['Hips', 'Spine', 'LeftShoulder', 'LeftArm', 'LeftHand', 'LeftUpLeg', 'LeftFoot'], [-1, 0, 1, 2, 3, 0, 5]))
      .toEqual(['trunk', 'trunk', 'LeftArm', 'LeftArm', 'LeftArm', 'LeftUpLeg', 'LeftUpLeg'])
    expect(keepPair('trunk', 'LeftUpLeg')).toBe(true)
    expect(keepPair('LeftUpLeg', 'LeftUpLeg')).toBe(true)
    expect(keepPair('LeftUpLeg', 'RightUpLeg')).toBe(false)
    expect(keepPair('LeftArm', 'trunk')).toBe(false)
  })
  it('finds the coat over the thigh, at its rest gap', () => {
    const { positions, triangles, bone } = sheets()
    const pairs = findLayerPairs(positions, triangles, bone, names, parents, 0.15)
    expect(pairs.point.length).toBeGreaterThanOrEqual(9)
    for (let k = 0; k < pairs.point.length; k++) {
      expect(pairs.gap[k]).toBeCloseTo(0.1)
      expect(crossed(positions, pairs, k, 1)).toBe(false)
    }
    // out of reach: none
    expect(findLayerPairs(positions, triangles, bone, names, parents, 0.05).point.length).toBe(0)
  })
  it('counts a point pushed behind the layer it covered, not one slid off it', () => {
    const { positions, triangles, bone } = sheets()
    const pairs = findLayerPairs(positions, triangles, bone, names, parents, 0.15)
    const coat = Array.from(pairs.point).filter(p => positions[p * 3 + 2] > 0.05)
    expect(coat.length).toBeGreaterThan(0)
    // the thigh comes up through the coat: every body point a fifth of the height forward
    const posed = positions.slice()
    for (let i = 0; i < 25; i++) posed[i * 3 + 2] += 0.2
    for (let k = 0; k < pairs.point.length; k++) if (positions[pairs.point[k] * 3 + 2] > 0.05) expect(crossed(posed, pairs, k, 1)).toBe(true)
    // the coat slid far off sideways: no longer over it, not counted
    const away = positions.slice()
    for (let i = 25; i < 50; i++) { away[i * 3] += 1.5; away[i * 3 + 2] -= 0.3 }
    for (let k = 0; k < pairs.point.length; k++) if (positions[pairs.point[k] * 3 + 2] > 0.05) expect(crossed(away, pairs, k, 1)).toBe(false)
  })
})
