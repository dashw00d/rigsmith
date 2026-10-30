// Renders small animated sprite sheets of library clips playing on the current character, with the viewport's lighting
// (src/engine/lighting.ts), on the shared offscreen renderer (src/engine/offscreen.ts).
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { RetargetCache } from './clips.ts'
import { light } from './lighting.ts'
import { encode, offscreen } from './offscreen.ts'
import { captureRest } from './retarget.ts'

export const SPRITE_FRAMES = 16
const SIZE = 144

export class PreviewRenderer {
  private readonly scene = new THREE.Scene()
  private lit = false
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100)
  private model: THREE.Object3D | null = null
  private retargets: RetargetCache | null = null
  private readonly sheets = new Map<string, string>()
  private queue: Array<{ url: string, resolve: (u: string | null) => void }> = []
  private working = false
  private key = ''

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
    // The character may be posed right now (a clip playing): the rest is read from the skeleton's inverse binds, as
    // CharacterView.setRename does, so clips aren't retargeted onto whatever pose it was caught in.
    const skinned: THREE.SkinnedMesh[] = []
    model.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh) })
    skinned[0]?.skeleton.pose()
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

  private async render (url: string, tries = 3): Promise<string | null> {
    if (this.model === null || this.retargets === null || tries <= 0) return null
    let key = this.key
    let clip = await this.retargets.get(url, { inPlace: true, samples: SPRITE_FRAMES + 1 })
    while (key !== this.key && this.retargets !== null) {
      // The subject changed while baking: bake again for the new one.
      key = this.key
      clip = await this.retargets.get(url, { inPlace: true, samples: SPRITE_FRAMES + 1 })
    }
    if (this.model === null) return null
    const model = this.model
    const sheet = document.createElement('canvas')
    sheet.width = SIZE * SPRITE_FRAMES
    sheet.height = SIZE
    const ctx = sheet.getContext('2d')!
    const drawn = await offscreen(SIZE, SIZE, renderer => {
      // (another character took the stage while this waited its turn: its sheet is baked again for that one)
      if (model !== this.model) return false
      if (!this.lit) { light(this.scene, renderer); this.lit = true }
      const mixer = new THREE.AnimationMixer(model)
      const action = mixer.clipAction(clip)
      action.play()
      try {
        for (let i = 0; i < SPRITE_FRAMES; i++) {
          mixer.setTime((clip.duration * i) / SPRITE_FRAMES)
          renderer.render(this.scene, this.camera)
          ctx.drawImage(renderer.domElement, i * SIZE, 0)
        }
      } finally {
        action.stop()
        mixer.uncacheRoot(model)
      }
      return true
    })
    if (!drawn) return await this.render(url, tries - 1)
    let blob: Blob | null
    try { blob = await encode(sheet, 'image/webp', 0.85) } catch { blob = null }
    if (blob === null || key !== this.key) return null
    const objectUrl = URL.createObjectURL(blob)
    this.sheets.set(url, objectUrl)
    return objectUrl
  }
}
