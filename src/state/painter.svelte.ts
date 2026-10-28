// Projection painting (DESIGN.md §7): a mask on the model -> the views that see it captured -> each view repainted (by
// Codex, or an image of your own) -> the results projected back into the texture's layout as a decal -> previewed on
// the model -> kept as a new repaint layer (the server lays it over the texture and puts that into the model files).
//
// The mask is painted on the model itself (src/engine/surfacemask.ts), so the camera stays free: left-drag on the
// model paints, off it the camera turns (right-drag pans, the wheel zooms). Capture finds the fewest views that see
// the masked surface squarely (projection.ts planViews) and writes what each sees; the results are projected back
// together, each texel weighted toward the view that saw it most squarely (bakeViews).
//
// The painter sets up on whatever view of the character is loaded (viewer.onLoad) and again after every reload (a kept
// layer composed, a re-rig, a change of gear all load the model again), carrying the mask and the results not yet
// kept over to the new view. It stops when the user leaves the character or the step (app.guard asks first when
// results would be dropped), and gives the viewport its display mode back.
import * as THREE from 'three'
import type { CharacterView } from '../engine/CharacterView.ts'
import { bakeViews, canvasOf, captureFrom, cleanName, layOver, paintTarget, planViews, pngOf, type ProjectionCamera } from '../engine/projection.ts'
import type { Stage } from '../engine/Stage.ts'
import { SurfaceMask } from '../engine/surfacemask.ts'
import MaskPainter from '../app/look/MaskPainter.svelte'
import { promptFor, resultFile } from '../app/look/text.ts'
import { ApiError, api, type Character, type Projection, type ProjectionFiles } from './api.ts'
import { animator } from './animator.svelte.ts'
import { app, type Navigation } from './app.svelte.ts'
import { viewer, type DisplayMode } from './viewer.svelte.ts'

export type PaintTool = 'smart' | 'wand' | 'brush' | 'erase' | 'navigate'

export interface CaptureView {
  name: string
  camera: ProjectionCamera
  /** What the view repaints, as its camera sees it (white over black), at the capture's size. */
  mask: HTMLCanvasElement
}

export interface Capture {
  id: string
  views: CaptureView[]
  /** The mask in the texture's layout: how strongly each texel takes the new paint. */
  uvMask: HTMLCanvasElement
  /** What was asked for (prompt.md has it). */
  notes: string
}

/** A capture's results baked: a decal in the texture's layout, not yet a layer. */
interface Result { capture: string, canvas: HTMLCanvasElement, note: string }

/** What the painter is set up on: the loaded view's paint target and the mask over it. */
interface Attached {
  view: CharacterView
  stage: Stage
  texture: THREE.Texture
  /** The texture's image as the model file has it (the composite of the layers kept so far). */
  original: unknown
  /** The look's composite the file was loaded with: results kept since are in it once it has moved on. */
  at: number | undefined
  mask: SurfaceMask
}

const BUSY = 'painter'
const POLL_MS = 2000

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

class Painter {
  active = $state(false)
  /** The character being painted. */
  characterId = $state<string | null>(null)
  /** The mask is on the model on stage (false while it loads, or when it can't be painted: `problem` says why). */
  attached = $state(false)
  problem = $state<string | null>(null)
  tool = $state<PaintTool>('smart')
  /** Brush diameter on screen, in pixels. */
  brush = $state(48)
  /** 0..1 for the smart brush and wand: how far colours may differ before the selection stops. */
  tolerance = $state(0.35)
  contiguous = $state(true)
  notes = $state('')
  hasMask = $state(false)
  /** The brush on screen (the viewport's own pixels), while it is over the model. */
  cursor = $state<{ x: number, y: number } | null>(null)
  capture = $state.raw<Capture | null>(null)
  /** The capture as the server last said: each view's result, and whether all are in. */
  info = $state.raw<ProjectionFiles | null>(null)
  /** Why the capture couldn't be checked (the server didn't answer, the folder went). */
  pollError = $state<string | null>(null)
  /** A capture's results show on the model, not kept yet. */
  previewing = $state(false)
  /** Earlier results not kept yet, under the one showing (or under what comes next). */
  stacked = $state(0)
  /** What the painter is doing (also the viewport's busy pill). */
  busy = $state<string | null>(null)
  /** A character's captures, newest first, and whose they are. */
  captures = $state.raw<Projection[]>([])
  capturesOf = $state<string | null>(null)

