import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { edgesOf, fitMarkers, insideDepth, jointsFrom, markerRay, pinsOf, placeMarker, seed, solve, useMarkerSets, type MarkerSet, type V3 } from './markers.ts'
import { hierarchy } from './mixamo.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const json = JSON.parse(readFileSync(path.join(ROOT, 'static', 'templates', 'markers.json'), 'utf8')) as Record<string, MarkerSet>
useMarkerSets(json)
const horse = JSON.parse(readFileSync(path.join(ROOT, 'static', 'templates', 'horse.json'), 'utf8')) as { joints: Record<string, V3>, parents: Record<string, string | null> }
const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('markers', () => {
  it('picks the hand inside the camera slab and excludes the leg behind it', () => {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 2.6, 3.4)
    camera.position.z = 3
    camera.updateMatrixWorld()
    const hand = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    const leg = hand.clone(); leg.position.z = -1
    hand.updateMatrixWorld(); leg.updateMatrixWorld()
    const ray = new THREE.Raycaster()
    markerRay(ray, camera, new THREE.Vector2(0, 0))
    const hits = ray.intersectObjects([hand, leg])
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits.every(h => h.object === hand)).toBe(true)
    expect(insideDepth(hits.map(h => h.distance))).toBeCloseTo(3, 6)
  })

  it('keeps later fine joint edits when reopening saved markers', () => {
    const m = seed('horse', json.horse, horse.joints)
    const edited = { ...jointsFrom(json.horse, m, horse.parents, 0) }
    edited.head = [edited.head[0], edited.head[1] + 0.04, edited.head[2]]
    const fitted = fitMarkers('horse', json.horse, m, edited, horse.parents)
    expect(jointsFrom(json.horse, fitted, horse.parents, 0).head).toEqual(edited.head)
  })

  it('carries finger tips with a moved wrist, mirrors the other hand, and preserves finger lengths', () => {
    const J: Record<string, V3> = { LeftForeArm: [0.2, 1, 0], LeftHand: [0.4, 1, 0], LeftHandIndex4: [0.5, 1, 0],
      RightForeArm: [-0.2, 1, 0], RightHand: [-0.4, 1, 0], RightHandIndex4: [-0.5, 1, 0] }
    const m = seed('human', json.human, J)
    const moved = placeMarker(json.human, m, 'wrist_l', [0.2, 1.2, 0], 0, true)
    expect(dist(moved.positions.index_tip_l, [0.2, 1.3, 0])).toBeLessThan(1e-9)
    expect(dist(moved.positions.index_tip_r, [-0.2, 1.3, 0])).toBeLessThan(1e-9)
    const tip = placeMarker(json.human, moved, 'index_tip_l', [0.3, 1.4, 0], 0, false)
    expect(tip.positions.wrist_l).toEqual(moved.positions.wrist_l)
    expect(tip.positions.index_tip_r).toEqual(moved.positions.index_tip_r)
  })

  it('fits the whole finger to its tip instead of bending only the last joint', () => {
    const J: Record<string, V3> = { LeftHand: [0, 0, 0], LeftHandIndex1: [0, 0.5, 0], LeftHandIndex2: [0, 0.7, 0],
      LeftHandIndex3: [0, 0.85, 0], LeftHandIndex4: [0, 1, 0] }
    const set: MarkerSet = { view: 'front', markers: json.human.markers.filter(d => ['wrist', 'index_tip'].includes(d.id)) }
    const m = seed('human', set, J)
    m.positions.index_tip_l = [1, 1, 0]
    const out = jointsFrom(set, m, Object.fromEntries(hierarchy('full')), 0)
    expect(dist(out.LeftHandIndex1, [0.5, 0.5, 0])).toBeLessThan(1e-6)
    expect(dist(out.LeftHandIndex3, [0.85, 0.85, 0])).toBeLessThan(1e-6)
    expect(out.LeftHandIndex4).toEqual([1, 1, 0])
  })

  it('moves a former mitten chain under its placed index tip on a full hand', () => {
    const J: Record<string, V3> = { LeftHand: [0, 0, 0], LeftHandIndex1: [0, 0.5, 0], LeftHandIndex2: [0, 0.7, 0],
      LeftHandIndex3: [0, 0.85, 0], LeftHandIndex4: [-0.3, 1, 0], LeftHandMiddle4: [0, 1.1, 0],
      LeftHandRing4: [0.15, 1, 0], LeftHandPinky4: [0.3, 0.9, 0] }
    const m = seed('human', json.human, J)
    m.positions.index_tip_l = [-0.31, 1, 0.02]
    const out = jointsFrom(json.human, m, Object.fromEntries(hierarchy('full')), 0)
    for (let i = 1; i <= 3; i++) expect(Math.abs(out[`LeftHandIndex${i}`][0] + 0.31)).toBeLessThan(0.03)
    expect(out.LeftHandIndex4).toEqual(m.positions.index_tip_l)
    expect(out.LeftHandMiddle4).toEqual(J.LeftHandMiddle4)
  })

  it('lays a full hand as the detection does when a tip moves: knuckles in proportion, evenly spaced, fingers straight', () => {
    // (a hand along +y; knuckles squeezed out by the tips, the ring's crowded against the pinky's)
    const xs: Record<string, number> = { Index: -0.3, Middle: -0.1, Ring: 0.1, Pinky: 0.3 }
    const J: Record<string, V3> = { LeftForeArm: [0, -1, 0], LeftHand: [0, 0, 0] }
    for (const [f, x] of Object.entries(xs)) {
      const kx = f === 'Ring' ? 0.28 : x
      J[`LeftHand${f}1`] = [kx, 0.85, 0]; J[`LeftHand${f}2`] = [x, 0.9, 0]; J[`LeftHand${f}3`] = [x, 0.95, 0]; J[`LeftHand${f}4`] = [x, 1, 0]
    }
    const m = seed('human', json.human, J)
    m.positions.middle_tip_l = [-0.1, 1.05, 0]
    const out = jointsFrom(json.human, m, Object.fromEntries(hierarchy('full')), 0)
    // knuckles: no further out than ~57% of the tip's reach, the four evenly across
    for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) expect(out[`LeftHand${f}1`][1]).toBeLessThan(0.62)
    const ks = ['Index', 'Middle', 'Ring', 'Pinky'].map(f => out[`LeftHand${f}1`][0])
    expect(ks[1] - ks[0]).toBeCloseTo(ks[2] - ks[1], 6)
    expect(ks[2] - ks[1]).toBeCloseTo(ks[3] - ks[2], 6)
    // each finger straight from its knuckle to its tip, the moved tip where it was put
    expect(out.LeftHandMiddle4).toEqual([-0.1, 1.05, 0])
    for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
      const [k, a, b, t] = [1, 2, 3, 4].map(i => new THREE.Vector3(...out[`LeftHand${f}${i}`]))
      const line = new THREE.Line3(k, t)
      for (const p of [a, b]) expect(line.closestPointToPoint(p, false, new THREE.Vector3()).distanceTo(p)).toBeLessThan(1e-9)
    }
  })

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
