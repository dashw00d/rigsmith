import * as THREE from 'three'
import type { Stage } from './Stage.ts'
import type { BodySurface } from './garments.ts'
import type { RegionState } from './coverage.ts'

/** A skinned copy of the full body, so regions hidden under gear remain visible. */
export class CoverageOverlay {
  private readonly meshes: Array<{ source: THREE.SkinnedMesh, copy: THREE.SkinnedMesh, offset: number }> = []
  private readonly material = new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false })
  private readonly offFrame: () => void

  constructor (body: BodySurface, stage: Stage) {
    for (const [index, source] of body.meshes.entries()) {
      if (source.parent === null) continue
      const geometry = source.geometry.clone()
      const full = source.userData.fullIndex as THREE.BufferAttribute | null | undefined
      if (full !== undefined) geometry.setIndex(full === null ? null : full.clone())
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3))
      const copy = source.clone(false)
      copy.geometry = geometry
      copy.material = this.material
      copy.name = 'coverage-region-overlay'
      copy.renderOrder = 1000
      copy.frustumCulled = false
      copy.castShadow = false
      copy.receiveShadow = false
      source.parent.add(copy)
      this.meshes.push({ source, copy, offset: body.offsets[index] })
    }
    this.offFrame = stage.onFrame(() => {
      for (const { source, copy } of this.meshes) {
        copy.position.copy(source.position); copy.quaternion.copy(source.quaternion); copy.scale.copy(source.scale)
        if (source.morphTargetInfluences !== undefined && copy.morphTargetInfluences !== undefined) {
          for (let i = 0; i < source.morphTargetInfluences.length; i++) copy.morphTargetInfluences[i] = source.morphTargetInfluences[i]
        }
      }
    })
  }

  update (body: BodySurface, states: readonly RegionState[], hover: number | null): void {
    const bare = new THREE.Color('#35b871'); const partial = new THREE.Color('#ecae37'); const hidden = new THREE.Color('#e45252')
    const selected = new THREE.Color('#7cbcff')
    const palette = states.map(s => s.region === hover ? selected : s.state === 'hidden' ? hidden : s.state === 'partial' ? bare.clone().lerp(partial, s.pct / 100) : bare)
    for (const { copy, offset } of this.meshes) {
      const colors = copy.geometry.getAttribute('color') as THREE.BufferAttribute
      for (let i = 0; i < colors.count; i++) {
        const region = body.regions.of[offset + i]
        const color = palette[region] ?? bare
        colors.setXYZ(i, color.r, color.g, color.b)
      }
      colors.needsUpdate = true
    }
  }

  dispose (): void {
    this.offFrame()
    for (const { copy } of this.meshes) { copy.removeFromParent(); copy.geometry.dispose() }
    this.material.dispose()
  }
}
