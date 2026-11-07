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

it('draws a posed full-index skinned overlay without changing the body and disposes it', async () => {
  const THREE = await import('three')
  const { bodySurface } = await import('./garments.ts')
  const { CoverageOverlay } = await import('./coverageOverlay.ts')
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 2,0,0, 3,0,0, 2,1,0], 3))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(24), 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0], 4))
  geometry.setIndex([0,1,2,3,4,5])
  const root = new THREE.Group(); const bone = new THREE.Bone(); root.add(bone)
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial()); root.add(mesh)
  root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([bone]))
  mesh.userData.fullIndex = geometry.index
  geometry.setIndex([0,1,2])
  const body = bodySurface({ skinned: [mesh], height: 1, rest: null })!
  let frame = (): void => {}
  let stopped = false
  const stage = { onFrame: (fn: () => void) => { frame = fn; return () => { stopped = true } } } as unknown as import('./Stage.ts').Stage
  const overlay = new CoverageOverlay(body, stage)
  const copy = root.children.find(child => child.name === 'coverage-region-overlay') as import('three').SkinnedMesh
  expect(copy.skeleton).toBe(mesh.skeleton)
  expect(copy.geometry.index?.count).toBe(6)
  expect(mesh.geometry.index?.count).toBe(3)
  overlay.update(body, regionStates([{ id: 'test', hits: [3, 0] }], body.regions.vertices), 1)
  const colors = copy.geometry.getAttribute('color')
  expect([colors.getX(0), colors.getY(0), colors.getZ(0)]).not.toEqual([colors.getX(3), colors.getY(3), colors.getZ(3)])
  mesh.position.x = 2; frame(); expect(copy.position.x).toBe(2)
  overlay.dispose()
  expect(stopped).toBe(true)
  expect(copy.parent).toBeNull()
  expect(mesh.parent).toBe(root)
})
