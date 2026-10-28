// Projection painting workflow: mask on the model → views found and captured → (Codex or you) paint each view's
// result → baked together onto the texture → keep.
//
// The mask is painted on the model itself (src/engine/surfacemask.ts), so the camera stays free: left-drag on the
// model paints, off it the camera turns (right-drag pans, the wheel zooms). Capture finds the fewest views that see
// the masked surface squarely (projection.ts planViews) and writes each one's images; the results are projected back
// together, each texel weighted toward the view that saw it most squarely. Captures from before (one view, a mask
// drawn on that view) still open and bake as they did.
import * as THREE from 'three'
import { api, type Character } from './api.ts'
import { animator } from './animator.svelte.ts'
import { app } from './app.svelte.ts'
import { viewer } from './viewer.svelte.ts'
import { bakeProjection, bakeViews, captureFrom, cleanName, paintTarget, planViews, type ProjectionCamera } from '../engine/projection.ts'
import { SurfaceMask } from '../engine/surfacemask.ts'

export type PaintTool = 'smart' | 'wand' | 'brush' | 'erase' | 'navigate'

export interface CaptureView {
  name: string
  camera: ProjectionCamera
  mask: HTMLCanvasElement
}

export interface Capture {
  id: string
  folder: string
  views: CaptureView[]
  /** the mask in the texture's layout (null: a one-view capture from before, masked on its view) */
  uvMask: HTMLCanvasElement | null
}

class Painter {
  active = $state(false)
  tool = $state<PaintTool>('smart')
  /** Brush diameter on screen, in pixels. */
  brush = $state(48)
  /** 0..1 for the smart brush and wand: how far colors may differ before the selection stops. */
  tolerance = $state(0.35)
  contiguous = $state(true)
  notes = $state('')
  hasMask = $state(false)
  /** The brush on screen (the viewport's own pixels), while it is over the model. */
  cursor = $state<{ x: number, y: number } | null>(null)
  capture = $state.raw<Capture | null>(null)
  resultReady = $state(false)
  previewing = $state(false)
  busy = $state<string | null>(null)
  private mask: SurfaceMask | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private originalImage: unknown = null
  /** Results kept but not yet saved (a preview, then another capture started or opened on top): the texture the next
   * result is projected onto. Keep saves them all; Discard takes back only the latest. */
  private layerBase: HTMLCanvasElement | null = null
  /** How many results are kept as layers, unsaved. */
  layers = $state(0)
  private resultVersion: number | null = null
  private off: (() => void) | null = null
  private ray = new THREE.Raycaster()

  start (): void {
    animator.stop()
    viewer.setMode('shaded')
    const view = viewer.character
    const target = view === null ? null : paintTarget(view)
    if (view === null || target === null) { app.toast('error', 'This model has no color texture to paint on'); return }
    try {
      this.mask = new SurfaceMask(target.texture, target.meshes)
    } catch (error) {
      app.toast('error', (error as Error).message)
      return
    }
    this.mask.show(true)
    this.hasMask = false
    this.active = true
    this.tool = 'smart'
    this.attach()
  }

