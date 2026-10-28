import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { paintingProblem, transferPainting, transferSkin } from './skintransfer.ts'

const points = [[0,0,0],[1,0,0],[0,1,0],[1,1,0]]
function surface (vertices = points, indices = [0,1,2,2,1,3], weight = (v: number): number => points[v]?.[0] ?? .5): THREE.Group {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices.flat(),3))
  geometry.setIndex(indices); geometry.computeVertexNormals()
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(vertices.flatMap(() => [0,1,0,0]),4))
  geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(vertices.flatMap((_,v) => [1-weight(v),weight(v),0,0]),4))
  const a = new THREE.Bone(), b = new THREE.Bone(); a.name = 'A'; b.name = 'B'; a.add(b)
  const mesh = new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial()); mesh.name = 'body'; mesh.add(a)
  const root = new THREE.Group(); root.add(mesh); root.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([a,b]))
  return root
}

describe('bind surface skin transfer', () => {
  it('follows reordered vertices and UV duplicates instead of incidental indices', () => {
    const target = surface([points[3],points[0],points[1],points[2],points[0]],[1,2,3,3,2,0])
    const t = transferSkin(target,surface())
    expect(t.projected).toBe(0)
    expect(t.edits.map(e => Object.fromEntries(e.weights).B ?? 0)).toEqual([1,0,1,0,0])
    expect(t.samples[0][0]).toEqual([[3,1]])
  })

  it('interpolates a repaired triangle interior on the new skeleton', () => {
    const target = surface([...points,[.25,.25,0]],[0,1,4,1,3,4,3,2,4,2,0,4])
    const t = transferSkin(target,surface())
    expect(t.projected).toBe(1)
    expect(Object.fromEntries(t.edits[4].weights)).toEqual({ A:.75, B:.25 })
    expect(t.samples[0][4]).toEqual([[0,.5],[1,.25],[2,.25]])
  })

  it('rejects changed surfaces, opposite faces and missing bones', () => {
    expect(() => transferSkin(surface([...points,[.25,.25,.1]]),surface())).toThrow('Bind surface changed')
    const target = surface([...points,[.25,.25,.0001]],[4,1,0])
    expect(() => transferSkin(target,surface())).toThrow('Bind surface changed')
    const missing = surface(); missing.getObjectByName('B')!.name = 'C'
    expect(() => transferSkin(missing,surface())).toThrow('Reference bone B')
  })

  it('uses world bind coordinates under transformed mesh parents', () => {
    const source = surface(), target = surface([...points,[.25,.25,0]],[0,1,4,1,3,4,3,2,4,2,0,4])
    for (const root of [source,target]) { root.scale.setScalar(.01); root.position.set(4,9,-3); root.rotation.set(.5,1,.3) }
    expect(transferSkin(target,source).edits[4].weights.find(([n]) => n === 'B')![1]).toBeCloseTo(.25,8)
  })
})

describe('a rig whose model was moved since (stood on the floor)', () => {
  it('meets the moved surface and keeps its painting', () => {
    const before = surface(); before.position.set(0, -.5, 0); before.updateMatrixWorld(true)
    const t = transferSkin(surface(), before)
    expect(t.projected).toBe(0)
    expect(t.samples[0].map(s => s[0][0])).toEqual([0, 1, 2, 3])
    const paint = [{mesh:0,vertex:2,weights:[['A',.3],['B',.7]] as Array<[string,number]>}]
    const moved = surface(); moved.position.set(0, -.5, 0); moved.updateMatrixWorld(true)
    expect(transferPainting(surface(), moved, paint)).toEqual(paint)
  })
})

describe('paint preservation across a rebuild', () => {
  it('keeps unchanged vertex addresses and exact authored weights', () => {
    const paint = [{mesh:0,vertex:1,weights:[['A',.123],['B',.877]] as Array<[string,number]>}]
    expect(transferPainting(surface(),surface(),paint)).toEqual(paint)
  })

  it('moves a stroke with its surface and carries it to new UV duplicates', () => {
    const target = surface([points[3],points[0],points[1],points[2],points[1]],[1,2,3,3,2,0])
    const paint = [{mesh:0,vertex:1,weights:[['A',1]] as Array<[string,number]>}]
    expect(transferPainting(target,surface(),paint)).toEqual([2,4].map(vertex => ({...paint[0],vertex})))
  })

  it('interpolates fully painted repairs but does not spread a partial stroke', () => {
    const target = surface([...points,[.25,.25,0]],[0,1,4,1,3,4,3,2,4,2,0,4])
    const paint = [0,1,2].map(vertex => ({mesh:0,vertex,weights:[[vertex===1?'B':'A',1]] as Array<[string,number]>}))
    expect(Object.fromEntries(transferPainting(target,surface(),paint).at(-1)!.weights)).toEqual({ A:.75,B:.25 })
    expect(transferPainting(target,surface(),paint.slice(0,1))).toEqual(paint.slice(0,1))
  })

  it('refuses to silently lose paint or use a removed painted bone', () => {
    const paint = [{mesh:0,vertex:1,weights:[['B',1]] as Array<[string,number]>}]
    expect(() => transferPainting(surface([points[0],points[2],points[3]],[0,2,1]),surface(),paint)).toThrow('painted vertices no longer match')
    const target = surface(); target.getObjectByName('B')!.name = 'C'
    expect(() => transferPainting(target,surface(),paint)).toThrow('Painted bone')
  })
})

describe('painting pre-check before a re-rig', () => {
  /** The model as import leaves it: plain meshes, no skin. */
  function model (vertices = points, at = new THREE.Vector3()): THREE.Group {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices.flat(), 3))
    const root = new THREE.Group(); root.add(new THREE.Mesh(geometry)); root.position.copy(at); root.updateMatrixWorld(true)
    return root
  }
  const painted = [{ mesh: 0, vertex: 3, weights: [['B', 1]] as Array<[string, number]> }]

  it('passes painting whose points the model still has, also when it stood on the floor since', () => {
    expect(paintingProblem(model(), surface(), painted)).toBeNull()
    expect(paintingProblem(model([points[3], points[0], points[1], points[2]]), surface(), painted)).toBeNull()
    expect(paintingProblem(model(points, new THREE.Vector3(0, 0.5, 0)), surface(), painted)).toBeNull()
    expect(paintingProblem(model([[5, 5, 5]]), surface(), [])).toBeNull()
  })

  it('says how many painted points the model has lost', () => {
    expect(paintingProblem(model([points[0], points[1], points[2], [2, 2, 0]]), surface(), painted)).toMatch(/^1 of 1 painted points/)
    expect(paintingProblem(model(), surface(), [{ mesh: 0, vertex: 9, weights: [['B', 1]] }])).toMatch(/aren't in the live rig/)
  })
})
