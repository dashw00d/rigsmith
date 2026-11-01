// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { compact } from './lods.ts'
import { cloneMorphGeometry, copyMorphState, mergeMorphState, restoreMorphState } from './morph-state.ts'

/** A binary glTF avoids browser/network mocks while exercising the real loader's targetNames and weights. */
async function loadedCloth (): Promise<THREE.Mesh> {
  const binary = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, .2, 0, 0, 0, .4, 0, 0, 0, .6])
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [.2, .4, .6] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }] }],
      extras: { targetNames: ['cloth_squat'] }, weights: [.6] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  }))
  const jsonLength = Math.ceil(json.length / 4) * 4
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + binary.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true)
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true)
  bytes.fill(32, 20, 20 + jsonLength); bytes.set(json, 20)
  view.setUint32(20 + jsonLength, binary.byteLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true)
  bytes.set(new Uint8Array(binary.buffer), 28 + jsonLength)
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '')
  return gltf.scene.children[0] as THREE.Mesh
}

function corrected (names = ['cloth_squat'], weights = [.6], relative = true): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
  geometry.morphAttributes.position = names.map((name, index) => {
    const target = new THREE.Float32BufferAttribute([.2 + index, 0, 0, 0, .4, 0, 0, 0, .6], 3)
    target.name = name
    return target
  })
  geometry.morphTargetsRelative = relative
  const mesh = new THREE.Mesh(geometry)
  mesh.morphTargetInfluences = weights
  return mesh
}

