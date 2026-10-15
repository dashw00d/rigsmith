// Character list thumbnails, rendered offscreen: rest pose, three-quarter front, transparent background,
// the same lighting as the viewport. Independent of what the viewport is doing.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { CharacterView } from './CharacterView.ts'

const SIZE = 256

export class ThumbnailRenderer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(26, 1, 0.01, 100)

  constructor () {
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.AgXToneMapping
    this.renderer.toneMappingExposure = 1.1
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.55
    this.scene.add(new THREE.HemisphereLight(0xd4dcff, 0x1a1c22, 0.9))
    const key = new THREE.DirectionalLight(0xfff4e8, 2.2)
    key.position.set(2.5, 4, 3)
    const rim = new THREE.DirectionalLight(0x8ea2ff, 1.4)
    rim.position.set(-3, 2.5, -4)
    this.scene.add(key, rim)
  }

  /** WebP thumbnail of the model at `url`. */
  async render (url: string): Promise<Blob> {
    const view = await CharacterView.load(url)
    this.scene.add(view.root)
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
      this.renderer.render(this.scene, this.camera)
      return await new Promise((resolve, reject) => {
        this.renderer.domElement.toBlob(b => { b === null ? reject(new Error('thumbnail failed')) : resolve(b) }, 'image/webp', 0.9)
      })
    } finally {
      this.scene.remove(view.root)
      view.root.traverse(o => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) {
          mesh.geometry.dispose()
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose()
            m.dispose()
          }
        }
      })
    }
  }
}
