import * as THREE from 'three'

/** Bake an owned, unrendered geometry without leaving its corrective targets in the old frame. Three's
 * applyMatrix4 changes base attributes only. Relative positions use the linear map; absolute targets include translation. */
export function applyGeometryMatrix (geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const positions = geometry.morphAttributes.position ?? []
  const normals = geometry.morphAttributes.normal ?? []
  if (positions.length === 0 && normals.length === 0) return geometry.applyMatrix4(matrix)
  const baseNormal = geometry.attributes.normal
  if (normals.length > 0 && baseNormal === undefined) throw new Error('Normal correction targets need base normals')
  const linear = new THREE.Matrix3().setFromMatrix4(matrix)
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix)
  const v = new THREE.Vector3()
  // Different channels may share a cached/interleaved accessor, even after geometry.clone(). Give EVERY channel
  // independent float storage before changing it. XYZ accessors decode Float16 as well as normalized integers.
  for (const targets of [positions, normals]) for (let t = 0; t < targets.length; t++) {
    const source = targets[t]
    const copy = new THREE.Float32BufferAttribute(new Float32Array(source.count * source.itemSize), source.itemSize)
    for (let i = 0; i < source.count; i++) copy.setXYZ(i, source.getX(i), source.getY(i), source.getZ(i))
    copy.name = source.name
    targets[t] = copy
  }
  for (const target of positions) {
    for (let i = 0; i < target.count; i++) {
      v.fromBufferAttribute(target, i)
      if (geometry.morphTargetsRelative) v.applyMatrix3(linear)
      else v.applyMatrix4(matrix)
      target.setXYZ(i, v.x, v.y, v.z)
    }
    target.needsUpdate = true
  }
  for (let i = 0; i < (baseNormal?.count ?? 0) && normals.length > 0; i++) {
    const baseLength = v.fromBufferAttribute(baseNormal, i).applyMatrix3(normalMatrix).length()
    for (const target of normals) {
      v.fromBufferAttribute(target, i).applyMatrix3(normalMatrix)
      // The base is normalized by applyMatrix4 below. Use the SAME divisor on each target, so normalized blended
      // normals match transforming the original blend at every influence, including several active targets.
      if (baseLength > 0) v.multiplyScalar(1 / baseLength)
      target.setXYZ(i, v.x, v.y, v.z)
    }
  }
  for (const target of normals) target.needsUpdate = true
  geometry.applyMatrix4(matrix)
  if (positions.length > 0 && geometry.boundingSphere !== null) {
    // Three's sphere checks targets individually. The box also encloses simultaneous relative influences in
    // [0,1], so its sphere keeps crossfaded correction channels inside the cached geometry bounds.
    geometry.computeBoundingBox()
    geometry.boundingBox!.getBoundingSphere(geometry.boundingSphere)
    geometry.boundingSphere.radius *= 1 + 4 * Number.EPSILON
  }
  return geometry
}