  private on: Attached | null = null
  private showing: Result | null = null
  private kept: Result[] = []
  /** Results uploaded as layers whose composite the model on stage doesn't have yet: still laid over it here. */
  private landing: { at: number | undefined, canvases: HTMLCanvasElement[] } | null = null
  /** The mask for the view loaded next: the one of the view that went (the same model again keeps it), or an opened
   * capture's while the model was still loading. */
  private carried: { data: Uint8Array } | { image: HTMLCanvasElement } | null = null
  private resultVersion: number | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private polls = 0
  private checking = false
  private offs: Array<() => void> = []
  private mode: DisplayMode | null = null
  private ray = new THREE.Raycaster()

  /** Results that would be lost by stopping now. */
  get unsaved (): number { return this.stacked + (this.previewing ? 1 : 0) }

  // ---- starting and stopping ------------------------------------------------------------------------------------

  start (character: Character): void {
    if (this.active && this.characterId === character.id) return
    if (this.active) this.stop()
    this.active = true
    this.characterId = character.id
    this.tool = 'smart'
    this.hasMask = false
    this.problem = null
    this.mode = viewer.mode
    viewer.setMode('shaded')
    void animator.stop()
    viewer.setOverlay('painter', { component: MaskPainter, props: { painter: this } })
    this.offs = [
      // (again after every reload of the model: its meshes and texture are new)
      viewer.onLoad((view, c) => this.attach(view, c), 30),
      app.guard(async next => await this.leaving(next)),
    ]
    void this.loadCaptures()
  }

  /** Stop painting: results not kept are dropped, the texture shown as saved, the display mode as it was. */
  stop (): void {
    if (!this.active) return
    // (results kept as layers stay shown until the model file has them: the reload then brings their composite)
    this.kept = []
    this.showing = null
    this.show()
    this.landing = null
    this.stopPolling()
    for (const off of this.offs.splice(0)) off()
    viewer.setOverlay('painter', null)
    if (this.mode !== null) viewer.setMode(this.mode)
    this.mode = null
    this.active = false
    this.characterId = null
    this.attached = false
    this.problem = null
    this.carried = null
    this.capture = null
    this.info = null
    this.pollError = null
    this.previewing = false
    this.stacked = 0
    this.hasMask = false
    this.cursor = null
    this.setBusy(null)
  }

  /** "Done painting": asks first when results would be dropped. */
  async done (): Promise<void> {
    if (this.unsaved > 0 && !await this.confirmDrop()) return
    this.stop()
  }

  private async confirmDrop (): Promise<boolean> {
    const n = this.unsaved
    return await app.confirm({
      title: 'Stop painting?',
      body: `${n === 1 ? 'The result showing isn\'t kept' : `${n} results aren't kept`}: stopping drops ${n === 1 ? 'it' : 'them'}. Keep turns a result into a layer.`,
      confirm: 'Drop and stop',
      danger: true,
    })
  }

  /** Leaving the Look step or the character stops painting (asking first when results would be dropped). */
  private async leaving (next: Navigation): Promise<boolean> {
    if (!this.active) return true
    const otherStep = next.step !== undefined && next.step !== 'look'
    const otherCharacter = next.characterId !== undefined && next.characterId !== this.characterId
    if (!otherStep && !otherCharacter) return true
    if (this.unsaved > 0 && !await this.confirmDrop()) return false
    this.stop()
    return true
  }

  // ---- the view ---------------------------------------------------------------------------------------------------

