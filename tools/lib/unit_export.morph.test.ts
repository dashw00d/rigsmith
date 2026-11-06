// @vitest-environment node
// Exercise the real character -> exportUnit -> game GLB path. This covers named correction targets and their
// defaults through mesh placement, game sizing, head splitting and LODs; animated morph-weight tracks and a
// pose-dependent corrective solver are outside this transport test.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { describe, expect, it } from 'vitest'
import { loadGlbFile } from '../../src/engine/headless.ts'
import type { Character } from '../../src/model/types.ts'
import { exportUnit } from './unit_export.ts'

const CHANNELS = ['cloth_squat', 'cloth_reach']
const DEFAULTS = [.6, .2]
const HEIGHT = 2.4
const SCALE = HEIGHT / 1.6
const FLOOR = .35
const TO_GAME = new THREE.Matrix4().makeScale(SCALE, SCALE, SCALE)
  .multiply(new THREE.Matrix4().makeTranslation(0, -FLOOR, 0))

async function fixture (workspace: string): Promise<string> {
  const dir = path.join(workspace, 'characters', 'corrected-body')
  mkdirSync(dir, { recursive: true })
  const geometry = new THREE.PlaneGeometry(1, 2, 12, 24).translate(0, 1, 0)
  const uv = geometry.attributes.uv
  geometry.morphTargetsRelative = true
  geometry.morphAttributes.position = CHANNELS.map((name, channel) => {
    const values = new Float32Array(uv.count * 3)
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i), v = uv.getY(i)
      // No vertical correction: the independent expected floor and height stay .35 and 1.6 after placement.
      values.set(channel === 0 ? [.08 * (u - .5), 0, .12 * v] : [-.06 * v, 0, .09 * u], i * 3)
    }
    const target = new THREE.Float32BufferAttribute(values, 3)
    target.name = name
    return target
  })
  geometry.morphAttributes.normal = CHANNELS.map((name, channel) => {
    const values = new Float32Array(uv.count * 3)
    for (let i = 0; i < uv.count; i++) values.set([.05 * (uv.getX(i) - .5), .04 * (channel + 1) * uv.getY(i), -.03], i * 3)
    const target = new THREE.Float32BufferAttribute(values, 3)
    target.name = name
    return target
  })
  const indices = new Uint16Array(uv.count * 4)
  const weights = new Float32Array(uv.count * 4)
  for (let i = 0; i < uv.count; i++) weights[i * 4] = 1
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.y = 1
  const neck = new THREE.Bone(); neck.name = 'Neck'; neck.position.y = .5
  hips.add(neck)
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial())
  mesh.name = 'SourceBody'
  mesh.position.set(.31, FLOOR, -.42)
  mesh.rotation.y = .43
  mesh.scale.set(1.2, .8, .9)
  mesh.morphTargetInfluences = [...DEFAULTS]
  const scene = new THREE.Group()
  scene.add(hips, mesh)
  scene.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([hips, neck]))
  const bytes = await new GLTFExporter().parseAsync(scene, { binary: true }) as ArrayBuffer
  const file = path.join(dir, 'rigged.glb')
  writeFileSync(file, new Uint8Array(bytes))
  const c: Character = {
    schema: 5, id: 'corrected-body', name: 'Corrected body', createdAt: 1, updatedAt: 1, version: 1, revision: 1,
    status: 'rigged', files: { rigged: 'rigged.glb' },
    source: { file: 'rigged.glb', originalName: 'corrected.glb', bytes: bytes.byteLength, kind: 'rigged', scale: 1, warnings: [] },
    skeleton: { template: 'human', fingerLevel: 'none', overrides: {} }, skin: { locked: false },
    hands: { poses: [] }, clips: [], gear: [], look: { layers: [] },
  }
  writeFileSync(path.join(dir, 'character.json'), JSON.stringify(c))
  return file
}

function skinned (root: THREE.Object3D): THREE.SkinnedMesh[] {
  const meshes: THREE.SkinnedMesh[] = []
  root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(object as THREE.SkinnedMesh) })
  return meshes
}

function uvKey (uv: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number): string {
  return `${Math.round(uv.getX(i) * 12)},${Math.round(uv.getY(i) * 24)}`
}

function worldVertex (mesh: THREE.SkinnedMesh, index: number): THREE.Vector3 {
  return mesh.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld)
}

