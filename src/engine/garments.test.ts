import { describe, expect, it } from 'vitest'
import { applyEdits, boneFrame, GARMENT_FLAG, partSpot, partWeights } from './garments.ts'
import * as THREE from 'three'
import { placementMatrix } from './placement.ts'
import { captureRest } from './retarget.ts'

describe('accessory weights', () => {
  it('a part takes one set of weights for every vertex', () => {
    const { indices, weights } = partWeights(3, [[4, 0.75], [2, 0.25]])
    for (let v = 0; v < 3; v++) {
      expect([...indices.slice(v * 4, v * 4 + 2)]).toEqual([4, 2])
      expect(weights[v * 4]).toBeCloseTo(0.75)
      expect(weights[v * 4 + 1]).toBeCloseTo(0.25)
      expect(weights[v * 4 + 2]).toBe(0)
    }
  })

  it("a part's spot is its anchor, else the middle of its meshes", () => {
    const g = new THREE.BoxGeometry(2, 2, 2).translate(1, 5, 0)
    const mesh = new THREE.Mesh(g)
    expect(partSpot({}, [mesh]).toArray()).toEqual([1, 5, 0])
    expect(partSpot({ anchor: [0, 1, 2] }, [mesh]).toArray()).toEqual([0, 1, 2])
  })

  it('painted weights are laid over computed ones by mesh, vertex and bone name, normalized', () => {
    const indices = new Uint16Array(8); const weights = new Float32Array(8)
    weights[0] = 1; weights[4] = 1
    const n = applyEdits(indices, weights, [
      { mesh: 0, vertex: 1, weights: [['Spine', 2], ['Hips', 2]] },
      { mesh: 1, vertex: 0, weights: [['Spine', 1]] },   // another mesh: left alone
      { mesh: 0, vertex: 0, weights: [['Nope', 1]] },    // no such bone: left alone
    ], 0, ['Hips', 'Spine'])
    expect(n).toBe(1)
    expect(weights[0]).toBe(1)
    expect(indices[4]).toBe(1); expect(weights[4]).toBeCloseTo(0.5)
    expect(indices[5]).toBe(0); expect(weights[5]).toBeCloseTo(0.5)
  })
})

describe('bone gear on stage', () => {
  /** A spine bent forward and turned, with a bone on it, as a character's view has them. */
  function view (): { root: THREE.Object3D, bones: Map<string, THREE.Bone>, rest: ReturnType<typeof captureRest> } {
    const root = new THREE.Object3D()
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0)
    const spine = new THREE.Bone(); spine.name = 'Spine2'; spine.position.set(0, 0.4, 0.02)
    spine.quaternion.setFromEuler(new THREE.Euler(0.3, 0.5, -0.1))
    root.add(hips); hips.add(spine)
    root.updateMatrixWorld(true)
    return { root, bones: new Map([['Hips', hips], ['Spine2', spine]]), rest: captureRest(root, o => (o as THREE.Bone).isBone === true) }
  }

  it('puts a piece where its placement says at rest, on a node clips can move by its name', () => {
    const v = view()
    const place = { position: [0.1, 1.3, -0.15] as [number, number, number], rotation: [10, -20, 90] as [number, number, number], scale: 0.8 }
    const frame = boneFrame(v, { id: 'g1', name: 'Great Axe' }, 'Spine2', place)!
    expect(frame.place.name).toBe('Great_Axe_place')
    expect(frame.group.userData[GARMENT_FLAG]).toBe('g1')
    v.root.updateMatrixWorld(true)
    const want = placementMatrix(place)
    frame.place.matrixWorld.elements.forEach((x, i) => expect(x).toBeCloseTo(want.elements[i], 5))
    // a bone the skeleton lacks: it rides the first one
    expect(boneFrame(v, { id: 'g2', name: 'Pouch' }, 'Tail', place)!.bone.name).toBe('Hips')
  })
})
