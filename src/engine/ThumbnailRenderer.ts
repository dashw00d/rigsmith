// Character list thumbnails: rest pose, three-quarter front, transparent background, the viewport's lighting
// (src/engine/lighting.ts), drawn on the shared offscreen renderer (src/engine/offscreen.ts). Independent of what the
// viewport is doing.
import * as THREE from 'three'
import { CharacterView } from './CharacterView.ts'
import { light } from './lighting.ts'
import { encode, grab, offscreen } from './offscreen.ts'

const SIZE = 256

export class ThumbnailRenderer {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(26, 1, 0.01, 100)
  private lit = false

  /** WebP thumbnail of the model at `url`. */
  async render (url: string): Promise<Blob> {
    const view = await CharacterView.load(url)
    try {
      const size = view.box.getSize(new THREE.Vector3())
      const center = view.box.getCenter(new THREE.Vector3())
      // Fit the taller of height and (slightly discounted) width, with a little headroom.
      const extent = Math.max(size.y, size.x * 0.85, size.z * 0.85) * 1.12
      const distance = extent / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
      const direction = new THREE.Vector3(0.38, 0.12, 1).normalize()
      this.camera.position.copy(center).addScaledVector(direction, distance)
      this.camera.lookAt(center)
      this.camera.near = distance * 0.05
      this.camera.far = distance * 4
      this.camera.updateProjectionMatrix()
      const picture = await offscreen(SIZE, SIZE, renderer => {
        if (!this.lit) { light(this.scene, renderer); this.lit = true }
        this.scene.add(view.root)
        try {
          renderer.render(this.scene, this.camera)
          return grab(renderer)
        } finally {
          this.scene.remove(view.root)
        }
      })
      return await encode(picture)
    } finally {
      view.dispose()
    }
  }
}
