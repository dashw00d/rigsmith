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
  const sameAttribute = (aa?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, ab?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): boolean => {
    if ((aa === undefined) !== (ab === undefined)) return false
    if (aa === undefined || ab === undefined) return true
    if (aa.itemSize !== ab.itemSize) return false
    for (let i = 0; i < count; i++) {
      const va = ga.index?.getX(i) ?? i, vb = gb.index?.getX(i) ?? i
      for (let k = 0; k < aa.itemSize; k++) if (aa.getComponent(va, k) !== ab.getComponent(vb, k)) return false
    }
    return true
  }
  for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) if (!sameAttribute(ga.attributes[name], gb.attributes[name])) return false
  const hasMorphs = (['position', 'normal'] as const).some(name => (ga.morphAttributes[name]?.length ?? 0) > 0 || (gb.morphAttributes[name]?.length ?? 0) > 0)
  if (!hasMorphs) return true
  if (ga.morphTargetsRelative !== gb.morphTargetsRelative) return false
  for (const name of ['position', 'normal'] as const) {
    const aa = ga.morphAttributes[name] ?? [], ab = gb.morphAttributes[name] ?? []
    if (aa.length !== ab.length) return false
    for (let i = 0; i < aa.length; i++) if (aa[i].name !== ab[i].name || !sameAttribute(aa[i], ab[i])) return false
  }
  const names = new Set([...Object.keys(a.morphTargetDictionary ?? {}), ...Object.keys(b.morphTargetDictionary ?? {})])
  for (const name of names) if (a.morphTargetDictionary?.[name] !== b.morphTargetDictionary?.[name]) return false
  const wa = a.morphTargetInfluences ?? [], wb = b.morphTargetInfluences ?? []
  if (wa.length !== wb.length || wa.some((value, i) => value !== wb[i])) return false
  return true
}
