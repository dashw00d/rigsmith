// Projection painting workflow: mask → capture → (Codex or you) paint result.png → bake → keep.
import { api, type Character } from './api.ts'
import { animator } from './animator.svelte.ts'
import { app } from './app.svelte.ts'
import { viewer } from './viewer.svelte.ts'
import { analyzeView, bakeProjection, captureView, cleanName, paintTarget, type ProjectionCamera } from '../engine/projection.ts'
import { buildEdges, grow, morph, type Analysis } from '../engine/selection.ts'

export type PaintTool = 'smart' | 'wand' | 'brush' | 'erase' | 'navigate'

export interface Capture {
  id: string
  folder: string
  camera: ProjectionCamera
  mask: HTMLCanvasElement
}

class Painter {
  active = $state(false)
  tool = $state<PaintTool>('smart')
  brush = $state(48)
  /** 0..1 for the smart brush and wand: how far colors may differ before the selection stops. */
  tolerance = $state(0.35)
  contiguous = $state(true)
  /** Bumped whenever the mask changes so the overlay redraws. */
  maskVersion = $state(0)
  /** Selected pixels at viewport resolution (1 = repaint). */
  maskData: Uint8Array | null = null
  maskWidth = 0
  maskHeight = 0
  private analysis: Analysis | null = null
  private analysisKey = ''
  notes = $state('')
  hasMask = $state(false)
  capture = $state.raw<Capture | null>(null)
  resultReady = $state(false)
  previewing = $state(false)
  busy = $state<string | null>(null)
  private poll: ReturnType<typeof setInterval> | null = null
  private originalImage: unknown = null
  private resultVersion: number | null = null

  start (): void {
    animator.stop()
    viewer.setMode('shaded')
    this.active = true
    this.tool = 'smart'
  }

  /** Resize the mask to the viewport (keeps nothing: a new size means a new view). */
  ensureMask (width: number, height: number): void {
    if (this.maskData === null || this.maskWidth !== width || this.maskHeight !== height) {
      this.maskData = new Uint8Array(width * height)
      this.maskWidth = width
      this.maskHeight = height
      this.hasMask = false
      this.maskVersion++
    }
  }

  private cameraKey (): string {
    const stage = viewer.stage
    if (stage === null) return ''
    return `${this.maskWidth}x${this.maskHeight}|${stage.camera.matrixWorld.elements.map(v => v.toFixed(4)).join(',')}`
  }

  /** Color/normal/depth buffers and edges for the current view (recomputed when the camera moves). */
  getAnalysis (): Analysis | null {
    const stage = viewer.stage
    const view = viewer.character
    if (stage === null || view === null || this.maskWidth === 0) return null
    const key = this.cameraKey()
    if (this.analysis === null || key !== this.analysisKey) {
      if (this.analysisKey !== '' && key !== this.analysisKey && this.hasMask) {
        // The view changed under a screen-space mask: it no longer lines up.
        this.clearMask()
        app.toast('info', 'The camera moved, so the mask was cleared')
      }
      const buffers = analyzeView(stage, view, this.maskWidth, this.maskHeight)
      const partial = { width: this.maskWidth, height: this.maskHeight, ...buffers }
      this.analysis = { ...partial, edges: buildEdges(partial) }
      this.analysisKey = key
    }
    return this.analysis
  }

  private set (indices: Int32Array | number[], value: 0 | 1): void {
    if (this.maskData === null) return
    for (const i of indices) this.maskData[i] = value
    this.hasMask = this.maskData.some(v => v === 1)
    this.maskVersion++
  }

  /** Plain round brush (or eraser). */
  dab (x: number, y: number, value: 0 | 1): void {
    if (this.maskData === null) return
    const r = this.brush / 2
    const out: number[] = []
    for (let yy = Math.max(0, Math.floor(y - r)); yy <= Math.min(this.maskHeight - 1, Math.ceil(y + r)); yy++) {
      for (let xx = Math.max(0, Math.floor(x - r)); xx <= Math.min(this.maskWidth - 1, Math.ceil(x + r)); xx++) {
        if ((xx - x) ** 2 + (yy - y) ** 2 <= r * r) out.push(yy * this.maskWidth + xx)
      }
    }
    this.set(out, value)
  }

  private strokeColor: [number, number, number] | null = null

