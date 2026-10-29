// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { makeCharacter, makeGear, makeSlot } from './fixtures.ts'
import { rescale } from './rescale.ts'
import type { Character } from './types.ts'

const fixture = (): Character => makeCharacter({
  source: { scale: 1.5 },
  skeleton: {
    detected: { Hips: [0, 1, 0] }, imported: { Hips: [0, 1, 0.5] }, overrides: { Head: [0, 2, 0] },
    stale: [{ joint: 'LeftHandIndex1', at: [1, 1, 1], reason: 'finger level', template: 'human', level: 'two' }],
    markers: { set: 'human', base: { Hips: [0, 1, 0] }, positions: { hips: [0, 1.25, 0] } },
  },
  skin: { locked: false, rigJoints: { Hips: [0, 1, 0] } },
  gear: [
    makeGear({
      id: 'bow', attach: { kind: 'bone', bone: 'LeftHand', place: { position: [1, 1, 0], rotation: [0, 90, 0], scale: 2 } },
      handles: [
        { id: 'carry', name: 'Carried', kind: 'carry', hand: 'Left', place: { position: [0, 0.1, 0], rotation: [0, 0, 0, 1] } },
        { id: 'grip', name: 'Grip', kind: 'grip', place: { position: [0, 0.3, 0], rotation: [0, 0, 0, 1] } },
        { id: 'draw', name: 'Draw', kind: 'pull', hand: 'Right', pull: { bone: 'RightHand', grip: [0, 0.1, 0], rest: [0.2, 0.4, 0] } },
      ],
    }),
    makeGear({ id: 'pouch', attach: { kind: 'spot', place: { position: [0, 1, 0.1], rotation: [0, 0, 0], scale: 1 }, anchor: [0, 1, 0.1] } }),
    makeGear({ id: 'spear', catalog: 'spear_A.glb', attach: { kind: 'bone', bone: 'RightHand', place: { position: [0.1, 0.5, 0], rotation: [-80, 0, 0], scale: 0.62 }, legacyFrame: 'grip' } }),
  ],
  clips: [makeSlot({
    adjustments: [{ id: 'g', enabled: true, kind: 'ground', lift: 0.1 }],
    bones: { Hips: [{ u: 0, q: [0, 0, 0, 1], p: [0, 1, 0] }], Spine: [{ u: 0, q: [0, 0, 0, 1] }], root: [{ u: 0, q: [0, 0, 0, 1], p: [0, 0, 0.5] }, { u: 1, q: [0, 0, 0, 1], p: [0, 0, 1] }] },
    gear: { bow: { keys: [{ u: 0, q: [0, 0, 0, 1], p: [0, 0.2, 0] }] } },
  })],
  mount: { character: 'horse-1', bone: 'spine_3', position: [0, 0.5, 0], rotation: [0, 0, 0], freeze: [], pose: {}, hips: [0, 1, 0] },
})

describe('rescale', () => {
  it('scales and moves every position and scales every length', () => {
    const c = fixture()
    const before = structuredClone(c)
    const r = rescale(c, 2, [0, -0.5, 0])
    expect(c).toEqual(before)

    expect(r.source.scale).toBe(3)
    expect(r.source.stats?.height).toBe(3.6)
    expect(r.skeleton.detected).toEqual({ Hips: [0, 1.5, 0] })
    expect(r.skeleton.imported).toEqual({ Hips: [0, 1.5, 1] })
    expect(r.skeleton.overrides).toEqual({ Head: [0, 3.5, 0] })
    expect(r.skeleton.stale?.[0].at).toEqual([2, 1.5, 2])
    expect(r.skeleton.markers).toEqual({ set: 'human', base: { Hips: [0, 1.5, 0] }, positions: { hips: [0, 2, 0] } })
    expect(r.skin.rigJoints).toEqual({ Hips: [0, 1.5, 0] })

    const [bow, pouch, spear] = r.gear
    expect(bow.attach.place).toEqual({ position: [2, 1.5, 0], rotation: [0, 90, 0], scale: 4 })
    expect(bow.handles[2].pull).toEqual({ bone: 'RightHand', grip: [0, 0.2, 0], rest: [0.2, 0.4, 0] })
    expect(pouch.attach).toMatchObject({ place: { position: [0, 1.5, 0.2], scale: 2 }, anchor: [0, 1.5, 0.2] })
    // (still in the old grip frame: its position is in bone lengths, which grow with the bones; its size is not)
    expect(spear.attach).toEqual({ kind: 'bone', bone: 'RightHand', place: { position: [0.1, 0.5, 0], rotation: [-80, 0, 0], scale: 1.24 }, legacyFrame: 'grip' })

    expect(r.clips[0].adjustments[0]).toMatchObject({ lift: 0.2 })
    // (every bone's moves, not only the Hips': a horse keys its root)
    expect(r.clips[0].bones).toMatchObject({ Hips: [{ p: [0, 2, 0] }], root: [{ p: [0, 0, 1] }, { p: [0, 0, 2] }] })
    expect(r.clips[0].gear).toEqual({ bow: { keys: [{ u: 0, q: [0, 0, 0, 1], p: [0, 0.2, 0] }] } })

    expect(r.mount?.hips).toEqual([0, 2, 0])
  })

  it('leaves handle places, gear keys and the seat on the horse as they are', () => {
    const c = fixture()
    const r = rescale(c, 2, [0, -0.5, 0])
    expect(r.gear[0].handles.map(h => h.place)).toEqual(c.gear[0].handles.map(h => h.place))
    expect(r.mount?.position).toEqual([0, 0.5, 0])
    expect(r.clips[0].bones).toMatchObject({ Spine: [{ u: 0, q: [0, 0, 0, 1] }] })
  })
})
