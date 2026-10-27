import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { edgesOf, fitMarkers, jointsFrom, pinsOf, seed, solve, useMarkerSets, type MarkerSet, type V3 } from './markers.ts'
import { hierarchy } from './mixamo.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const json = JSON.parse(readFileSync(path.join(ROOT, 'static', 'templates', 'markers.json'), 'utf8')) as Record<string, MarkerSet>
useMarkerSets(json)
const horse = JSON.parse(readFileSync(path.join(ROOT, 'static', 'templates', 'horse.json'), 'utf8')) as { joints: Record<string, V3>, parents: Record<string, string | null> }
const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('markers', () => {
  it('give back the skeleton they were seeded from when left alone', () => {
    const m = seed('horse', json.horse, horse.joints)
    const out = jointsFrom(json.horse, m, horse.parents, 0)
    // (within the template's own left-right mismatch: the far side is the near side mirrored)
    for (const [k, p] of Object.entries(horse.joints)) expect(dist(out[k], p)).toBeLessThan(1e-4)
  })

  it('spread a stretched chain evenly between its pins', () => {
    const base: Record<string, V3> = { a: [0, 0, 0], b: [0, 1, 0], c: [0, 2, 0] }
    const out = solve(base, [['b', 'a'], ['c', 'b']], new Map<string, V3>([['a', [0, 0, 0]], ['c', [0, 3, 0]]]))
    expect(out.b[1]).toBeCloseTo(1.5, 3)
  })

  it('carry the rest of a leg with a moved hoof, mirrored on the far side, leaving the hind legs', () => {
    const m = seed('horse', json.horse, horse.joints)
    const hoof = m.positions.front_hoof
    m.positions.front_hoof = [hoof[0], hoof[1] - 0.05, hoof[2]]
    const out = jointsFrom(json.horse, m, horse.parents, 0)
    // the hoof's leaf below it moves with it
    expect(out.front_leg_leaf_l[1]).toBeCloseTo(horse.joints.front_leg_leaf_l[1] - 0.05, 2)
    expect(out.front_leg_foot_r[1]).toBeCloseTo(hoof[1] - 0.05, 6)
    expect(out.front_leg_foot_r[0]).toBeCloseTo(-hoof[0], 6)
    expect(dist(out.back_leg_toe_l, horse.joints.back_leg_toe_l)).toBeLessThan(1e-4)
    expect(dist(out.back_leg_leaf_l, horse.joints.back_leg_leaf_l)).toBeLessThan(2e-3)
  })

  it('tie a marker of its own (the groin) to the joints it names', () => {
    const joints: Record<string, V3> = { Hips: [0, 1, 0], LeftUpLeg: [0.1, 0.95, 0], RightUpLeg: [-0.1, 0.95, 0], LeftLeg: [0.1, 0.5, 0], RightLeg: [-0.1, 0.5, 0] }
    const parents = { Hips: null, LeftUpLeg: 'Hips', RightUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', RightLeg: 'RightUpLeg' }
    const set: MarkerSet = { view: 'front', markers: json.human.markers.filter(d => ['groin', 'knee'].includes(d.id)) }
    const m = seed('human', set, joints, () => [0, 0.9, 0])
    expect(edgesOf(set, parents, m.base).filter(e => e[0] === 'marker:groin')).toHaveLength(3)
    m.positions.groin = [0, 0.8, 0]
    const pins = pinsOf(set, m, 0)
    expect(pins.get('marker:groin')).toEqual([0, 0.8, 0])
    const out = jointsFrom(set, m, parents, 0)
    // the hips and the tops of the legs come down with the groin (the knees pinned where they were)
    expect(out.Hips[1]).toBeLessThan(0.95)
    expect(out.LeftUpLeg[1]).toBeLessThan(0.9)
    expect(out.LeftLeg[1]).toBeCloseTo(0.5, 6)
  })

  it('placed on a two-finger hand, give all five tips once the hand has five fingers, and none it has lost', () => {
    const full = Object.fromEntries(hierarchy('full')) as Record<string, string | null>
    const two = Object.fromEntries(hierarchy('two')) as Record<string, string | null>
    // (a skeleton of every bone, each a little out from its parent)
    const place = (parents: Record<string, string | null>): Record<string, V3> => {
      const out: Record<string, V3> = {}
      const at = (n: string): V3 => { if (out[n] === undefined) { const p = parents[n]; const q = p === null || p === undefined ? [0, 1, 0] as V3 : at(p); out[n] = [q[0] + 0.01 * (n.length % 5), q[1] - 0.02, q[2] + 0.001 * n.length] } return out[n] }
      for (const n of Object.keys(parents)) at(n)
      return out
    }
    const jointsTwo = place(two); const jointsFull = { ...place(full), ...jointsTwo }
    const saved = seed('human', json.human, jointsTwo)
    // (the hand moved since they were placed: the new fingers' rest moves back with it)
    saved.base.LeftHand = [saved.base.LeftHand[0] + 0.1, saved.base.LeftHand[1], saved.base.LeftHand[2]]
    const tips = (m: { positions: Record<string, V3> }): string[] => Object.keys(m.positions).filter(k => k.includes('_tip_')).sort()
    expect(tips(saved)).toEqual(['index_tip_l', 'index_tip_r', 'thumb_tip_l', 'thumb_tip_r'])
    const fitted = fitMarkers('human', json.human, saved, jointsFull, full)
    expect(tips(fitted)).toHaveLength(10)
    expect(fitted.positions.middle_tip_l).toEqual(jointsFull.LeftHandMiddle4)
    expect(fitted.base.LeftHandMiddle1[0]).toBeCloseTo(jointsFull.LeftHandMiddle1[0] + 0.1, 9)
    // the skeleton the markers make has every bone of the five-finger hand
    expect(Object.keys(jointsFrom(json.human, fitted, full, 0)).sort()).toEqual(Object.keys(jointsFull).sort())
    // and back to two fingers: the lost fingers' tips and bones leave
    const back = fitMarkers('human', json.human, fitted, jointsTwo, two)
    expect(tips(back)).toHaveLength(4)
    expect(Object.keys(jointsFrom(json.human, back, two, 0)).sort()).toEqual(Object.keys(jointsTwo).sort())
  })
})