  /** Smart brush: grow inside the brush circle, locked to the color where the stroke began, stopping at edges. */
  smartDab (x: number, y: number, value: 0 | 1, first: boolean): void {
    const a = this.getAnalysis()
    if (a === null || this.maskData === null) return
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= a.width || py >= a.height) return
    if (first) {
      const i = (py * a.width + px) * 4
      this.strokeColor = a.color[i + 3] < 128 ? null : [a.color[i], a.color[i + 1], a.color[i + 2]]
    }
    if (this.strokeColor === null) return
    const r = this.brush / 2
    // Seeds: the dab center plus pixels already in this stroke's region inside the circle, so scrubbing
    // keeps following the same surface across texture detail.
    const seeds: number[] = [py * a.width + px]
    for (let yy = Math.max(0, Math.floor(y - r)); yy <= Math.min(a.height - 1, Math.ceil(y + r)); yy += 3) {
      for (let xx = Math.max(0, Math.floor(x - r)); xx <= Math.min(a.width - 1, Math.ceil(x + r)); xx += 3) {
        const p = yy * a.width + xx
        if ((xx - x) ** 2 + (yy - y) ** 2 <= r * r && this.maskData[p] === 1 && value === 1) seeds.push(p)
      }
    }
    const selected = new Set<number>()
    for (const seed of seeds.slice(0, 40)) {
      if (selected.has(seed)) continue
      const region = grow(a, seed % a.width, Math.floor(seed / a.width), { tolerance: this.tolerance, limit: { x, y, radius: r }, reference: this.strokeColor })
      for (const p of region) selected.add(p)
    }
    this.set([...selected], value)
  }

  /** Magic wand: select (or with add/subtract modify) a whole edge-bounded region of similar color. */
  wand (x: number, y: number, mode: 'replace' | 'add' | 'subtract'): void {
    const a = this.getAnalysis()
    if (a === null || this.maskData === null) return
    const region = grow(a, x, y, { tolerance: this.tolerance, contiguous: this.contiguous })
    if (mode === 'replace') this.maskData.fill(0)
    this.set(region, mode === 'subtract' ? 0 : 1)
  }

  growMask (pixels: number): void {
    if (this.maskData === null) return
    const result = morph(this.maskData, this.maskWidth, this.maskHeight, pixels)
    const a = this.getAnalysis()
    // Never grow past the character's silhouette.
    if (a !== null) for (let i = 0; i < result.length; i++) if (a.color[i * 4 + 3] < 128) result[i] = 0
    this.maskData.set(result)
    this.hasMask = this.maskData.some(v => v === 1)
    this.maskVersion++
  }

  invertMask (): void {
    const a = this.getAnalysis()
    if (this.maskData === null || a === null) return
    for (let i = 0; i < this.maskData.length; i++) this.maskData[i] = a.color[i * 4 + 3] >= 128 && this.maskData[i] === 0 ? 1 : 0
    this.hasMask = this.maskData.some(v => v === 1)
    this.maskVersion++
  }

  stop (): void {
    this.discard()
    this.active = false
    this.stopPolling()
    if (viewer.stage !== null) viewer.stage.controls.enabled = true
  }

  clearMask (): void {
    this.maskData?.fill(0)
    this.hasMask = false
    this.maskVersion++
  }

  /** Mask scaled to the capture size: white where to repaint, black elsewhere. */
  private maskAt (width: number, height: number): HTMLCanvasElement {
    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    const ctx = out.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)
    if (this.maskData !== null) {
      // Mask at viewport size -> capture size, with a slight feather so projected paint blends in.
      const src = document.createElement('canvas')
      src.width = this.maskWidth
      src.height = this.maskHeight
      const sctx = src.getContext('2d')!
      const image = sctx.createImageData(this.maskWidth, this.maskHeight)
      for (let i = 0; i < this.maskData.length; i++) {
        const v = this.maskData[i] * 255
        image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = v
        image.data[i * 4 + 3] = 255
      }
      sctx.putImageData(image, 0, 0)
      ctx.filter = 'blur(1.2px)'
      ctx.drawImage(src, 0, 0, width, height)
      ctx.filter = 'none'
    }
    return out
  }

  async captureView (character: Character): Promise<void> {
    const stage = viewer.stage
    const view = viewer.character
    if (stage === null || view === null) return
    if (!this.hasMask) { app.toast('error', 'Paint over the area to repaint first'); return }
    this.busy = 'Capturing the view'
    try {
      const shot = await captureView(stage, view)
      const id = `p${Date.now().toString(36)}`
      const mask = this.maskAt(shot.camera.width, shot.camera.height)
      const maskBlob = await new Promise<Blob>(resolve => { mask.toBlob(b => { resolve(b!) }, 'image/png') })
      const put = async (file: string, data: Blob): Promise<string> => (await api.putProjectionFile(character.id, id, file, data)).path
      await put('color.png', shot.color)
      await put('flat.png', shot.flat)
      await put('depth.png', shot.depth)
      await put('normal.png', shot.normal)
      await put('mask.png', maskBlob)
      await put('camera.json', new Blob([JSON.stringify(shot.camera)], { type: 'application/json' }))
      const last = await put('prompt.md', new Blob([promptFor(shot.camera, this.notes, character.name)], { type: 'text/markdown' }))
      this.capture = { id, folder: last.replace(/\/prompt\.md$/, ''), camera: shot.camera, mask }
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
      const camera = await (await fetch(`${base}/camera.json`)).json() as ProjectionCamera
      const maskImage = await loadImage(`${base}/mask.png?v=${Date.now()}`)
      const mask = document.createElement('canvas')
      mask.width = camera.width
      mask.height = camera.height
      mask.getContext('2d')!.drawImage(maskImage, 0, 0, camera.width, camera.height)
      const info = await api.projection(character.id, id)
      this.discard()
      this.active = true
      this.tool = 'navigate'
      this.capture = { id, folder: info.path, camera, mask }
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
      await this.preview(character, `/files/characters/${character.id}/projections/${capture.id}/${info.result}?v=${info.resultVersion ?? 0}`)
    }
  }

  /** Use a dropped/picked image as the result. */
  async useFile (character: Character, file: File): Promise<void> {
    if (this.capture === null) return
    await api.putProjectionFile(character.id, this.capture.id, 'result.png', file)
    await this.check(character)
  }

  private async preview (character: Character, url: string): Promise<void> {
    const view = viewer.character
    const stage = viewer.stage
    const capture = this.capture
    if (view === null || stage === null || capture === null) return
    this.busy = 'Projecting onto the texture'
    try {
      const image = await loadImage(url)
      const fitted = document.createElement('canvas')
      fitted.width = capture.camera.width
      fitted.height = capture.camera.height
      fitted.getContext('2d')!.drawImage(image, 0, 0, fitted.width, fitted.height)
      const baked = bakeProjection(stage.renderer, view, capture.camera, fitted, capture.mask)
      const target = paintTarget(view)!
      if (this.originalImage === null) this.originalImage = target.texture.image
      target.texture.image = baked
      target.texture.needsUpdate = true
      this.previewing = true
      this.bakedCanvas = baked
    } catch (error) {
      app.toast('error', (error as Error).message)
    } finally {
      this.busy = null
    }
  }

  private bakedCanvas: HTMLCanvasElement | null = null

  discard (): void {
    const view = viewer.character
    if (view !== null && this.originalImage !== null) {
      const target = paintTarget(view)
      if (target !== null) {
        target.texture.image = this.originalImage as HTMLImageElement
        target.texture.needsUpdate = true
      }
    }
    this.originalImage = null
    this.previewing = false
    this.bakedCanvas = null
  }

  async keep (character: Character): Promise<void> {
    const view = viewer.character
    if (view === null || this.bakedCanvas === null) return
    const target = paintTarget(view)
    if (target === null) return
    this.busy = 'Saving the texture'
    try {
      const blob = await new Promise<Blob>(resolve => { this.bakedCanvas!.toBlob(b => { resolve(b!) }, 'image/png') })
      await api.saveTexture(character.id, cleanName(target.texture.name || 'texture'), blob)
      this.originalImage = null
      this.previewing = false
      this.capture = null
      this.stopPolling()
      this.clearMask()
      app.toast('ok', 'Painting applied. Updating the rig and exports in the background.')
    } catch (error) {
      app.toast('error', (error as Error).message)
    } finally {
      this.busy = null
    }
  }
}

async function loadImage (url: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = url
  await image.decode()
  return image
}

function promptFor (camera: ProjectionCamera, notes: string, name: string): string {
  return `# Repaint request: ${name}

Files in this folder (all ${camera.width}×${camera.height}, same camera):
- flat.png: the character's current texture colors from this view (unlit). Use this as the base image.
- color.png: the same view with lighting, for reference.
- mask.png: white = the area to repaint, black = leave exactly as is.
- depth.png and normal.png: shape guides (depth: brighter is closer).

Task: create result.png in this folder, exactly ${camera.width}×${camera.height} pixels. Repaint only the
white area of mask.png on top of flat.png, in the same hand-painted, stylized game-texture style as the
rest of the character. Keep the silhouette, camera and proportions identical; do not move, crop, pad or
resize anything. Outside the mask, copy flat.png unchanged. No lighting or shadows baked in beyond what the
texture already has. Transparent background is fine where the character isn't.

${notes.trim() !== '' ? `What it should look like: ${notes.trim()}\n` : ''}
Use your image generation tool, then save the image as result.png in the current folder.
`
}

export const painter = new Painter()
