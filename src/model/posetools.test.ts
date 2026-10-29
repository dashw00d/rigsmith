import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { ClipKey, Quat } from './types.ts'
import type { KeyTrack } from './command-types.ts'
import { IDENTITY, resolveTime } from './timemap.ts'
import {
  angle, blendSeam, copyPose, easeOf, falloff, matchEnds, mirrorName, mirrorPose, mul, neighbours, pastePose, pushRelax, putKey, rangeWeight,
  reflect, seamJump, selectedBones, selectionRange, setEase, slerp, spreadChange, tween, valueAt, type Frames, type Pose, type PoseContext,
} from './posetools.ts'
import { keySampler } from '../engine/onion.ts'

const deg = Math.PI / 180
const about = (axis: [number, number, number], d: number): Quat => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), d * deg).toArray() as Quat
const ctx = (loop: boolean, frames = 30): PoseContext => ({ loop, time: IDENTITY, frame: 1 / frames, sample: keySampler })
const keysOf = (out: KeyTrack[], bone: string): ClipKey[] => (out.find(t => 'bone' in t && t.bone === bone)?.keys ?? [])
const I: Quat = [0, 0, 0, 1]

describe('mirrorName', () => {
  it('swaps sides on Mixamo and canonical names', () => {
    expect(mirrorName('LeftArm')).toBe('RightArm')
    expect(mirrorName('RightHandIndex1')).toBe('LeftHandIndex1')
    expect(mirrorName('mixamorig:LeftForeArm')).toBe('mixamorig:RightForeArm')
    expect(mirrorName('mixamorig1:RightUpLeg')).toBe('mixamorig1:LeftUpLeg')
    expect(mirrorName('upperarm_l')).toBe('upperarm_r')
    expect(mirrorName('hand.R')).toBe('hand.L')
  })
  it('keeps the middle', () => {
    for (const n of ['Hips', 'Spine2', 'Head', 'HeadTop_End', 'mixamorig:Neck']) expect(mirrorName(n)).toBe(n)
  })
})

describe('mirrorPose', () => {
  // (a symmetric rig whose sides have different own axes: the right arm's rest turned 180° about its bone)
  const frames: Frames = {
    Spine: { rest: I, parent: I },
    LeftArm: { rest: about([0, 0, 1], -90), parent: I },
    RightArm: { rest: mul(about([0, 0, 1], 90), about([0, 1, 0], 180)), parent: I },
  }
  it('mirrors world turns from rest whatever the bones\' own axes', () => {
    const raise = about([1, 0.3, 0.2], 50)
    const left = mul(raise, frames.LeftArm.rest)
    const m = mirrorPose({ LeftArm: { q: left } }, frames)
    const right = m.RightArm.q
    // world turn from rest: W R⁻¹ (parents at rest)
    const dl = mul(left, inv(frames.LeftArm.rest)); const dr = mul(right, inv(frames.RightArm.rest))
    expect(angle(dr, reflect(dl))).toBeLessThan(1e-9)
    expect(m.LeftArm).toBeUndefined()
  })
  it('mirrors a middle bone onto itself and twists it the other way', () => {
    const twist = about([0, 1, 0], 30)
    expect(angle(mirrorPose({ Spine: { q: twist } }, frames).Spine.q, about([0, 1, 0], -30))).toBeLessThan(1e-9)
  })
  it('reflects a place', () => {
    const m = mirrorPose({ Spine: { q: I, p: [0.2, 1, 0.3] } }, frames)
    expect(m.Spine.p![0]).toBeCloseTo(-0.2, 12); expect(m.Spine.p![1]).toBeCloseTo(1, 12); expect(m.Spine.p![2]).toBeCloseTo(0.3, 12)
  })
})

function inv (q: Quat): Quat { return [-q[0], -q[1], -q[2], q[3]] }

