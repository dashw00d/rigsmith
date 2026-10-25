// Where a rigid garment sits in its character's rest space: the one function the viewer (garments.ts) and the game
// export (tools/game_export.ts) both place it by, so the game gets it where Rigsmith shows it.
import * as THREE from 'three'
import type { Garment } from '../../server/workspace.ts'

export function garmentMatrix (g: Pick<Garment, 'position' | 'rotation' | 'scale'>): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...g.rotation.map(d => THREE.MathUtils.degToRad(d)) as [number, number, number]))
  return new THREE.Matrix4().compose(new THREE.Vector3(...g.position), q, new THREE.Vector3(g.scale, g.scale, g.scale))
}