describe('game export correction target transport', () => {
  it.each([false, true])('reloads placed and sized targets, defaults and posed vertices on every LOD (head split=%s)', async splitHead => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'rigsmith-export-morph-'))
    try {
      const sourceFile = await fixture(workspace)
      const originalBytes = readFileSync(sourceFile)
      const source = await loadGlbFile(sourceFile)
      const body = skinned(source.scene)[0]
      // The loader puts authored names on the mesh dictionary, not on the target attributes. The export must
      // capture those actual loaded names/defaults before cloning or rebuilding its meshes.
      expect(body.morphTargetDictionary).toEqual({ cloth_squat: 0, cloth_reach: 1 })
      expect(body.morphTargetInfluences).toEqual(DEFAULTS)
      expect(body.geometry.morphAttributes.position![0].name).toBe('')
      const modelsDir = path.join(workspace, 'out', 'models')
      const record = await exportUnit('corrected', {
        character: 'corrected-body', height: HEIGHT, budget: 10_000, clips: [], lods: [.5, .2],
        ...(splitHead ? { head: { name: 'CorrectedHead', above: 0 } } : {}),
      }, { workspace, modelsDir, workDir: path.join(workspace, 'out', 'work') })
      expect(record.scale).toBeCloseTo(SCALE, 5)
      expect(record.triangles.source).toBe(576)
      expect(record.triangles.lods).toHaveLength(3)
      expect(record.triangles.lods[1]).toBeLessThan(record.triangles.lods[0])
      expect(record.triangles.lods[2]).toBeLessThan(record.triangles.lods[1])
      if (splitHead) {
        expect(record.triangles.head).toHaveLength(3)
        expect(record.triangles.head![1]).toBeLessThan(record.triangles.head![0])
        expect(record.triangles.head![2]).toBeLessThan(record.triangles.head![1])
        expect(record.triangles.lods[0] + record.triangles.head![0]).toBe(record.triangles.source)
      } else expect(record.triangles.lods[0]).toBe(record.triangles.source)

      const exported = await loadGlbFile(path.join(modelsDir, 'corrected.glb'))
      const meshes = skinned(exported.scene)
      const bases = splitHead ? ['corrected', 'CorrectedHead'] : ['corrected']
      expect(meshes.map(mesh => mesh.name).sort()).toEqual(bases.flatMap(name => [name, `${name}_LOD1`, `${name}_LOD2`]).sort())
      const sourceUv = body.geometry.attributes.uv
      const sourceIndices = new Map(Array.from({ length: sourceUv.count }, (_, i) => [uvKey(sourceUv, i), i]))
      const frame = TO_GAME.clone().multiply(body.matrixWorld)
      const linear = new THREE.Matrix3().setFromMatrix4(frame)
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(frame)
      for (const mesh of meshes) {
        expect(mesh.morphTargetDictionary, mesh.name).toEqual(body.morphTargetDictionary)
        expect(mesh.morphTargetInfluences, mesh.name).toEqual(DEFAULTS)
        expect(mesh.geometry.morphTargetsRelative, mesh.name).toBe(true)
        expect(mesh.geometry.morphAttributes.position, mesh.name).toHaveLength(CHANNELS.length)
        expect(mesh.geometry.morphAttributes.normal, mesh.name).toHaveLength(CHANNELS.length)
        expect(mesh.geometry.attributes.tangent, mesh.name).toBeDefined()
        mesh.skeleton.update()
        for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
          const original = sourceIndices.get(uvKey(mesh.geometry.attributes.uv, i))
          expect(original, `${mesh.name} vertex ${i} keeps a source UV`).toBeDefined()
          const sourceIndex = original!
          const expectedBase = new THREE.Vector3().fromBufferAttribute(body.geometry.attributes.position, sourceIndex).applyMatrix4(frame)
          expect(new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i).distanceTo(expectedBase)).toBeLessThan(1e-6)
          const normalLength = new THREE.Vector3().fromBufferAttribute(body.geometry.attributes.normal, sourceIndex).applyMatrix3(normalMatrix).length()
          for (let channel = 0; channel < CHANNELS.length; channel++) {
            const delta = new THREE.Vector3().fromBufferAttribute(body.geometry.morphAttributes.position![channel], sourceIndex).applyMatrix3(linear)
            expect(new THREE.Vector3().fromBufferAttribute(mesh.geometry.morphAttributes.position![channel], i).distanceTo(delta)).toBeLessThan(1e-6)
            const normal = new THREE.Vector3().fromBufferAttribute(body.geometry.morphAttributes.normal![channel], sourceIndex)
              .applyMatrix3(normalMatrix).multiplyScalar(1 / normalLength)
            expect(new THREE.Vector3().fromBufferAttribute(mesh.geometry.morphAttributes.normal![channel], i).distanceTo(normal)).toBeLessThan(1e-6)
          }
          expect(worldVertex(mesh, i).distanceTo(worldVertex(body, sourceIndex).applyMatrix4(TO_GAME))).toBeLessThan(1e-6)
        }
      }

      // Skinning still evaluates the correction in the right frame after the reconstructed game rig moves.
      const sourceHips = body.skeleton.bones.find(bone => bone.name === 'Hips')!
      sourceHips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), .27)
      sourceHips.position.x += .17
      source.scene.updateMatrixWorld(true)
      body.skeleton.update()
      const gameHips = meshes[0].skeleton.bones.find(bone => bone.name === 'Hips')!
      gameHips.quaternion.copy(sourceHips.quaternion)
      gameHips.position.copy(sourceHips.position).applyMatrix4(TO_GAME)
      exported.scene.updateMatrixWorld(true)
      for (const mesh of meshes) {
        mesh.skeleton.update()
        for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
          const original = sourceIndices.get(uvKey(mesh.geometry.attributes.uv, i))!
          expect(worldVertex(mesh, i).distanceTo(worldVertex(body, original).applyMatrix4(TO_GAME))).toBeLessThan(1e-6)
        }
      }
      expect(readFileSync(sourceFile).equals(originalBytes)).toBe(true)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