  /** Brushing on the model: left-drag on it paints (the camera held for the stroke), off it the camera turns. */
  private attach (): void {
    const stage = viewer.stage
    const view = viewer.character
    const mask = this.mask
    if (stage === null || view === null || mask === null) return
    const canvas = stage.renderer.domElement
    const targets = mask.parts.map(p => p.mesh)
    type Hit = { part: number, face: number, point: THREE.Vector3, uv: THREE.Vector2 } | null
    const pick = (x: number, y: number): { hit: Hit, onModel: boolean } => {
      const r = canvas.getBoundingClientRect()
      this.ray.setFromCamera(new THREE.Vector2((x - r.left) / r.width * 2 - 1, 1 - (y - r.top) / r.height * 2), stage.camera)
      for (const m of view.skinned) m.computeBoundingSphere()
      const first = this.ray.intersectObjects(view.meshes, false)[0]
      if (first === undefined) return { hit: null, onModel: false }
      const part = targets.indexOf(first.object as THREE.Mesh)
      if (part < 0 || first.faceIndex === undefined || first.faceIndex === null || first.uv === undefined) return { hit: null, onModel: true }
      return { hit: { part, face: first.faceIndex, point: first.point, uv: first.uv }, onModel: true }
    }
    /** The brush's radius in world units where it lands. */
    const radiusAt = (point: THREE.Vector3): number => {
      const distance = stage.camera.position.distanceTo(point)
      const perPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(stage.camera.fov) / 2) / Math.max(canvas.clientHeight, 1)
      return Math.max(this.brush / 2 * perPixel, 1e-4)
    }
    let stroking = false
    let erase = false
    let last: { x: number, y: number } | null = null
    let reference: [number, number, number] | undefined
    const paintAt = (x: number, y: number): void => {
      const { hit } = pick(x, y)
      if (hit === null || this.mask === null) return
      const value = this.tool === 'erase' || erase ? 0 : 1
      this.mask.dab(hit.part, hit.face, hit.point, radiusAt(hit.point), value, this.tool === 'smart' ? reference : undefined, this.tolerance)
    }
    const down = (e: PointerEvent): void => {
      if (e.button !== 0 || this.tool === 'navigate' || this.previewing || this.mask === null) return
      const { hit, onModel } = pick(e.clientX, e.clientY)
      if (!onModel) return   // (off the model: the camera turns)
      e.stopPropagation(); e.preventDefault()
      if (hit === null) return
      if (this.tool === 'wand') {
        this.mask.wand(hit.part, hit.face, this.mask.colorAt(hit.uv), e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace', this.tolerance, this.contiguous)
        this.hasMask = this.mask.any
        return
      }
      stage.controls.enabled = false
      stroking = true
      erase = e.altKey
      reference = this.mask.colorAt(hit.uv)
      last = { x: e.clientX, y: e.clientY }
      paintAt(e.clientX, e.clientY)
    }
    const move = (e: PointerEvent): void => {
      const r = canvas.getBoundingClientRect()
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      this.cursor = inside && this.tool !== 'navigate' && this.tool !== 'wand' && !this.previewing ? { x: e.clientX - r.left, y: e.clientY - r.top } : null
      if (!stroking || last === null) return
      // (dabs spaced along a fast stroke, so it stays whole)
      const steps = Math.min(6, Math.max(1, Math.ceil(Math.hypot(e.clientX - last.x, e.clientY - last.y) / Math.max(this.brush / 3, 2))))
      for (let s = 1; s <= steps; s++) paintAt(last.x + (e.clientX - last.x) * s / steps, last.y + (e.clientY - last.y) * s / steps)
      last = { x: e.clientX, y: e.clientY }
    }
    const up = (): void => {
      if (!stroking) return
      stroking = false
      last = null
      stage.controls.enabled = true
      this.hasMask = this.mask?.any ?? false
    }
    const leave = (): void => { this.cursor = null }
    canvas.addEventListener('pointerdown', down, { capture: true })
    canvas.addEventListener('pointerleave', leave)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    this.off = () => {
      canvas.removeEventListener('pointerdown', down, { capture: true })
      canvas.removeEventListener('pointerleave', leave)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      stage.controls.enabled = true
    }
  }

  growMask (texels: number): void { this.mask?.grow(texels); this.hasMask = this.mask?.any ?? false }
  invertMask (): void { this.mask?.invert(); this.hasMask = this.mask?.any ?? false }
  clearMask (): void { this.mask?.clear(); this.hasMask = false }

  stop (): void {
    this.discardAll()
    this.active = false
    this.stopPolling()
    this.off?.(); this.off = null
    this.mask?.dispose(); this.mask = null
    this.cursor = null
    this.capture = null
  }

  /** A preview showing becomes a layer under what comes next (another capture's result is projected on top of it). */
  private layerPreview (): void {
    if (!this.previewing || this.bakedCanvas === null) return
    this.layerBase = this.bakedCanvas
    this.layers++
    this.bakedCanvas = null
    this.previewing = false
  }

  /** Find the views that see the masked surface, and write each one's images for painting. */
  async captureViews (character: Character): Promise<void> {
    const stage = viewer.stage
    const view = viewer.character
    const mask = this.mask
    if (stage === null || view === null || mask === null) return
    if (!mask.any) { app.toast('error', 'Paint over the area to repaint first'); return }
    // (a result showing stays: this capture is of the texture with it, and its result goes on top of it)
    this.layerPreview()
    this.busy = 'Finding the views'
    try {
      animator.stop()
      const planned = planViews(stage.renderer, view, mask.samples(), stage.camera.fov)
      if (planned.length === 0) { app.toast('error', 'No view sees the masked area'); return }
      this.busy = `Capturing ${planned.length} view${planned.length === 1 ? '' : 's'}`
      const id = `p${Date.now().toString(36)}`
      const put = async (file: string, data: Blob): Promise<string> => (await api.putProjectionFile(character.id, id, file, data)).path
      const views: CaptureView[] = []
      // (each view's mask drawn from the mask spread past the seams: else every seam inside it is a line left as it was)
      const seamless = mask.paddedTexture()
      for (const [i, p] of planned.entries()) {
        const shot = await captureFrom(stage, view, p.camera, seamless)
        const n = i + 1
        await put(`view-${n}-color.png`, shot.color)
        await put(`view-${n}-flat.png`, shot.flat)
        await put(`view-${n}-depth.png`, shot.depth)
        await put(`view-${n}-normal.png`, shot.normal)
        await put(`view-${n}-mask.png`, shot.mask)
        views.push({ name: p.name, camera: shot.camera, mask: await canvasOf(shot.mask) })
      }
      seamless.dispose()
      const uvMask = mask.padded()
      await put('uvmask.png', await blobOf(uvMask))
      await put('views.json', new Blob([JSON.stringify({ views: views.map(v => ({ name: v.name, camera: v.camera })) }, null, 2)], { type: 'application/json' }))
      const last = await put('prompt.md', new Blob([promptForViews(views, this.notes, character.name)], { type: 'text/markdown' }))
      this.capture = { id, folder: last.replace(/\/prompt\.md$/, ''), views, uvMask }
      this.resultReady = false
      this.resultVersion = null
      this.startPolling(character)
    } catch (error) {
      app.toast('error', (error as Error).message)
    } finally {
      this.busy = null
    }
  }

