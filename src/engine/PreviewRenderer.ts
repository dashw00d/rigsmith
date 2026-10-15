// Renders small animated sprite sheets of library clips playing on the current character.
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { RetargetCache } from './clips.ts'
import { captureRest } from './retarget.ts'

export const SPRITE_FRAMES = 16
const SIZE = 144

export class PreviewRenderer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100)
  private model: THREE.Object3D | null = null
  private retargets: RetargetCache | null = null
  private readonly sheets = new Map<string, string>()
  private queue: Array<{ url: string, resolve: (u: string | null) => void }> = []
  private working = false
  private key = ''

  constructor () {
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.AgXToneMapping
    this.renderer.toneMappingExposure = 1.15
    this.scene.add(new THREE.HemisphereLight(0xd4dcff, 0x20232b, 1.6))
    const key = new THREE.DirectionalLight(0xfff4e8, 2.4)
    key.position.set(2, 4, 3)
    const rim = new THREE.DirectionalLight(0x8ea2ff, 1.2)
    rim.position.set(-3, 2, -3)
    this.scene.add(key, rim)
  }

  /** Use a character (any loaded skinned scene) for previews. Clears cached sheets when it changes. */
  setCharacter (key: string, root: THREE.Object3D, rename?: (name: string) => string | null): void {
    if (key === this.key) return
    this.key = key
    if (this.model !== null) this.scene.remove(this.model)
    for (const url of this.sheets.values()) URL.revokeObjectURL(url)
    this.sheets.clear()
    // Pending requests stay queued and will render with the new subject.
    const model = cloneSkinned(root)
    model.position.set(0, 0, 0)
    this.scene.add(model)
    this.model = model
    this.retargets = new RetargetCache(captureRest(model, o => (o as THREE.Bone).isBone === true, rename))
    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const h = Math.max(size.y, size.x * 0.8) * 1.25
    const distance = h / 2 / Math.tan(THREE.MathUtils.degToRad(15))
    this.camera.position.set(center.x + distance * 0.35, center.y + h * 0.08, center.z + distance * 0.94)
    this.camera.lookAt(center.x, center.y - h * 0.04, center.z)
    this.camera.near = distance * 0.05
    this.camera.far = distance * 4
    this.camera.updateProjectionMatrix()
  }

  /** Object URL of a horizontal sprite sheet (SPRITE_FRAMES frames), or null if cancelled/failed. */
  async sheet (clipUrl: string): Promise<string | null> {
    const cached = this.sheets.get(clipUrl)
    if (cached !== undefined) return cached
    return await new Promise(resolve => {
      this.queue.push({ url: clipUrl, resolve })
      void this.pump()
    })
  }

  /** Drop pending requests (e.g. when the library page changes). */
  cancelPending (): void {
    this.queue.forEach(q => { q.resolve(null) })
    this.queue = []
  }

  private async pump (): Promise<void> {
    if (this.working) return
    this.working = true
    while (this.queue.length > 0) {
      const job = this.queue.shift()!
      try {
        job.resolve(await this.render(job.url))
      } catch {
        job.resolve(null)
      }
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    this.working = false
  }

  private async render (url: string): Promise<string | null> {
    if (this.model === null || this.retargets === null) return null
    let key = this.key
    let clip = await this.retargets.get(url, { inPlace: true, samples: SPRITE_FRAMES + 1 })
    while (key !== this.key && this.retargets !== null) {
      // The subject changed while baking: bake again for the new one.
      key = this.key
      clip = await this.retargets.get(url, { inPlace: true, samples: SPRITE_FRAMES + 1 })
    }
    if (this.model === null) return null
    const mixer = new THREE.AnimationMixer(this.model)
    const action = mixer.clipAction(clip)
    action.play()
    const sheet = document.createElement('canvas')
    sheet.width = SIZE * SPRITE_FRAMES
    sheet.height = SIZE
    const ctx = sheet.getContext('2d')!
    for (let i = 0; i < SPRITE_FRAMES; i++) {
      mixer.setTime((clip.duration * i) / SPRITE_FRAMES)
      this.renderer.render(this.scene, this.camera)
      ctx.drawImage(this.renderer.domElement, i * SIZE, 0)
    }
    action.stop()
    mixer.uncacheRoot(this.model)
    const blob = await new Promise<Blob | null>(resolve => { sheet.toBlob(resolve, 'image/webp', 0.85) })
    if (blob === null || key !== this.key) return null
    const objectUrl = URL.createObjectURL(blob)
    this.sheets.set(url, objectUrl)
    return objectUrl
  }
}
