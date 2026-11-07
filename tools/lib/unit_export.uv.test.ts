// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { loadGlbFile } from '../../src/engine/headless.ts'
import { CharacterView } from '../../src/engine/CharacterView.ts'
import { clothBody } from '../../src/engine/folkview.ts'
import { samePhysicalSurface } from '../../src/engine/physical.ts'
import { makeCharacter } from '../../src/model/fixtures.ts'
import { bakeClothPng } from './clothbake.ts'
import { exportUnit } from './unit_export.ts'

it('bakes cloth using the shipped rig UVs when uv-physics has the old layout', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'rigsmith-uv-export-'))
  try {
    const dir = path.join(workspace, 'characters', 'uv-body'); mkdirSync(path.join(dir, 'source'), { recursive: true })
    const root = new THREE.Group(); const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.y = 1; root.add(hips)
    const geo = new THREE.PlaneGeometry(1, 1.8, 4, 6).translate(0, 0.9, 0); const n = geo.attributes.position.count
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
    const weights = new Float32Array(n * 4); for (let i = 0; i < n; i++) weights[i * 4] = 1
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ name: 'Shirt' })); root.add(mesh)
    root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([hips]))
    const exporter = new GLTFExporter(); const rigged = await exporter.parseAsync(root, { binary: true }) as ArrayBuffer
    writeFileSync(path.join(dir, 'rigged.glb'), new Uint8Array(rigged))
    const uv = geo.attributes.uv
    for (let i = 0; i < uv.count; i++) { const u = uv.getX(i); uv.setXY(i, uv.getY(i), u) }
    const old = await exporter.parseAsync(root, { binary: true }) as ArrayBuffer
    writeFileSync(path.join(dir, 'source', 'uv-physics.glb'), new Uint8Array(old))
    const actual = new CharacterView((await loadGlbFile(path.join(dir, 'rigged.glb'))).scene)
    const physical = new CharacterView((await loadGlbFile(path.join(dir, 'source', 'uv-physics.glb'))).scene)
    expect(samePhysicalSurface(actual.bodySkinned[0], physical.bodySkinned[0])).toBe(true)
    const body = clothBody(actual.bodySkinned)
    const cut = { below: [{ regions: [body.regions[0]], y: 0.5, feather: 0 }] }
    const png = new PNG({ width: 16, height: 16 }); png.data.fill(255)
    const image = PNG.sync.write(png); writeFileSync(path.join(dir, 'cloth.png'), image)
    const c = makeCharacter({ id: 'uv-body', files: { rigged: 'rigged.glb' }, look: { layers: [], cloth: [{ id: 'cut', name: 'Cut', file: 'cloth.png', slots: ['top'], cut }] },
      folk: { sets: [{ id: 'plain', name: 'Plain', pieces: [], tags: [], grants: [] }], pools: [], kinds: [], stances: [] } })
    writeFileSync(path.join(dir, 'character.json'), JSON.stringify(c))
    const modelsDir = path.join(workspace, 'out', 'models')
    await exportUnit('uv-body', { character: 'uv-body', height: 1.8, budget: 10000, clips: [], lods: [] }, { workspace, modelsDir, workDir: path.join(workspace, 'out', 'work') })
    const manifest = JSON.parse(readFileSync(path.join(modelsDir, 'uv-body.folk.json'), 'utf8'))
    const emitted = readFileSync(path.join(workspace, 'out', 'work', 'uv-body', manifest.layers[0].file))
    const expected = bakeClothPng(image, body.geometry, body.regions, actual.height, cut, undefined, { slots: ['top'], regions: body.list })
    expect(PNG.sync.read(emitted).data).toEqual(PNG.sync.read(expected).data)
  } finally { rmSync(workspace, { recursive: true, force: true }) }
}, 60_000)
