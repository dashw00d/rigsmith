// A UV repair may keep an authored rig as its collision/contact source. Use it
// only while the rendered triangles, skin and bind skeleton are still identical.
import * as THREE from 'three'

export function samePhysicalSurface (a: THREE.SkinnedMesh, b: THREE.SkinnedMesh): boolean {
  a.updateWorldMatrix(true, false); b.updateWorldMatrix(true, false)
  if (!a.matrixWorld.equals(b.matrixWorld) || !a.bindMatrix.equals(b.bindMatrix)) return false
  if (a.skeleton.bones.length !== b.skeleton.bones.length) return false
  for (let i = 0; i < a.skeleton.bones.length; i++) {
    if (a.skeleton.bones[i].name !== b.skeleton.bones[i].name || !a.skeleton.boneInverses[i].equals(b.skeleton.boneInverses[i])) return false
  }
  const ga = a.geometry, gb = b.geometry
  const count = ga.index?.count ?? ga.attributes.position.count
  if (count !== (gb.index?.count ?? gb.attributes.position.count)) return false
  for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) {
    const aa = ga.attributes[name], ab = gb.attributes[name]
    if ((aa === undefined) !== (ab === undefined)) return false
    if (aa === undefined) continue
    if (aa.itemSize !== ab.itemSize) return false
    for (let i = 0; i < count; i++) {
      const va = ga.index?.getX(i) ?? i, vb = gb.index?.getX(i) ?? i
      for (let k = 0; k < aa.itemSize; k++) if (aa.getComponent(va, k) !== ab.getComponent(vb, k)) return false
    }
  }
  return true
}
