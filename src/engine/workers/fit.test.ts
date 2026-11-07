import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { SkinPolicy } from '../../model/types.ts'
import { bodyCore, bodySurface, computeWeights, coveredVertices, hideBodyUnder, meshCore, regionsHidden, type BodyView, type Worn } from '../garments.ts'
import { decodeDerived, derive, derivedName, encodeDerived, type DerivedStore } from './derive.ts'
import { meshesKey, TriangleGrid } from './fit.ts'
import { oldBodySurface, oldComputeWeights, oldCoveredVertices } from '../../../tests/support/fit.reference.ts'

const BONES = ['Hips', 'Spine', 'Spine1', 'Neck', 'Head', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftArm', 'RightArm']
const AT: Record<string, [number, number, number]> = {
  Hips: [0, 1, 0], Spine: [0, 1.15, 0], Spine1: [0, 1.3, 0], Neck: [0, 1.5, 0], Head: [0, 1.62, 0], LeftUpLeg: [0.1, 0.95, 0], RightUpLeg: [-0.1, 0.95, 0],
  LeftLeg: [0.1, 0.5, 0], RightLeg: [-0.1, 0.5, 0], LeftArm: [0.2, 1.4, 0], RightArm: [-0.2, 1.4, 0],
}

/** Weights by height and side, two or three bones blended, so the four strongest and their order matter. */
function weigh (g: THREE.BufferGeometry): void {
  const p = g.attributes.position
  const si: number[] = []; const sw: number[] = []
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i); const y = p.getY(i) + 1
    const leg = x >= 0 ? [5, 7] : [6, 8]
    const k = y < 0.5 ? [leg[1], leg[0], 0, 0] : y < 1 ? [leg[0], 0, leg[1], 1] : y < 1.4 ? [1, 2, 0, x >= 0 ? 9 : 10] : [3, 4, 2, 0]
    const f = (y * 7.3) % 1
    si.push(...k); sw.push(0.5 + f * 0.3, 0.3 - f * 0.2, 0.15, 0.05 + f * 0.1 - 0.0)
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4))
}

/** A body of two meshes (a long cylinder, a head sphere), bound away from the origin. */
function body (): BodyView {
  const root = new THREE.Group()
  root.position.set(0.03, -1, 0.02)
  const bones = BONES.map(n => { const b = new THREE.Bone(); b.name = n; b.position.set(...AT[n]); return b })
  for (const b of bones) root.add(b)
  const trunk = new THREE.CylinderGeometry(0.16, 0.12, 1.5, 24, 30).translate(0, 0.75 + 0.25, 0)
  const head = new THREE.SphereGeometry(0.11, 18, 12).translate(0, 1.62 + 0.0, 0)
  const meshes = [trunk, head].map(g => { weigh(g); return new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()) })
  for (const m of meshes) root.add(m)
  root.updateMatrixWorld(true)
  for (const m of meshes) m.bind(new THREE.Skeleton(bones))
  const rest = { bones: new Map(bones.map(b => [b.name, { worldPosition: b.getWorldPosition(new THREE.Vector3()) }])) }
  return { skinned: meshes, height: 1.8, rest } as unknown as BodyView
}

/** Pieces in rest space: a shirt (welded seam), a skirt, a hat; each just outside the body. */
function pieces (): Record<string, THREE.BufferGeometry> {
  return {
    shirt: new THREE.CylinderGeometry(0.175, 0.17, 0.5, 20, 8, true).translate(0.03, 0.2 + 0.0, 0.02),
    skirt: new THREE.CylinderGeometry(0.17, 0.2, 0.45, 22, 6, true).translate(0.03, -0.25, 0.02),
    hat: new THREE.SphereGeometry(0.125, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0.03, 0.62, 0.02),
  }
}

const same = (a: ArrayBufferView, b: ArrayBufferView): boolean => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))

