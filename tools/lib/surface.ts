// Read the same deformed skin the renderer shows, with stable face identities.
import * as THREE from 'three'
import { canonical } from '../../src/engine/retarget.ts'
import { SurfaceContacts } from '../../src/engine/surfacecontact.ts'

const region = (name: string): string => {
  const n = canonical(name)
  if (/Hand/.test(n)) return n.startsWith('Left') ? 'LeftHand' : 'RightHand'
  if (/^Spine/.test(n)) return 'Torso'
  if (/^Head/.test(n)) return 'Head'
  return n.replace(/Toe.*$/, 'Foot')
}

export class SkinnedSurface {
  readonly root: THREE.Object3D
  readonly positions: Float64Array
  readonly index: number[] = []
  readonly regions: string[] = []
  readonly parts: Array<{ mesh: THREE.SkinnedMesh, offset: number }> = []
  readonly contacts: SurfaceContacts
  private readonly point = new THREE.Vector3()

  constructor (root: THREE.Object3D, weldTolerance = 1e-7) {
    this.root = root
    let vertices = 0
    root.traverse(o => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        const mesh = o as THREE.SkinnedMesh
        this.parts.push({ mesh, offset: vertices }); vertices += mesh.geometry.attributes.position.count
      }
    })
    this.positions = new Float64Array(vertices*3)
    this.read()
    const keys = new Map<string, number>(), aliases = new Uint32Array(vertices)
    for (let v = 0; v < vertices; v++) {
      const key = [0,1,2].map(k => Math.round(this.positions[v*3+k]/weldTolerance)).join(',')
      if (!keys.has(key)) keys.set(key, keys.size)
      aliases[v] = keys.get(key)!
    }
    for (const { mesh, offset } of this.parts) {
      const geo = mesh.geometry, indices = geo.index, count = indices?.count ?? geo.attributes.position.count
      const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight
      for (let f = 0; f < count; f += 3) {
        const influence = new Map<string, number>()
        for (let k = 0; k < 3; k++) {
          const v = indices?.getX(f+k) ?? f+k
          this.index.push(v+offset)
          for (let j = 0; j < 4; j++) {
            const name = region(mesh.skeleton.bones[si.getComponent(v,j)].name)
            influence.set(name, (influence.get(name) ?? 0) + sw.getComponent(v,j))
          }
        }
        this.regions.push([...influence].sort((a,b) => b[1]-a[1])[0]?.[0] ?? 'unknown')
      }
    }
    this.contacts = new SurfaceContacts(this.positions,this.index,aliases)
  }

  read (): Float64Array {
    this.root.updateMatrixWorld(true)
    for (const { mesh, offset } of this.parts) {
      mesh.skeleton.update()
      for (let v = 0; v < mesh.geometry.attributes.position.count; v++) mesh.getVertexPosition(v,this.point).applyMatrix4(mesh.matrixWorld).toArray(this.positions,(offset+v)*3)
    }
    return this.positions
  }

  crossings (epsilon = 1e-7): ReturnType<SurfaceContacts['crossings']> {
    this.contacts.refit(this.read())
    return this.contacts.crossings(epsilon)
  }
}
