import { describe, expect, it } from 'vitest'
import { regionStates } from './coverage.ts'
import { FACE_SHARE } from './garments.ts'

describe('body coverage', () => {
  it('uses the largest single piece rather than adding overlapping shares', () => {
    const states = regionStates([{ id: 'a', hits: [50, 0, 97] }, { id: 'b', hits: [50, 1, 0] }], [100, 100, 100])
    expect(states).toEqual([
      { region: 0, state: 'partial', pct: 50, by: ['a', 'b'] },
      { region: 1, state: 'partial', pct: 1, by: ['b'] },
      { region: 2, state: 'hidden', pct: 97, by: ['a'] },
    ])
  })
  it('uses each piece threshold, including the face exception, and handles empty regions', () => {
    const states = regionStates([{ id: 'helm', hits: [59, 60, 1], share: FACE_SHARE }], [100, 100, 0])
    expect(states.map(s => s.state)).toEqual(['partial', 'hidden', 'bare'])
    expect(states[1].pct).toBe(60)
    expect(regionStates([], [12])[0]).toEqual({ region: 0, state: 'bare', pct: 0, by: [] })
  })
})

it('retains fallback per-region counts using the same vertex oracle as the region CLI', async () => {
  const THREE = await import('three')
  const { bodySurface, coveredVertices, hideBodyUnder } = await import('./garments.ts')
  const root = new THREE.Group()
  const bone = new THREE.Bone(); bone.name = 'Hips'; root.add(bone)
  const geometry = new THREE.CylinderGeometry(.16, .12, 1.5, 24, 30).translate(0, 1, 0)
  const count = geometry.attributes.position.count
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4))
  const weights = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) weights[i * 4] = 1
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial()); root.add(mesh)
  root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([bone]))
  const view = { skinned: [mesh], height: 1.8, rest: null }
  const body = bodySurface(view)!
  const skirt = new THREE.CylinderGeometry(.17, .2, .45, 22, 6, true).translate(0, .75, 0)
  const covered = coveredVertices(body, [skirt], view.height)
  const expected = new Int32Array(body.regions.count)
  for (let v = 0; v < covered.length; v++) if (covered[v] && body.regions.of[v] >= 0) expected[body.regions.of[v]]++
  expect(expected.some(n => n > 0)).toBe(true)
  const worn: import('./garments.ts').Worn = { gear: 'skirt', node: null, meshes: [], objects: [], hides: [skirt] }
  hideBodyUnder(view, [worn])
  expect(Array.from(worn.hits!)).toEqual(Array.from(expected))
  hideBodyUnder(view, [])
})
