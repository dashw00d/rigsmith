// Where rig B puts weight from a bone onto vertices rig A gives to another (for bleed hunting).
// node tools/dev/bleed_where.ts <A.glb> <B.glb> <A bone regex> <B bone regex> [min weight]
import * as THREE from 'three'
import { loadGlbFile } from '../../src/engine/headless.ts'
import { canonical } from '../../src/engine/retarget.ts'
const load = async (file: string): Promise<THREE.Group> => (await loadGlbFile(file)).scene
function verts (root: THREE.Group): Array<{ p: THREE.Vector3, w: Map<string, number> }> {
  root.updateMatrixWorld(true)
  const out: Array<{ p: THREE.Vector3, w: Map<string, number> }> = []
  root.traverse(o => {
    const m = o as THREE.SkinnedMesh
    if (m.isSkinnedMesh !== true) return
    const p = m.geometry.attributes.position; const si = m.geometry.attributes.skinIndex; const sw = m.geometry.attributes.skinWeight
    for (let i = 0; i < p.count; i++) {
      const w = new Map<string, number>()
      for (let k = 0; k < 4; k++) { const x = sw.getComponent(i, k); if (x > 0) { const n = canonical(m.skeleton.bones[si.getComponent(i, k)].name); w.set(n, (w.get(n) ?? 0) + x) } }
      out.push({ p: new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld), w })
    }
  })
  return out
}
const [a, b, ra, rb, minArg] = process.argv.slice(2)
const A = verts(await load(a)); const B = verts(await load(b))
const key = (p: THREE.Vector3): string => `${Math.round(p.x * 2000)},${Math.round(p.y * 2000)},${Math.round(p.z * 2000)}`
const bmap = new Map(B.map(x => [key(x.p), x.w]))
let minY = Infinity; let maxY = -Infinity
for (const x of A) { minY = Math.min(minY, x.p.y); maxY = Math.max(maxY, x.p.y) }
const H = maxY - minY
const reA = new RegExp(ra); const reB = new RegExp(rb); const min = Number(minArg ?? 0.05)
const hits: string[] = []
for (const x of A) {
  const top = [...x.w].sort((p, q) => q[1] - p[1])[0]
  if (top === undefined || !reA.test(top[0]) || top[1] < 0.9) continue
  const wb = bmap.get(key(x.p)); if (wb === undefined) continue
  const bad = [...wb].filter(([n, w]) => reB.test(n) && w >= min)
  if (bad.length === 0) continue
  hits.push(`x ${(x.p.x / H * 100).toFixed(1)} y(up) ${((x.p.y - minY) / H * 100).toFixed(1)} z ${(x.p.z / H * 100).toFixed(1)} %H  A:${top[0]}  B: ${[...wb].sort((p, q) => q[1] - p[1]).map(([n, w]) => `${n} ${w.toFixed(2)}`).join(', ')}`)
}
console.log(`${hits.length} vertices`)
for (const h of hits.slice(0, 25)) console.log(h)
