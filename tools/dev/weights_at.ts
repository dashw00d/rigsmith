// Which of rig B's bones drive the vertices that rig A gives (mostly) to one bone.
// node tools/dev/weights_at.ts <A.glb> <B.glb> <Bone> [<Bone>...]
import * as THREE from 'three'
import { loadGlbFile } from '../../src/engine/headless.ts'
import { canonical } from '../../src/engine/retarget.ts'
const load = async (file: string): Promise<THREE.Group> => (await loadGlbFile(file)).scene
function verts (root: THREE.Group): Array<{ key: string, w: Map<string, number> }> {
  root.updateMatrixWorld(true)
  const out: Array<{ key: string, w: Map<string, number> }> = []
  const v = new THREE.Vector3()
  root.traverse(o => {
    const m = o as THREE.SkinnedMesh
    if (m.isSkinnedMesh !== true) return
    const p = m.geometry.attributes.position; const si = m.geometry.attributes.skinIndex; const sw = m.geometry.attributes.skinWeight
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld)
      const w = new Map<string, number>()
      for (let k = 0; k < 4; k++) { const x = sw.getComponent(i, k); if (x > 0) { const n = canonical(m.skeleton.bones[si.getComponent(i, k)].name); w.set(n, (w.get(n) ?? 0) + x) } }
      out.push({ key: `${Math.round(v.x * 2000)},${Math.round(v.y * 2000)},${Math.round(v.z * 2000)}`, w })
    }
  })
  return out
}
const [a, b, ...bones] = process.argv.slice(2)
const A = verts(await load(a)); const B = new Map(verts(await load(b)).map(x => [x.key, x.w]))
for (const bone of bones) {
  const sum = new Map<string, number>(); let n = 0
  for (const x of A) {
    if ((x.w.get(bone) ?? 0) < 0.9) continue
    const wb = B.get(x.key); if (wb === undefined) continue
    n++
    for (const [k, w] of wb) sum.set(k, (sum.get(k) ?? 0) + w)
  }
  console.log(`${bone} (${n} verts):`, [...sum].sort((p, q) => q[1] - p[1]).slice(0, 6).map(([k, w]) => `${k} ${(w / n * 100).toFixed(0)}%`).join('  '))
}