  /** Set up on a loaded view of the character: the mask over its paint target, the brushes on its canvas, the results
   * not kept laid over its texture. The cleanup undoes it all when the view goes. */
  private attach (view: CharacterView, c: Character): (() => void) | undefined {
    if (c.id !== this.characterId) return
    const stage = viewer.stage
    if (stage === null) return
    const target = paintTarget(view)
    if (target === null) { this.problem = 'This model has no colour texture to paint on.'; return }
    let mask: SurfaceMask
    try {
      mask = new SurfaceMask(target.texture, target.meshes)
    } catch (error) {
      this.problem = message(error)
      return
    }
    this.problem = null
    const carried = this.carried
    if (carried !== null) {
      if ('data' in carried) mask.restore(carried.data)
      else mask.load(carried.image)
    }
    this.carried = null
    this.on = { view, stage, texture: target.texture, original: target.texture.image, at: c.look.at, mask }
    // (results kept as layers are in this file's texture once the look's composite has moved on)
    if (this.landing !== null && this.landing.at !== c.look.at) this.landing = null
    this.show()
    mask.show(!this.previewing)
    this.hasMask = mask.any
    const unlisten = this.listen(stage, view, mask)
    this.attached = true
    const on = this.on
    return () => {
      unlisten()
      if (this.on !== on) return
      // (the results shown go with the view; the next one gets them laid over its own texture)
      this.carried = { data: mask.data.slice() }
      mask.dispose()
      this.on = null
      this.attached = false
      this.cursor = null
    }
  }

  /** The texture as it should show: as the file has it, with the results not kept (and those kept but not yet in the
   * file) laid over it in order. */
  private show (): void {
    const on = this.on
    if (on === null) return
    const decals = [...this.landing?.canvases ?? [], ...this.kept.map(r => r.canvas), ...this.showing === null ? [] : [this.showing.canvas]]
    // (nothing over it and nothing was: the texture as loaded, not uploaded again)
    if (decals.length === 0 && on.texture.image === on.original) return
    on.texture.image = decals.length === 0 ? on.original : layOver(on.original as HTMLImageElement, decals)
    on.texture.needsUpdate = true
  }