describe('copy and paste', () => {
  it('copies only the bones asked, deeply', () => {
    const pose: Pose = { A: { q: about([1, 0, 0], 10) }, B: { q: I } }
    const c = copyPose(pose, ['A', 'Z'])
    expect(Object.keys(c)).toEqual(['A'])
    pose.A.q[0] = 9
    expect(c.A.q[0]).not.toBe(9)
  })
  it('pastes the key that brings the clip to the pose at the new moment, pinning a first key', () => {
    const base: Pose = { A: { q: about([0, 1, 0], 20) } }
    const want = about([1, 0, 0], 40)
    const out = pastePose({}, { A: { q: want } }, 0.5, base, ctx(false))
    const ks = keysOf(out, 'A')
    expect(ks.map(k => k.u)).toEqual([0, 0.5, 1])
    expect(angle(mul(base.A.q, ks[1].q), want)).toBeLessThan(1e-5)
    expect(ks[0].q).toEqual(I)
    // (a loop pins only its start)
    expect(keysOf(pastePose({}, { A: { q: want } }, 0.5, base, ctx(true)), 'A').map(k => k.u)).toEqual([0, 0.5])
  })
  it('leaves an unkeyed bone already there alone', () => {
    const base: Pose = { A: { q: about([0, 1, 0], 20) } }
    expect(pastePose({}, { A: { q: base.A.q } }, 0.5, base, ctx(false))).toEqual([])
  })
  it('pastes the Hips\' height, not where it stands', () => {
    const frames: Frames = { Hips: { rest: I, parent: I } }
    const base: Pose = { Hips: { q: I, p: [1, 0.9, 2] } }
    const out = pastePose({}, { Hips: { q: I, p: [0, 0.7, 0] } }, 0.25, base, ctx(true), { frames })
    expect(keysOf(out, 'Hips')[1].p).toEqual([0, -0.2, 0])
    const all = pastePose({}, { Hips: { q: I, p: [0, 0.7, 0] } }, 0.25, base, ctx(true), { frames, place: 'all' })
    expect(keysOf(all, 'Hips')[1].p).toEqual([-1, -0.2, -2])
  })
  it('replaces a key at the moment, keeping its ease', () => {
    const keys: ClipKey[] = [{ u: 0, q: I }, { u: 0.5, q: I, ease: 'linear' }, { u: 1, q: I }]
    const out = putKey(keys, { u: 0.5, q: about([1, 0, 0], 10) }, ctx(false))
    expect(out).toHaveLength(3)
    expect(out[1].ease).toBe('linear')
  })
  it('a key dropped in a held span holds too', () => {
    const keys: ClipKey[] = [{ u: 0, q: I, ease: 'hold' }, { u: 1, q: I }]
    expect(putKey(keys, { u: 0.5, q: I }, ctx(false))[1].ease).toBe('hold')
  })
})

describe('tween, push, relax', () => {
  const a = about([1, 0, 0], 10); const b = about([1, 0, 0], 50)
  const tracks = { A: [{ u: 0.2, q: a }, { u: 0.5, q: I }, { u: 0.8, q: b }] as ClipKey[] }
  it('at 0 and 1 is the neighbours', () => {
    expect(angle(keysOf(tween(tracks, ['A'], 0.5, 0, ctx(false)), 'A')[1].q, a)).toBeLessThan(1e-5)
    expect(angle(keysOf(tween(tracks, ['A'], 0.5, 1, ctx(false)), 'A')[1].q, b)).toBeLessThan(1e-5)
    expect(angle(keysOf(tween(tracks, ['A'], 0.5, 0.25, ctx(false)), 'A')[1].q, about([1, 0, 0], 20))).toBeLessThan(1e-5)
  })
  it('makes a key between two when there is none', () => {
    const t = { A: [{ u: 0.2, q: a }, { u: 0.8, q: b }] as ClipKey[] }
    const ks = keysOf(tween(t, ['A'], 0.4, 0.5, ctx(false)), 'A')
    expect(ks.map(k => k.u)).toEqual([0.2, 0.4, 0.8])
    expect(angle(ks[1].q, about([1, 0, 0], 30))).toBeLessThan(1e-5)
  })
  it('wraps round a loop', () => {
    const n = neighbours(tracks.A, 0.9, true)!
    expect(n.prev.u).toBe(0.8); expect(n.next.u).toBe(0.2); expect(n.wrap.next).toBe(true)
    expect(neighbours(tracks.A, 0.9, false)!.next.u).toBe(0.8)
  })
  it('relax -1 is the even inbetween; push runs past the key', () => {
    // (inbetween of 10° at 0.2 and 50° at 0.8, at 0.5: 30°)
    const relaxed = keysOf(pushRelax(tracks, ['A'], 0.5, -1, ctx(false)), 'A')[1].q
    expect(angle(relaxed, about([1, 0, 0], 30))).toBeLessThan(1e-5)
    const pushed = keysOf(pushRelax(tracks, ['A'], 0.5, 0.5, ctx(false)), 'A')[1].q
    // (the key 0°, 30° from the inbetween: half as far again, -15°)
    expect(angle(pushed, about([1, 0, 0], -15))).toBeLessThan(1e-5)
  })
  it('leaves an unkeyed bone alone', () => {
    expect(tween(tracks, ['B'], 0.5, 0.5, ctx(false))).toEqual([])
  })
})

