// What each piece of a dynamic character hides of its body (engine/regions.ts, garments.ts regionsHidden), and how much
// of each region it covers: to see why a piece hides a region, or doesn't.
//   node tools/dev/folk_regions.ts CHARACTER [NAME-FILTER]     (RIGSMITH_WORKSPACE: the workspace)
import path from 'node:path'
import * as THREE from 'three'
import { CharacterView } from '../../src/engine/CharacterView.ts'
import { bodySurface, coveredVertices, originMatrix } from '../../src/engine/garments.ts'
import { applyGeometryMatrix } from '../../src/engine/geometry-transform.ts'
import { cloneMorphGeometry } from '../../src/engine/morph-state.ts'
import { garmentMatrix } from '../../src/engine/placement.ts'
import { HIDE_SHARE } from '../../src/engine/regions.ts'
import { character, load, WORKSPACE } from '../lib/node3d.ts'

const [id, filter] = process.argv.slice(2)
const c = character(id)
const dir = path.join(WORKSPACE, 'characters', id)
const view = new CharacterView((await load(path.join(dir, c.files.rigged!))).scene)
const body = bodySurface(view)!
const p = new THREE.Vector3()
const regions = Array.from({ length: body.regions.count }, (_, r) => {
  const c3 = new THREE.Vector3(); let n = 0
  for (let v = 0; v < body.regions.of.length; v++) if (body.regions.of[v] === r) { c3.add(p.fromArray(body.positions, v * 3)); n++ }
  return c3.divideScalar(Math.max(n, 1))
})
console.log('regions', regions.map((x, r) => `${r}:${x.toArray().map(v => v.toFixed(2)).join(',')}`).join('  '))
for (const g of c.gear) {
  if (g.model === undefined || g.status !== 'ready' || g.attach.kind !== 'skin') continue
  if (filter !== undefined && !g.name.includes(filter)) continue
  const { scene } = await load(path.join(dir, g.model))
  scene.updateMatrixWorld(true)
  const at = g.origin === undefined ? garmentMatrix(g.attach.place) : garmentMatrix(g.attach.place).multiply(originMatrix(g))
  const geos: THREE.BufferGeometry[] = []
  scene.traverse(o => { if ((o as THREE.Mesh).isMesh === true) geos.push(applyGeometryMatrix(cloneMorphGeometry(o as THREE.Mesh), new THREE.Matrix4().multiplyMatrices(at, o.matrixWorld))) })
  const covered = coveredVertices(body, geos, view.height)
  const hits = new Int32Array(body.regions.count)
  for (let v = 0; v < covered.length; v++) if (covered[v] === 1 && body.regions.of[v] >= 0) hits[body.regions.of[v]]++
  const shares = Array.from(hits, (h, r) => [r, h / body.regions.vertices[r]] as const).filter(([, s]) => s > 0.05)
  console.log(g.name.padEnd(36), shares.map(([r, s]) => `${r}:${Math.round(s * 100)}%${s >= HIDE_SHARE ? '*' : ''}`).join(' '))
}