  /** Pick up an earlier capture (e.g. after a reload, or a result painted outside the app). */
  async resume (character: Character, id: string): Promise<void> {
    try {
      const base = `/files/characters/${character.id}/projections/${id}`
      const info = await api.projection(character.id, id)
      let capture: Capture
      if (info.files.includes('views.json')) {
        const list = await (await fetch(`${base}/views.json?v=${Date.now()}`)).json() as { views: Array<{ name: string, camera: ProjectionCamera }> }
        const views = await Promise.all(list.views.map(async (v, i) => ({ name: v.name, camera: v.camera, mask: await fitted(await loadImage(`${base}/view-${i + 1}-mask.png?v=${Date.now()}`), v.camera) })))
        const uvImage = await loadImage(`${base}/uvmask.png?v=${Date.now()}`)
        const uvMask = document.createElement('canvas')
        uvMask.width = uvImage.width; uvMask.height = uvImage.height
        uvMask.getContext('2d')!.drawImage(uvImage, 0, 0)
        capture = { id, folder: info.path, views, uvMask }
      } else {
        const camera = await (await fetch(`${base}/camera.json`)).json() as ProjectionCamera
        capture = { id, folder: info.path, views: [{ name: 'view', camera, mask: await fitted(await loadImage(`${base}/mask.png?v=${Date.now()}`), camera) }], uvMask: null }
      }
      if (!this.active) this.start()
      // (a result showing from another capture stays, under this one's)
      if (this.capture?.id !== id) this.layerPreview(); else this.discard()
      // (the capture's mask back on the model, to see what it covers and to start again from)
      if (capture.uvMask !== null) { this.mask?.load(capture.uvMask); this.hasMask = this.mask?.any ?? false }
      this.tool = 'navigate'
      this.capture = capture
      this.resultReady = false
      this.resultVersion = null
      this.startPolling(character)
      await this.check(character)
    } catch (error) {
      app.toast('error', (error as Error).message)
    }
  }

  async askCodex (character: Character): Promise<void> {
    if (this.capture === null) return
    try {
      await api.codex(character.id, this.capture.id)
      app.toast('info', 'Codex is painting. The result is picked up automatically.')
    } catch (error) {
      app.toast('error', (error as Error).message)
    }
  }

  private startPolling (character: Character): void {
    this.stopPolling()
    this.poll = setInterval(() => { void this.check(character) }, 2000)
  }

  private stopPolling (): void {
    if (this.poll !== null) clearInterval(this.poll)
    this.poll = null
  }

  private async check (character: Character): Promise<void> {
    const capture = this.capture
    if (capture === null) return
    const info = await api.projection(character.id, capture.id)
    if (info.result !== null && info.resultVersion !== this.resultVersion) {
      this.resultVersion = info.resultVersion
      this.resultReady = true
      const base = `/files/characters/${character.id}/projections/${capture.id}`
      const files = info.results ?? [info.result]
      await this.preview(files.map(f => `${base}/${f}?v=${info.resultVersion ?? 0}`))
    }
  }

  /** Use a dropped/picked image as the result (one-view captures). */
  async useFile (character: Character, file: File): Promise<void> {
    if (this.capture === null || this.capture.views.length !== 1) return
    await api.putProjectionFile(character.id, this.capture.id, this.capture.uvMask === null ? 'result.png' : 'result-1.png', file)
    await this.check(character)
  }