describe('range edit', () => {
  it('falls off linearly or smoothly', () => {
    expect(falloff(0.5, 'linear')).toBe(0.5)
    expect(falloff(0.5, 'smooth')).toBe(0.5)
    expect(falloff(0.25, 'smooth')).toBeCloseTo(0.15625, 12)
    expect(falloff(0.25, 'linear')).toBe(0.25)
    expect(rangeWeight(0.4, [0.2, 0.8], 0.4, 'smooth')).toBe(1)
    expect(rangeWeight(0.2, [0.2, 0.8], 0.4, 'smooth')).toBe(0)
    expect(rangeWeight(0.3, [0.2, 0.8], 0.4, 'linear')).toBeCloseTo(0.5, 12)
    expect(rangeWeight(0.6, [0.2, 0.8], 0.4, 'linear')).toBeCloseTo(0.5, 12)
    expect(rangeWeight(0.9, [0.2, 0.8], 0.4, 'linear')).toBe(0)
  })
  it('spreads a change over the range by the falloff, the track outside as it was', () => {
    const before = { A: [{ u: 0, q: I }, { u: 0.1, q: about([0, 1, 0], 5) }, { u: 1, q: I }] as ClipKey[] }
    const change = about([1, 0, 0], 40)
    const after = { A: putKey(before.A, { u: 0.5, q: change }, ctx(false)) }
    for (const kind of ['linear', 'smooth'] as const) {
      const ks = keysOf(spreadChange(before, after, ['A'], 0.5, [0.3, 0.9], kind, ctx(false, 60)), 'A')
      expect(ks.filter(k => k.u < 0.3 - 1e-9)).toEqual(before.A.slice(0, 2))
      expect(ks.find(k => k.u === 1)).toEqual(before.A[2])
      // (the change: from what the track gave at 0.5 to the key put there)
      const turn = mul(inv(valueAt(before.A, 0.5, ctx(false)).q), change)
      for (const k of ks.filter(k => k.u >= 0.3 && k.u <= 0.9)) {
        const w = rangeWeight(k.u, [0.3, 0.9], 0.5, kind)
        const was = valueAt(before.A, k.u, ctx(false))
        expect(angle(k.q, slerp(was.q, mul(was.q, turn), w))).toBeLessThan(1e-5)
      }
      // (all of it at the moment changed, none at the ends; a few frames keyed between)
      expect(angle(ks.find(k => Math.abs(k.u - 0.5) < 1e-9)!.q, change)).toBeLessThan(1e-5)
      expect(ks.filter(k => k.u > 0.3 && k.u < 0.5).length).toBe(3)
      expect(ks.filter(k => k.u > 0.5 && k.u < 0.9).length).toBe(3)
    }
  })
  it('leaves bones that didn\'t change', () => {
    const t = { A: [{ u: 0, q: I }, { u: 1, q: I }] as ClipKey[] }
    expect(spreadChange(t, t, ['A'], 0.5, [0.2, 0.8], 'smooth', ctx(false))).toEqual([])
  })
  it('works in source time through a retimed clip', () => {
    // (played twice as fast in its second half: markers 0.5 -> 0.75)
    const time = resolveTime({ seconds: 1, speed: 1, time: { markers: [{ id: 'm', u: 0.5, to: 0.75 }] } })
    const c: PoseContext = { ...ctx(false), time }
    const before = { A: [] as ClipKey[] }
    const after = { A: putKey([], { u: 0.5, q: about([1, 0, 0], 40) }, c) }
    const ks = keysOf(spreadChange(before, after, ['A'], 0.5, [0.2, 0.8], 'linear', c), 'A')
    for (const k of ks) {
      const w = rangeWeight(time.toPlayed(k.u), [time.toPlayed(0.2), time.toPlayed(0.8)], time.toPlayed(0.5), 'linear')
      expect(angle(k.q, about([1, 0, 0], 40 * w))).toBeLessThan(1e-5)
    }
  })
})