describe('the fitting moved to workers/fit.ts', () => {
  it('weights every piece bit for bit as the code before it did, for every policy', () => {
    const view = body()
    const now = bodySurface(view)!
    const before = oldBodySurface(view as never)!
    const policies: SkinPolicy[] = ['body', 'upper', 'lower', 'cape', 'skirt', 'head']
    for (const [name, g] of Object.entries(pieces())) {
      for (const policy of policies) {
        const a = computeWeights(now, g, policy, view)
        const b = oldComputeWeights(before, g, policy, view as never)
        expect(same(a.indices, b.indices), `${name} ${policy} indices`).toBe(true)
        expect(same(a.weights, b.weights), `${name} ${policy} weights`).toBe(true)
      }
    }
  })

  it('finds the body a piece covers bit for bit as before, and the same regions', () => {
    const view = body()
    const now = bodySurface(view)!
    const before = oldBodySurface(view as never)!
    const all = pieces()
    for (const set of [[all.shirt], [all.skirt, all.hat], [all.shirt, all.skirt, all.hat]]) {
      const a = coveredVertices(now, set, view.height)
      expect(same(a, oldCoveredVertices(before, set, view.height))).toBe(true)
      expect(a.some(x => x === 1)).toBe(true)
    }
    expect(now.regions.count).toBe(before.regions.count)
    expect(Array.from(now.regions.of)).toEqual(Array.from(before.regions.of))
  })

  it('a grid answers the nearest triangle, far cells too', () => {
    const grid = new TriangleGrid(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1e6, 0, 0, 1e6 + 1, 0, 0, 1e6, 1, 0]), [0, 1, 2, 3, 4, 5], 0.05)
    expect(grid.closest(new THREE.Vector3(0.2, 0.2, 0.01))?.triangle).toBe(0)
    expect(grid.closest(new THREE.Vector3(1e6 + 0.2, 0.2, 0.01))?.triangle).toBe(1)
  })
})

describe('derived data', () => {
  it('is what computeWeights and the coverage test answer, kept in a file read back as written', async () => {
    const view = body()
    const surface = bodySurface(view)!
    const g = pieces().shirt
    const files = new Map<string, ArrayBuffer>()
    const store: DerivedStore = { get: async n => files.get(n) ?? null, put: async (n, d) => { files.set(n, d) } }
    const b = bodyCore(surface, view)
    const d = await derive(b, [meshCore(g)], { policy: 'upper', cover: true, store })
    const want = computeWeights(surface, g, 'upper', view)
    expect(same(d.weights[0].indices, want.indices) && same(d.weights[0].weights, want.weights)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    const name = derivedName(meshesKey([meshCore(g)]), b.key, 'upper')
    expect([...files.keys()]).toEqual([name])
    const back = decodeDerived(files.get(name)!, [g.attributes.position.count], surface.regions.count)!
    expect(same(back.weights[0].weights, want.weights)).toBe(true)
    expect(Array.from(back.hits!)).toEqual(Array.from(d.hits!))
    // (another piece's counts, another body's regions: not this file)
    expect(decodeDerived(files.get(name)!, [3], surface.regions.count)).toBeNull()
    expect(decodeDerived(files.get(name)!, [g.attributes.position.count], surface.regions.count + 1)).toBeNull()
    expect(decodeDerived(encodeDerived({ weights: d.weights, hits: null }), [g.attributes.position.count], 7)?.hits).toBeNull()
  })

  it('hands out copies: weights painted over in place never reach the next wearer', async () => {
    const view = body()
    const b = bodyCore(bodySurface(view)!, view)
    const m = [meshCore(pieces().hat)]
    const first = await derive(b, m, { policy: 'head', cover: false })
    first.weights[0].weights.fill(0)
    const second = await derive(b, m, { policy: 'head', cover: false })
    expect(second.weights[0].weights.some(w => w > 0)).toBe(true)
  })

  it('names a piece by its meshes as placed: moving it is another file', () => {
    const g = pieces().hat
    const moved = g.clone().translate(0, 0.001, 0)
    expect(meshesKey([meshCore(g)])).not.toBe(meshesKey([meshCore(moved)]))
    expect(meshesKey([meshCore(g)])).toBe(meshesKey([meshCore(g.clone())]))
  })
})

describe('hiding the body', () => {
  it('takes out the regions each worn piece hides, from its own regions or by testing it, and puts them back', () => {
    const view = body()
    const surface = bodySurface(view)!
    const all = pieces()
    const trunk = view.skinned[0]
    const full = trunk.geometry.index!.count
    const tested: Worn = { gear: 'skirt', node: null, meshes: [], objects: [], hides: [all.skirt], hideShare: 0.5 }
    hideBodyUnder(view, [tested])
    const hidden = regionsHidden(surface, [all.skirt], view.height, 0.5)
    const byTest = trunk.geometry.index!.count
    expect(hidden.length > 0 ? byTest < full : byTest === full).toBe(true)
    // (regions given: nothing tested, the same triangles)
    hideBodyUnder(view, [{ gear: 'skirt', node: null, meshes: [], objects: [], hidden }])
    expect(trunk.geometry.index!.count).toBe(byTest)
    hideBodyUnder(view, [])
    expect(trunk.geometry.index!.count).toBe(full)
  })
})