  /** Brushing on the model: left-drag on it paints (the camera held for the stroke), off it the camera turns. */
  private listen (stage: Stage, view: CharacterView, mask: SurfaceMask): () => void {
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
      if (hit === null) return
      const value = this.tool === 'erase' || erase ? 0 : 1
      mask.dab(hit.part, hit.face, hit.point, radiusAt(hit.point), value, this.tool === 'smart' ? reference : undefined, this.tolerance)
    }
    const down = (e: PointerEvent): void => {
      if (e.button !== 0 || this.tool === 'navigate' || this.previewing || this.busy !== null) return
      const { hit, onModel } = pick(e.clientX, e.clientY)
      if (!onModel) return // (off the model: the camera turns)
      e.stopPropagation(); e.preventDefault()
      if (hit === null) return
      if (this.tool === 'wand') {
        mask.wand(hit.part, hit.face, mask.colorAt(hit.uv), e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace', this.tolerance, this.contiguous)
        this.hasMask = mask.any
        return
      }
      stage.controls.enabled = false
      stroking = true
      erase = e.altKey
      reference = mask.colorAt(hit.uv)
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
      this.hasMask = mask.any
    }
    const leave = (): void => { this.cursor = null }
    canvas.addEventListener('pointerdown', down, { capture: true })
    canvas.addEventListener('pointerleave', leave)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      canvas.removeEventListener('pointerdown', down, { capture: true })
      canvas.removeEventListener('pointerleave', leave)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      stage.controls.enabled = true
    }
  }

  // ---- the mask -----------------------------------------------------------------------------------------------------

  growMask (texels: number): void { this.on?.mask.grow(texels); this.hasMask = this.on?.mask.any ?? false }
  invertMask (): void { this.on?.mask.invert(); this.hasMask = this.on?.mask.any ?? false }
  clearMask (): void { this.on?.mask.clear(); this.hasMask = false }

  // ---- capture ------------------------------------------------------------------------------------------------------

  /** A result showing becomes one under what comes next (another capture's result goes on top of it); the mask shows
   * again to paint the next one. */
  private stackShowing (): void {
    if (this.showing === null) return
    this.kept.push(this.showing)
    this.showing = null
    this.stacked = this.kept.length
    this.previewing = false
    this.on?.mask.show(true)
  }

  /** Find the views that see the masked surface, and write what each sees for painting. */
  async captureViews (character: Character): Promise<void> {
    const on = this.on
    if (on === null || this.busy !== null) return
    if (!on.mask.any) { app.toast('error', 'Paint over the area to repaint first'); return }
    // (a result showing stays: this capture is of the texture with it, and its result goes on top of it)
    this.stackShowing()
    this.setBusy('Finding the views')
    let seamless: THREE.DataTexture | null = null
    try {
      // (planning and the bake see the model at rest: so must the capture)
      await animator.stop()
      const planned = planViews(on.stage.renderer, on.view, on.mask.samples(), on.stage.camera.fov)
      if (planned.length === 0) { app.toast('error', 'No view sees the masked area'); return }
      this.setBusy(`Capturing ${planned.length} view${planned.length === 1 ? '' : 's'}`)
      const id = `p${Date.now().toString(36)}`
      const put = async (file: string, data: Blob): Promise<void> => { await api.putProjectionFile(character.id, id, file, data) }
      const views: CaptureView[] = []
      // (each view's mask drawn from the mask spread past the seams: else every seam inside it is a line left as it was)
      seamless = on.mask.paddedTexture()
      for (const [i, p] of planned.entries()) {
        const shot = await captureFrom(on.stage, on.view, p.camera, seamless)
        const n = i + 1
        await Promise.all([put(`view-${n}-color.png`, shot.color), put(`view-${n}-flat.png`, shot.flat), put(`view-${n}-mask.png`, shot.mask)])
        views.push({ name: p.name, camera: shot.camera, mask: canvasOf(shot.maskPixels, shot.camera.width, shot.camera.height) })
      }
      const uvMask = on.mask.padded()
      const notes = this.notes.trim()
      await put('uvmask.png', await pngOf(uvMask))
      await put('prompt.md', new Blob([promptFor(views, notes, character.name)], { type: 'text/markdown' }))
      // (last: a capture is listed once its views.json is there, so a capture cut short is never offered)
      await put('views.json', new Blob([JSON.stringify({ views: views.map(v => ({ name: v.name, camera: v.camera })), notes }, null, 2)], { type: 'application/json' }))
      // (painting stopped meanwhile: the capture is listed for later, nothing more)
      if (!this.active || this.characterId !== character.id) return
      this.open({ id, views, uvMask, notes })
      void this.loadCaptures()
    } catch (error) {
      app.toast('error', `The capture failed: ${message(error)}`)
    } finally {
      seamless?.dispose()
      this.setBusy(null)
    }
  }

  /** Open an earlier capture: its mask back on the model, its notes, and its results previewed once they are all in.
   * A result showing from another capture stays, under this one's. */
  async resume (character: Character, id: string): Promise<void> {
    if (this.busy !== null) return
    if (!this.active) this.start(character)
    this.setBusy('Opening the capture')
    try {
      const base = `/files/characters/${encodeURIComponent(character.id)}/projections/${encodeURIComponent(id)}`
      const fresh = Date.now()
      const response = await fetch(`${base}/views.json?v=${fresh}`)
      if (!response.ok) throw new Error(`Its views.json didn't load (${response.status})`)
      const list = await response.json() as { views: Array<{ name: string, camera: ProjectionCamera }>, notes?: string }
      const views = await Promise.all(list.views.map(async (v, i) => {
        const image = await loadImage(`${base}/view-${i + 1}-mask.png?v=${fresh}`)
        try { return { name: v.name, camera: v.camera, mask: fitted(image, v.camera) } } finally { image.close() }
      }))
      const uvImage = await loadImage(`${base}/uvmask.png?v=${fresh}`)
      const uvMask = document.createElement('canvas')
      uvMask.width = uvImage.width; uvMask.height = uvImage.height
      uvMask.getContext('2d')!.drawImage(uvImage, 0, 0)
      uvImage.close()
      if (!this.active || this.characterId !== character.id) return
      if (this.capture?.id === id) this.discard(); else this.stackShowing()
      // (the capture's mask back on the model, to see what it covers and to start again from)
      if (this.on !== null) {
        this.on.mask.load(uvMask)
        this.hasMask = this.on.mask.any
      } else {
        this.carried = { image: uvMask }
      }
      this.tool = 'navigate'
      this.notes = list.notes ?? ''
      this.open({ id, views, uvMask, notes: list.notes ?? '' })
    } catch (error) {
      app.toast('error', `Couldn't open the capture: ${message(error)}`)
    } finally {
      this.setBusy(null)
    }
  }

  private open (capture: Capture): void {
    this.capture = capture
    this.info = null
    this.pollError = null
    this.resultVersion = null
    this.startPolling()
  }

  // ---- results ----------------------------------------------------------------------------------------------------

  /** Ask Codex to paint every view (results from before the ask no longer count). */
  async askCodex (character: Character): Promise<void> {
    const capture = this.capture
    if (capture === null) return
    try {
      await api.codex(character.id, capture.id)
      app.toast('info', 'Codex is painting. Its results are picked up as they come.')
      void this.check()
    } catch (error) {
      app.toast('error', message(error))
    }
  }

  /** An image of your own as view `n`'s result (from 1). */
  async useFile (character: Character, n: number, file: File): Promise<void> {
    const capture = this.capture
    if (capture === null) return
    const name = resultFile(n, file)
    if (name === null) { app.toast('error', `${file.name} isn't a PNG, JPEG or WebP image`); return }
    try {
      await api.putProjectionFile(character.id, capture.id, name, file)
      await this.check()
    } catch (error) {
      app.toast('error', message(error))
    }
  }

  private startPolling (): void {
    this.stopPolling()
    this.poll = setInterval(() => { void this.check() }, POLL_MS)
    void this.check()
  }

  private stopPolling (): void {
    if (this.poll !== null) clearInterval(this.poll)
    this.poll = null
  }

  /** What the server has of the capture now; once every view's result is in (and changed since the last look),
   * previewed. */
  private async check (): Promise<void> {
    const capture = this.capture
    const id = this.characterId
    if (capture === null || id === null || this.checking) return
    this.checking = true
    try {
      // (the list's labels go stale too: read again now and then)
      if (++this.polls % 5 === 0) void this.loadCaptures()
      const info = await api.projection(id, capture.id)
      if (this.capture !== capture) return
      this.info = info
      this.pollError = null
      if (info.ready && info.resultVersion !== this.resultVersion && this.busy === null) {
        this.resultVersion = info.resultVersion
        await this.preview(id, capture, info)
      }
    } catch (error) {
      if (this.capture !== capture) return
      if (error instanceof ApiError && error.status === 404) {
        this.stopPolling()
        this.pollError = 'This capture is gone from the character\'s folder.'
      } else {
        this.pollError = `Can't check for results: ${message(error)}`
      }
    } finally {
      this.checking = false
    }
  }

  /** The capture's results projected into the texture's layout and shown on the model. */
  private async preview (characterId: string, capture: Capture, info: ProjectionFiles): Promise<void> {
    const on = this.on
    if (on === null) { this.resultVersion = null; return }
    this.setBusy('Projecting onto the texture')
    try {
      await animator.stop()
      const base = `/files/characters/${encodeURIComponent(characterId)}/projections/${encodeURIComponent(capture.id)}`
      const results = await Promise.all(info.results.map(async (r, i) => {
        if (r === null) throw new Error(`View ${i + 1} has no result`)
        const image = await loadImage(`${base}/${encodeURIComponent(r.file)}?v=${Math.round(r.at)}`)
        try { return fitted(image, capture.views[i].camera) } finally { image.close() }
      }))
      if (this.capture !== capture || this.on !== on) { this.resultVersion = null; return }
      const decal = bakeViews(on.stage.renderer, on.view, capture.views.map((v, i) => ({ camera: v.camera, result: results[i], mask: v.mask })), capture.uvMask)
      this.showing = { capture: capture.id, canvas: decal, note: capture.notes }
      this.previewing = true
      on.mask.show(false)
      this.show()
    } catch (error) {
      this.resultVersion = null
      app.toast('error', `The preview failed: ${message(error)}`)
    } finally {
      this.setBusy(null)
    }
  }

  /** Take back the result showing (the results stacked under it stay). Opening its capture again shows it again. */
  discard (): void {
    this.showing = null
    if (this.previewing) this.on?.mask.show(true)
    this.previewing = false
    this.show()
  }

  /** Take back every result not kept: the texture as saved. */
  discardAll (): void {
    this.kept = []
    this.stacked = 0
    this.discard()
  }

  /** Keep what shows: each result (those stacked, then the one showing) becomes a repaint layer on top, in order; the
   * server then lays them over the texture and puts it into the model files. */
  async keep (character: Character): Promise<void> {
    const on = this.on
    const results = [...this.kept, ...this.showing === null ? [] : [this.showing]]
    if (on === null || results.length === 0 || this.busy !== null) return
    const image = cleanName(on.texture.name)
    if (image === '') { app.toast('error', 'The model\'s texture has no name to keep the painting under'); return }
    this.setBusy(`Keeping ${results.length === 1 ? 'the painting' : `${results.length} paintings`}`)
    const landed: HTMLCanvasElement[] = []
    try {
      for (const r of results) {
        const done = await api.addLayer(character.id, image, await pngOf(r.canvas), { capture: r.capture, note: r.note === '' ? undefined : r.note })
        app.upsert(done.character, done.entry)
        landed.push(r.canvas)
        // (kept: no longer one to drop, whatever happens to the rest)
        if (this.showing === r) { this.showing = null; this.previewing = false } else this.kept = this.kept.filter(x => x !== r)
        this.stacked = this.kept.length
      }
      if (this.on === on) {
        this.capture = null
        this.info = null
        this.stopPolling()
        this.clearMask()
        on.mask.show(true)
      }
      app.toast('ok', `Kept as ${landed.length === 1 ? 'a new repaint layer' : `${landed.length} repaint layers`}: the texture updates in the background.`)
      void this.loadCaptures()
    } catch (error) {
      app.toast('error', `Not kept: ${message(error)}`)
    } finally {
      // (shown as they are until the model file has them)
      if (landed.length > 0 && this.on === on) this.landing = { at: on.at, canvases: [...this.landing?.canvases ?? [], ...landed] }
      this.show()
      this.setBusy(null)
    }
  }

  // ---- the captures list --------------------------------------------------------------------------------------------

  /** A character's captures, newest first (`id`: whose; the one painting by default). */
  async loadCaptures (id = this.characterId): Promise<void> {
    if (id === null) return
    try {
      const list = await api.projections(id)
      // (a list asked for before painting moved to another character isn't that one's)
      if (this.characterId !== null && this.characterId !== id) return
      this.captures = list
      this.capturesOf = id
    } catch {
      // (the list is a convenience: it stays as it was)
    }
  }

  private setBusy (text: string | null): void {
    this.busy = text
    app.setBusy(BUSY, text)
  }
}

/** An image file decoded. (Not HTMLImageElement.decode: in some windows it never settles.) */
async function loadImage (url: string): Promise<ImageBitmap> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Couldn't load ${url.replace(/\?.*$/, '').split('/').pop() ?? url} (${response.status})`)
  return await createImageBitmap(await response.blob())
}

/** An image drawn at a capture's exact size (a result may come at any size). */
function fitted (image: ImageBitmap | HTMLCanvasElement, camera: ProjectionCamera): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = camera.width; canvas.height = camera.height
  canvas.getContext('2d')!.drawImage(image, 0, 0, camera.width, camera.height)
  return canvas
}

export const painter = new Painter()