  private async preview (urls: string[]): Promise<void> {
    const view = viewer.character
    const stage = viewer.stage
    const capture = this.capture
    if (view === null || stage === null || capture === null) return
    this.busy = 'Projecting onto the texture'
    try {
      animator.stop()
      const results = await Promise.all(urls.map(async (url, i) => await fitted(await loadImage(url), capture.views[i].camera)))
      const target = paintTarget(view)!
      if (this.originalImage === null) this.originalImage = target.texture.image
      // (onto the texture as saved, with the results kept on it: never onto this capture's own earlier preview)
      const original = (this.layerBase ?? this.originalImage) as HTMLImageElement | ImageBitmap | HTMLCanvasElement
      const baked = capture.uvMask === null
        ? bakeProjection(stage.renderer, view, capture.views[0].camera, results[0], capture.views[0].mask, original)
        : bakeViews(stage.renderer, view, capture.views.map((v, i) => ({ camera: v.camera, result: results[i], mask: v.mask })), capture.uvMask, original)
      target.texture.image = baked
      target.texture.needsUpdate = true
      this.previewing = true
      this.mask?.show(false)
      this.bakedCanvas = baked
    } catch (error) {
      app.toast('error', (error as Error).message)
    } finally {
      this.busy = null
    }
  }

  private bakedCanvas: HTMLCanvasElement | null = null

  /** Take back the result showing: the texture as it was before it (with the results kept under it, if any). */
  discard (): void {
    const view = viewer.character
    const back = this.layerBase ?? this.originalImage
    if (view !== null && back !== null) {
      const target = paintTarget(view)
      if (target !== null) {
        target.texture.image = back as HTMLImageElement
        target.texture.needsUpdate = true
      }
    }
    if (this.layerBase === null) this.originalImage = null
    if (this.previewing && this.active) this.mask?.show(true)
    this.previewing = false
    this.bakedCanvas = null
  }

  /** Take back everything not saved: the texture as saved. */
  discardAll (): void {
    this.layerBase = null
    this.layers = 0
    this.discard()
  }

  /** Save the texture as shown: the result previewed, with every result kept under it. */
  async keep (character: Character): Promise<void> {
    const view = viewer.character
    const painted = this.bakedCanvas ?? this.layerBase
    if (view === null || painted === null) return
    const target = paintTarget(view)
    if (target === null) return
    this.busy = 'Saving the texture'
    try {
      await api.saveTexture(character.id, cleanName(target.texture.name || 'texture'), await blobOf(painted))
      this.originalImage = null
      this.layerBase = null
      this.layers = 0
      this.bakedCanvas = null
      this.previewing = false
      this.capture = null
      this.stopPolling()
      this.mask?.show(true)
      this.clearMask()
      app.toast('ok', 'Painting applied: putting it into the rig in the background.')
    } catch (error) {
      app.toast('error', (error as Error).message)
    } finally {
      this.busy = null
    }
  }
}

/** An image file decoded. (Not HTMLImageElement.decode: in some windows it never settles.) */
async function loadImage (url: string): Promise<ImageBitmap> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load ${url.replace(/\?.*$/, '')} (${response.status})`)
  return await createImageBitmap(await response.blob())
}

/** An image drawn at a capture's exact size. */
async function fitted (image: ImageBitmap | HTMLCanvasElement, camera: ProjectionCamera): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = camera.width; canvas.height = camera.height
  canvas.getContext('2d')!.drawImage(image, 0, 0, camera.width, camera.height)
  return canvas
}

async function canvasOf (blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width; canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas
}

async function blobOf (canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise(resolve => { canvas.toBlob(b => { resolve(b!) }, 'image/png') })
}

function promptForViews (views: CaptureView[], notes: string, name: string): string {
  const many = views.length > 1
  const list = views.map((v, i) => `- View ${i + 1} (${v.name}): view-${i + 1}-flat.png + view-${i + 1}-mask.png → result-${i + 1}.png`).join('\n')
  // (short and to the point: one image edit a view, nothing else. Rigsmith bakes only the masked part of each result
  // back onto the texture, at whatever size it comes, so compositing, resizing or checking it is wasted time)
  return `# Repaint request: ${name}

For each view N, view-N-flat.png is the character's texture seen from that camera (unlit) and view-N-mask.png marks
in white the area to repaint.

${list}

${notes.trim() !== '' ? `What to change: ${notes.trim()}\n\n` : ''}Task: for each view, make ONE edit of view-N-flat.png with your built-in image generation tool: repaint only the white
area of the mask, in the same hand-painted, stylized game-texture style as the rest, with no new lighting or shadows.
Keep the framing: nothing moved, cropped or zoomed.${many ? ' The views show one object from different sides: paint it as one design, so details match where they overlap.' : ''}
Save it as result-N.png in this folder.

That is all. Do not composite, resize, crop or check the result, and don't open other files: Rigsmith keeps
everything outside the mask and handles the size itself. One generation per view; retry only if the tool fails.
`
}

export const painter = new Painter()