describe('transporting loaded morph identity and defaults', () => {
  it('captures actual GLTFLoader names and weights without modifying the loaded mesh', async () => {
    const source = await loadedCloth()
    expect(source.morphTargetDictionary).toEqual({ cloth_squat: 0 })
    expect(source.morphTargetInfluences).toEqual([.6])
    expect(source.geometry.morphAttributes.position![0].name).toBe('')
    const geometry = cloneMorphGeometry(source)
    expect(geometry.morphAttributes.position![0].name).toBe('cloth_squat')
    const rebuilt = restoreMorphState(new THREE.Mesh(geometry))
    expect(rebuilt.morphTargetDictionary).toEqual(source.morphTargetDictionary)
    expect(rebuilt.morphTargetInfluences).toEqual(source.morphTargetInfluences)
    rebuilt.morphTargetInfluences![0] = .1
    expect(source.morphTargetInfluences).toEqual([.6])
    expect(source.geometry.morphAttributes.position![0].name).toBe('')
    expect(source.geometry.userData).not.toHaveProperty('rigsmithMorphState')
  })

  it('keeps loaded identity, defaults and evaluated vertices after compaction and a new skinned mesh', async () => {
    const source = await loadedCloth()
    source.geometry.userData.rawVertexExtras = { values: [9, 8, 7] }
    const geometry = compact(cloneMorphGeometry(source), Uint32Array.from([2, 0, 1]))
    const rebuilt = restoreMorphState(new THREE.SkinnedMesh(geometry))
    expect(rebuilt.morphTargetDictionary).toEqual({ cloth_squat: 0 })
    expect(rebuilt.morphTargetInfluences).toEqual([.6])
    // Mesh's position evaluation covers morphs without requiring a skin/skeleton on this transport fixture.
    for (const [index, original] of [2, 0, 1].entries()) {
      const actual = THREE.Mesh.prototype.getVertexPosition.call(rebuilt, index, new THREE.Vector3())
      expect(actual.distanceTo(source.getVertexPosition(original, new THREE.Vector3()))).toBeLessThan(1e-7)
    }
    expect(geometry.userData).not.toHaveProperty('rawVertexExtras')
    expect(source.geometry.userData.rawVertexExtras).toEqual({ values: [9, 8, 7] })
  })

  it.each([true, false])('restores names dropped by merging compatible parts (relative=%s)', relative => {
    const source = corrected(['cloth_squat', 'cloth_reach'], [.6, .2], relative)
    const parts = [cloneMorphGeometry(source), cloneMorphGeometry(source)]
    const merged = mergeGeometries(parts)!
    expect(merged.morphAttributes.position![0].name).toBe('')
    mergeMorphState(parts, merged)
    const rebuilt = restoreMorphState(new THREE.Mesh(merged))
    expect(rebuilt.morphTargetDictionary).toEqual(source.morphTargetDictionary)
    expect(rebuilt.morphTargetInfluences).toEqual([.6, .2])
    expect(merged.morphTargetsRelative).toBe(relative)
    expect(merged.morphAttributes.position!.map(target => target.name)).toEqual(['cloth_squat', 'cloth_reach'])
    for (let index = 0; index < 6; index++) {
      expect(rebuilt.getVertexPosition(index, new THREE.Vector3()).distanceTo(source.getVertexPosition(index % 3, new THREE.Vector3()))).toBeLessThan(1e-7)
    }
    expect(source.geometry.userData).not.toHaveProperty('rigsmithMorphState')
  })

  it.each([
    corrected(['cloth_reach', 'cloth_squat'], [.6, .2]),
    corrected(['cloth_squat', 'cloth_reach'], [.7, .2]),
    corrected(['cloth_squat', 'cloth_reach'], [.6, .2], false),
    corrected(['cloth_squat'], [.6]),
  ])('rejects incompatible channel order, defaults, mode or counts before modifying output', incompatible => {
    const first = cloneMorphGeometry(corrected(['cloth_squat', 'cloth_reach'], [.6, .2]))
    const second = cloneMorphGeometry(incompatible)
    const output = first.clone()
    const before = JSON.stringify(output.userData)
    expect(() => mergeMorphState([first, second], output)).toThrow(/morph/i)
    expect(JSON.stringify(output.userData)).toBe(before)
    expect(output.morphAttributes.position!.map(target => target.name)).toEqual(['cloth_squat', 'cloth_reach'])
  })

  it('copies only private state, with independent weights and names on every attribute', () => {
    const source = cloneMorphGeometry(corrected())
    source.userData.rawVertexExtras = { values: [3, 4, 5] }
    const output = corrected().geometry
    output.morphAttributes.normal = output.morphAttributes.position!.map(target => target.clone())
    output.userData.keep = true
    copyMorphState(source, output)
    expect(output.userData).toHaveProperty('keep', true)
    expect(output.userData).not.toHaveProperty('rawVertexExtras')
    expect(output.morphAttributes.normal![0].name).toBe('cloth_squat')
    output.userData.rigsmithMorphState.influences[0] = .1
    output.userData.rigsmithMorphState.dictionary.cloth_squat = 9
    const rebuilt = restoreMorphState(new THREE.Mesh(source))
    expect(rebuilt.morphTargetInfluences).toEqual([.6])
    expect(rebuilt.morphTargetDictionary).toEqual({ cloth_squat: 0 })
  })

  it('validates stale state against rebuilt target counts', () => {
    const geometry = cloneMorphGeometry(corrected())
    geometry.morphAttributes.position!.push(geometry.morphAttributes.position![0].clone())
    expect(() => restoreMorphState(new THREE.Mesh(geometry))).toThrow(/target count/i)
  })

  it('leaves meshes without morphs free of private state', () => {
    const plain = new THREE.Mesh(new THREE.BoxGeometry())
    const cloned = cloneMorphGeometry(plain)
    const output = plain.geometry.clone()
    copyMorphState(cloned, output)
    mergeMorphState([cloned, output], output)
    expect(restoreMorphState(new THREE.Mesh(output)).morphTargetInfluences).toBeUndefined()
    expect(cloned.userData).not.toHaveProperty('rigsmithMorphState')
    expect(output.userData).not.toHaveProperty('rigsmithMorphState')
  })
})