describe('the loop\'s seam', () => {
  const first: Pose = { A: { q: about([1, 0, 0], 0) }, B: { q: I } }
  const last: Pose = { A: { q: about([1, 0, 0], 12) }, B: { q: I } }
  it('measures the jump per bone', () => {
    const s = seamJump(first, last)
    expect(s.bones.A / deg).toBeCloseTo(12, 9)
    expect(s.bones.B).toBe(0)
    expect(s.worst?.bone).toBe('A')
  })
  it('match ends keys the last frame to the first', () => {
    // (the clip before keys turns A 12° by its end; a key mid-clip)
    const tracks = { A: [{ u: 0.5, q: about([0, 1, 0], 10) }] as ClipKey[] }
    const base: Pose = { A: { q: about([1, 0, 0], 12) } }
    const firstShown: Pose = { A: { q: mul(I, valueAt(tracks.A, 0, ctx(true)).q) } }
    const ks = keysOf(matchEnds(tracks, ['A'], { first: firstShown, base }, ctx(true)), 'A')
    expect(ks.map(k => k.u)).toEqual([0, 0.5, 1])
    // (the start kept where it was, the end shown as the start)
    expect(angle(valueAt(ks, 0, ctx(true)).q, firstShown.A.q)).toBeLessThan(1e-5)
    expect(angle(mul(base.A.q, valueAt(ks, 1, ctx(true)).q), firstShown.A.q)).toBeLessThan(1e-5)
  })
  it('blend meets in the middle and fades over the frames', () => {
    const ks = keysOf(blendSeam({}, ['A'], { first, last, frames: 6 }, ctx(true, 30)), 'A')
    const shownAt = (u: number, clip: Quat): Quat => mul(clip, valueAt(ks, u, ctx(true)).q)
    const end = shownAt(1, last.A.q); const start = shownAt(0, first.A.q)
    expect(angle(end, start)).toBeLessThan(1e-5)
    expect(angle(end, about([1, 0, 0], 6))).toBeLessThan(1e-5)
    // (nothing moves outside the six frames each side)
    expect(angle(valueAt(ks, 0.5, ctx(true)).q, I)).toBeLessThan(1e-6)
    expect(Math.min(...ks.filter(k => k.u > 0.5).map(k => k.u))).toBeCloseTo(1 - 6 / 30, 9)
    expect(Math.max(...ks.filter(k => k.u < 0.5).map(k => k.u))).toBeCloseTo(6 / 30, 9)
  })
})

describe('easing', () => {
  const bones = { A: [{ u: 0, q: I }, { u: 0.5, q: I, ease: 'step' as const }, { u: 1, q: I }] }
  const gear = { g1: [{ u: 0.2, q: I }] }
  it('sets the selected keys\' spans, smooth unsetting', () => {
    const out = setEase(bones, gear, [{ track: 'body:A', u: 0 }, { track: 'gear:g1', u: 0.2 }], 'hold')
    expect(out).toEqual([{ bone: 'A', keys: [{ u: 0, q: I, ease: 'hold' }, bones.A[1], bones.A[2]] }, { gear: 'g1', keys: [{ u: 0.2, q: I, ease: 'hold' }] }])
    expect(setEase(bones, gear, [{ track: 'body:A', u: 0.5 }], 'smooth')[0]).toEqual({ bone: 'A', keys: [bones.A[0], { u: 0.5, q: I }, bones.A[2]] })
    expect(setEase(bones, gear, [{ track: 'body:A', u: 0.5 }], 'step')).toEqual([])
  })
  it('reads the ease the selection shares', () => {
    expect(easeOf(bones, gear, [{ track: 'body:A', u: 0.5 }])).toBe('step')
    expect(easeOf(bones, gear, [{ track: 'body:A', u: 0.5 }, { track: 'body:A', u: 1 }])).toBe('mixed')
    expect(easeOf(bones, gear, [])).toBeNull()
  })
})

describe('the selection', () => {
  const sel = [{ track: 'body:LeftArm', id: '0.2', u: 0.2 }, { track: 'body:LeftArm', id: '0.6', u: 0.6 }, { track: 'events', id: 'e1', u: 0.4 }]
  it('reads bones and range', () => {
    expect(selectedBones(sel)).toEqual(['LeftArm'])
    expect(selectionRange(sel)).toEqual([0.2, 0.6])
    expect(selectionRange([sel[0]])).toBeNull()
  })
})
