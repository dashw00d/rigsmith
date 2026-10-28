// @vitest-environment node
// The gear fit's curve and keys (src/engine/propfit.ts): the offsets searched on a few frames made a smooth curve over
// every frame, and that curve written as the fewest keys the editor's tween follows.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { fewestKeys, smoothCurve } from './propfit.ts'
import { sampleKeys } from './keys.ts'

describe('the fit\'s smooth curve', () => {
  it('runs straight between two searched frames, through each', () => {
    const a = new THREE.Vector3(0, 0.02, -0.01); const b = new THREE.Vector3(0.03, -0.01, 0.02)
    const curve = smoothCurve(10, [0, 9], [a, b], 6)
    expect(curve).toHaveLength(10)
    curve.forEach((p, i) => { expect(p.distanceTo(a.clone().lerp(b, i / 9))).toBeLessThan(1e-6) })
  })

  it('stays near each searched value, bending less as the bend weighs more', () => {
    const at = [0, 3, 6, 9]
    const values = [0, 0.04, -0.04, 0].map(y => new THREE.Vector3(0, y, 0))
    const loose = smoothCurve(10, at, values, 0.01); const stiff = smoothCurve(10, at, values, 100)
    at.forEach((i, k) => { expect(loose[i].distanceTo(values[k])).toBeLessThan(0.002) })
    const bend = (c: THREE.Vector3[]): number => c.slice(1, -1).reduce((s, p, i) => s + c[i].clone().add(c[i + 2]).sub(p.clone().multiplyScalar(2)).length(), 0)
    expect(bend(stiff)).toBeLessThan(bend(loose))
  })
})

describe('the fit\'s keys', () => {
  const uOf = (n: number) => (i: number): number => i / (n - 1)
  const still = (n: number, p: THREE.Vector3): Array<{ p: THREE.Vector3, q: THREE.Quaternion }> => Array.from({ length: n }, () => ({ p: p.clone(), q: new THREE.Quaternion() }))

  it('needs only the first and last for a path that doesn\'t move', () => {
    const keys = fewestKeys(still(31, new THREE.Vector3(0.01, 0, 0)), uOf(31), false, 0.001, 12)
    expect(keys.map(k => k.u)).toEqual([0, 1])
    expect(keys[0].p).toEqual([0.01, 0, 0])
  })

  it('adds keys where the tween misses, until it follows to the tolerance or has the most it may', () => {
    const n = 31
    const want = Array.from({ length: n }, (_, i) => ({ p: new THREE.Vector3(0, 0.05 * Math.sin(i / (n - 1) * Math.PI * 2), 0), q: new THREE.Quaternion() }))
    const keys = fewestKeys(want, uOf(n), false, 0.002, 12)
    expect(keys.length).toBeGreaterThan(2)
    expect(keys.length).toBeLessThanOrEqual(12)
    // (each key on a frame, in order)
    keys.forEach((k, j) => { expect(Number.isInteger(Math.round(k.u * (n - 1) * 1e6) / 1e6)).toBe(true); if (j > 0) expect(k.u).toBeGreaterThan(keys[j - 1].u) })
    if (keys.length < 12) for (let i = 0; i < n; i++) expect(sampleKeys(keys, uOf(n)(i), false).p.distanceTo(want[i].p)).toBeLessThanOrEqual(0.002 + 1e-5)
    expect(fewestKeys(want, uOf(n), false, 0.002, 3)).toHaveLength(3)
  })
})
