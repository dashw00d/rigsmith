import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { UnitSpec } from '../model/unit.ts'
import { companionFor, mountHeights, repeat, riderScale, seatMatrix } from './mount.ts'

const units: Record<string, UnitSpec> = {
  knight: { character: 'knight-1', height: 2, budget: 8000, clips: [], companion: { character: 'horse-1', height: 2.3, prefix: 'Horse_', budget: 7000, material: 'horse', ridden: true } },
  pony: { character: 'pony-1', height: 1.6, budget: 5000, clips: [] },
}

describe('riding sizes', () => {
  it("take the rider's unit height and its companion's when that is his horse", () => {
    expect(mountHeights(units, 'knight-1', 'horse-1')).toEqual({ rider: 2, horse: 2.3 })
    // (another horse: its own unit's height, else none)
    expect(mountHeights(units, 'knight-1', 'pony-1')).toEqual({ rider: 2, horse: 1.6 })
    expect(mountHeights(units, 'knight-1', 'mule-1')).toEqual({ rider: 2, horse: null })
    expect(mountHeights(units, 'nobody', 'horse-1')).toEqual({ rider: null, horse: null })
    expect(mountHeights(units, 'knight-1', undefined)).toEqual({ rider: 2, horse: null })
  })

  it('size him from the game heights, else the mount scale', () => {
    expect(riderScale({}, { game: 2, own: 1 }, { game: 2.3, own: 2.3 })).toBeCloseTo(2)
    expect(riderScale({ scale: 0.8 }, { game: null, own: 1 }, { game: 2.3, own: 2.3 })).toBe(0.8)
    expect(riderScale({}, { game: null, own: 1 }, { game: null, own: 1 })).toBe(1)
  })

  it('places his rest space by the seat', () => {
    const m = seatMatrix({ position: [1, 2, 3], rotation: [0, 90, 0] }, 2)
    const p = new THREE.Vector3(1, 0, 0).applyMatrix4(m)
    expect(p.x).toBeCloseTo(1)
    expect(p.y).toBeCloseTo(2)
    expect(p.z).toBeCloseTo(1)
  })
})

describe('the companion entry', () => {
  it('a new horse gets the game horse defaults, named after it', () => {
    expect(companionFor({ id: 'raider-horse-1', name: 'Raider Horse' }, true)).toEqual({
      character: 'raider-horse-1', height: 2.3, prefix: 'Horse_', budget: 7000, material: 'raider_horse', ridden: true,
    })
    expect(companionFor({ id: 'p', name: 'Pack Pony' }, false)).toEqual({ character: 'p', height: 2.3, prefix: 'Pony_', budget: 7000, material: 'pack_pony' })
  })

  it("keeps what the unit's companion had; another horse gets its own surface", () => {
    const was = { ...units.knight.companion!, at: [1, 2] as [number, number] }
    expect(companionFor({ id: 'horse-1', name: 'Whatever' }, true, was)).toEqual(was)
    const other = companionFor({ id: 'horse-2', name: 'Grey Horse' }, false, was)
    expect(other).toEqual({ ...was, character: 'horse-2', material: 'grey_horse', ridden: undefined })
    expect('ridden' in other).toBe(false)
  })
})

describe('repeat', () => {
  it('plays a clip over several times, a shared key kept once', () => {
    const clip = new THREE.AnimationClip('a', 1, [new THREE.NumberKeyframeTrack('x.morphTargetInfluences[0]', [0, 1], [0, 1])])
    const twice = repeat(clip, 2)
    expect(twice.duration).toBe(2)
    expect([...twice.tracks[0].times]).toEqual([0, 1, 2])
  })
})
