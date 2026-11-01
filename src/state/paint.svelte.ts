// Weight painting (src/engine/weightpaint.ts) on the character as it stands: a test clip paused on the frame that
// shows the problem. Left-drag on the body paints; off it the camera orbits as ever. The Weights view shows the bone
// painted (or every bone), the area marked in pink.
//
// What is painted:
//   the body     CharacterView.bodySkinned (the rig's own skinned meshes in its file's order, which is how PUT /weights
//                addresses them), saved into the rig through the weights route (a job)
//   skin gear    its worn meshes (the body under them is there for Follow, not painted), saved by bone name
//   pulled gear  its own small skeleton: the piece's root and one bone per pull handle, saved keyed 'PropRoot' /
//                'pull:<handle id>' (pulls.ts pullWeightKeys; what tools/lib/gearskin.ts reads)
// It attaches through viewer.onLoad, so a reload (the weights saved, a re-rig) paints on the new view and another
// character stops it; gear meshes put on again are picked up on the next frame. Unsaved strokes are asked about before
// the step or the character changes.
import * as THREE from 'three'
import type { CharacterView } from '../engine/CharacterView.ts'
import { BrushStroke } from '../engine/brushstroke.ts'
import { GARMENT_FLAG } from '../engine/garments.ts'
import { PROP_ROOT, pullWeightKeys } from '../engine/pulls.ts'
import { skeletonSpec } from '../engine/templates.ts'
import { type MirrorName, type PaintPick, type ShapeEdit, WeightPainter } from '../engine/weightpaint.ts'
import { boneLabel, carriesSkin } from '../app/skin/bones.ts'
import { api, type Character, type Gear, type WeightEdit } from './api.ts'
import { app } from './app.svelte.ts'
import { viewer } from './viewer.svelte.ts'
import { animator } from './animator.svelte.ts'

export type PaintTool = 'area' | 'protect' | 'add' | 'remove' | 'smooth' | 'follow' | 'cloth' | 'rigid' | 'lift'
export interface PaintBone { name: string, label: string }

/** Gear the weight brushes work on: worn on the skin, or a piece with pull handles. */
export function paintableGear (g: Gear): 'skin' | 'pulled' | null {
  if (g.attach.kind === 'skin') return 'skin'
  if (g.attach.kind === 'bone' && g.handles.some(h => h.kind === 'pull' && h.pull !== undefined)) return 'pulled'
  return null
}

/** The other side's bone, as the skeleton pairs them (the joint editor's mirror too). */
const mirrorOf = (c: Character): MirrorName => skeletonSpec(c).mirror

class Paint {
  /** Painting is on (the panel's "Paint weights"). */
  active = $state(false)
  /** What is painted: the character, and its gear piece (null: its body). */
  characterId = $state<string | null>(null)
  gear = $state<string | null>(null)
  tool = $state<PaintTool>('area')
  bone = $state<string | null>(null)
  /** The bones Add and Remove offer. */
  bones = $state.raw<PaintBone[]>([])
  /** Brush radius, a share of the body's height. */
  radius = $state(0.05)
  strength = $state(0.5)
  /** The Lift brush's gap: how far clear of the skin under it the brushed skin is pushed, a share of the body's height. */
  gap = $state(0.01)
  /** Strokes land on both sides of the body (each point's mirror twin, its bones swapped for the other side's). */
  mirror = $state(true)
  /** The Bone brush's bone: the one under the brush (hovering), or the stroke's while painting. */
  boneUnder = $state<string | null>(null)
  /** Points changed and not saved yet. */
  edited = $state(0)
  limited = $state(0)
  contactLimited = $state(0)
  marked = $state(0)
  protectedCount = $state(0)
  busy = $state(false)
  validating = $state(false)
  /** On, but nothing to paint on stage yet (the model or the gear's meshes still loading). */
  waiting = $state(false)

  private painter: WeightPainter | null = null
  private view: CharacterView | null = null
  private editable = new Set<THREE.SkinnedMesh>()
  private pulled = false
  private mirrorName: MirrorName = bone => bone
  private ring: THREE.Mesh | null = null
  private listeners: (() => void) | null = null
  private offLoad: (() => void) | null = null
  private offGuard: (() => void) | null = null
  private offFrame: (() => void) | null = null
  private ray = new THREE.Raycaster()
  stroking = $state(false)
  private loadVersion = 0
  private shapeReference: ShapeEdit[] = []
  private revision: number | null = null
  private workVersion = 0

  /** Paint `character`'s body, or `gear` of it. Asks first when unsaved strokes on something else would go. */
  async start (character: Character, gear: Gear | null = null): Promise<void> {
    const gid = gear?.id ?? null
    if (this.active && this.characterId === character.id && this.gear === gid) return
    if (this.active && !await this.discardAsked()) return
    this.stop()
    this.characterId = character.id
    this.gear = gid
    this.active = true
    this.waiting = true
    this.mirrorName = mirrorOf(character)
    this.offGuard = app.guard(async () => await this.discardAsked())
    this.offLoad = viewer.onLoad((view, c) => this.loaded(view, c), 35)
  }

  /** Painting off (the panel closed, "Done painting" answered): unsaved strokes go. */
  stop (): void {
    if (this.validating) {
      this.workVersion++; this.validating = false; this.busy = false
      app.setBusy('paint', null)
    }
    this.loadVersion++
    this.detach()
    // The live view may be reused when painting starts again. Discard restores its last saved checkpoint,
    // including raw seam attributes and Lift positions, rather than leaving unsaved edits on that same mesh.
    while (this.painter?.stepBack() === true) { /* each Undo removes one unsaved transaction */ }
    this.offFrame?.(); this.offFrame = null
    this.offLoad?.(); this.offLoad = null
    this.offGuard?.(); this.offGuard = null
    if (this.view !== null) {
      this.view.paintMasks.clear()
      this.view.setHighlightBone(null)
      this.view.refreshWeights()
    }
    this.view = null
    this.painter = null
    this.shapeReference = []
    this.revision = null
    this.active = false
    this.waiting = false
    this.characterId = null
    this.gear = null
    this.bones = []
    this.edited = 0
    this.limited = 0
    this.contactLimited = 0
    this.marked = 0
    this.protectedCount = 0
    this.boneUnder = null
  }

  /** "Done painting": asks first when strokes aren't saved. */
  async finish (): Promise<void> {
    if (await this.discardAsked()) this.stop()
  }

  /** True when there is nothing unsaved to lose, or the user agreed to lose it. */
  private async discardAsked (): Promise<boolean> {
    if (!this.active || this.edited === 0 || (this.busy && !this.validating)) return true
    return await app.confirm({
      title: 'Discard the painting?',
      body: `${this.edited} painted ${this.edited === 1 ? 'point isn\'t' : 'points aren\'t'} saved.`,
      confirm: 'Discard',
      danger: true,
    })
  }

  /** A view loaded (viewer.onLoad): paint on it while it is there. */
  private async loaded (view: CharacterView, c: Character): Promise<(() => void) | void> {
    if (!this.active) return
    // (another character on stage: painting this one is over; after the viewer's own loop)
    if (c.id !== this.characterId) {
      const version = this.loadVersion
      queueMicrotask(() => { if (this.loadVersion === version) this.stop() })
      return
    }
    const version = ++this.loadVersion
    const gear = this.gear
    const current = (): boolean => this.loadVersion === version && this.active && this.characterId === c.id &&
      this.gear === gear && viewer.character === view
    this.waiting = true
    let reference: ShapeEdit[]
    try {
      reference = await api.shapeEdits(c.id)
    } catch (error) {
      if (current()) {
        this.stop()
        app.toast('error', `Could not load saved lifts: ${(error as Error).message}`)
      }
      return
    }
    if (!current()) return
    this.shapeReference = reference
    this.revision = c.revision ?? 0
    this.view = view
    this.offFrame?.()
    this.offFrame = viewer.stage?.onFrame(() => { this.watch() }) ?? null
    this.attach()
    return () => {
      // A late cleanup from the viewer must not detach a newer painting session.
      if (this.loadVersion !== version || this.view !== view) return
      this.loadVersion++
      this.offFrame?.(); this.offFrame = null
      this.detach()
      this.view = null
      this.painter = null
      this.shapeReference = []
      this.revision = null
      if (this.active) this.waiting = true
    }
  }

  /** The meshes painted on, and those of them that may change; null when they aren't on stage (yet). */
  private target (view: CharacterView): { meshes: THREE.SkinnedMesh[], editable: THREE.SkinnedMesh[], gear: Gear | null } | null {
    const body = view.bodySkinned
    if (this.gear === null) return body.length === 0 ? null : { meshes: [...body], editable: [...body], gear: null }
    const g = app.byId(this.characterId)?.gear.find(x => x.id === this.gear) ?? null
    if (g === null) return null
    const worn = view.skinned.filter(m => m.userData[GARMENT_FLAG] === g.id)
    if (worn.length === 0) return null
    // (a pulled piece has a skeleton of its own: the body's bones are nothing to it)
    return { meshes: paintableGear(g) === 'pulled' ? worn : [...worn, ...body], editable: worn, gear: g }
  }

  private attach (): void {
    this.detach()
    const stage = viewer.stage
    const view = this.view
    if (stage === null || view === null) return
    const target = this.target(view)
    if (target === null) { this.waiting = true; return }
    this.waiting = false
    this.editable = new Set(target.editable)
    this.pulled = target.gear !== null && paintableGear(target.gear) === 'pulled'
    const reference = this.shapeReference.flatMap(edit => {
      const mesh = target.meshes.indexOf(view.bodySkinned[edit.mesh])
      return mesh < 0 ? [] : [{ ...edit, mesh }]
    })
    this.painter = new WeightPainter(target.meshes, this.mirrorName, this.editable, reference)
    // (a prop isn't mirrored across the body: a bow's two ends aren't each other's)
    this.painter.mirror = this.mirror && !this.pulled
    this.bones = this.bonesOf(target.editable[0], target.gear)
    if (this.bone === null || !this.bones.some(b => b.name === this.bone)) this.bone = this.bones[this.pulled ? Math.min(1, this.bones.length - 1) : 0]?.name ?? null
    this.edited = 0
    this.limited = 0
    this.contactLimited = 0
    this.marked = 0
    this.protectedCount = 0
    viewer.setMode('weights')
    this.refreshView()
    this.listen(stage, view)
  }

  /** The bones Add and Remove offer: the skin's own (no end markers), or a pulled piece's root and pulls. */
  private bonesOf (mesh: THREE.SkinnedMesh, gear: Gear | null): PaintBone[] {
    const names = mesh.skeleton.bones.map(b => b.name)
    if (gear !== null && this.pulled) {
      const keys = pullWeightKeys(gear.name, gear.handles)
      return names.map(name => {
        const key = keys.get(name)
        const handle = key?.startsWith('pull:') === true ? gear.handles.find(h => `pull:${h.id}` === key) : undefined
        return { name, label: name === PROP_ROOT ? 'Rigid (the piece itself)' : `Pulled by ${handle?.name ?? name}` }
      })
    }
    const all = new Set(names)
    return names.filter(carriesSkin).map(name => ({ name, label: boneLabel(name, all) }))
  }

  /** Each frame while on: what wasn't on stage yet is taken up when it is, and gear put on again (new meshes) too. */
  private watch (): void {
    const view = this.view
    if (view === null || this.stroking) return
    if (this.painter === null) {
      if (this.target(view) !== null) this.attach()
      return
    }
    for (const m of this.editable) if (m.parent === null || !view.skinned.includes(m)) { this.attach(); return }
  }

  private listen (stage: NonNullable<typeof viewer.stage>, view: CharacterView): void {
    const canvas = stage.renderer.domElement
    this.ring ??= new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 40), new THREE.MeshBasicMaterial({ color: 0xff3df0, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }))
    this.ring.visible = false
    this.ring.renderOrder = 999
    stage.scene.add(this.ring)
    // Track the surface from the LAST dab. Layers can be joined far away at the shoulders; the whole connected mesh
    // and the accumulated stroke are both too broad. Keep the picked triangle even when the brush is smaller than it.
    let held: { part: number, sheet: Set<number> } | null = null
    let stroke: BrushStroke | null = null
    let pointer: number | null = null
    let altKey = false
    let dirty = false
    const flush = (): void => { if (dirty) { dirty = false; this.redraw() } }
    const pick = (e: { clientX: number, clientY: number }): PaintPick | null => {
      const painter = this.painter
      if (painter === null) return null
      const r = canvas.getBoundingClientRect()
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return null
      this.ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2), stage.camera)
      const lock = this.stroking ? held : null
      return painter.pick(this.ray.ray, this.radius * view.height, lock ?? undefined)
    }
    const brush = (e: { clientX: number, clientY: number, altKey: boolean }): void => {
      const at = pick(e)
      this.showRing(at)
      const painter = this.painter
      if (at === null || painter === null || at.part < 0 || this.busy) return
      if (!this.stroking && this.tool !== 'rigid') return
      // (the body under a garment is there to follow, not to paint)
      if (!this.editable.has(painter.parts[at.part].mesh)) return
      const points = at.points
      if (this.stroking) held = { part: at.part, sheet: new Set([...points.keys(), ...at.face.map(v => painter.parts[at.part].point[v])]) }
      if (this.tool === 'rigid') {
        // (the bone it paints, shown before and while painting)
        const index = painter.strokeBoneFor(at.part) ?? painter.leadingBone(at.part, points)
        const name = index === null ? null : painter.parts[at.part].mesh.skeleton.bones[index].name
        if (name !== this.boneUnder) { this.boneUnder = name; view.setHighlightBone(name) }
        if (!this.stroking) return
      }
      const bone = this.boneIndex(at.part)
      if (this.tool === 'area') painter.mark(at.part, points, !e.altKey)
      else if (this.tool === 'protect') painter.protect(at.part, points, !e.altKey)
      else if (this.tool === 'add' && bone >= 0) painter.add(at.part, points, bone, this.strength)
      else if (this.tool === 'remove' && bone >= 0) painter.remove(at.part, points, bone, this.strength)
      else if (this.tool === 'smooth') painter.smooth(at.part, points, this.strength)
      else if (this.tool === 'follow' || this.tool === 'cloth' || (this.tool === 'lift' && this.gear === null)) {
        painter.paintLayers(this.tool, at, this.radius * view.height, this.strength, this.gap * view.height, this.editable)
      }
      else if (this.tool === 'rigid') painter.rigid(at.part, points, this.strength)
      dirty = true
    }
    const move = (e: PointerEvent): void => {
      if (!this.stroking) { brush(e); return }
      if (e.pointerId !== pointer || stroke === null) return
      altKey = e.altKey
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
      for (const sample of events.length > 0 ? events : [e]) {
        for (const point of stroke.move({ x: sample.clientX, y: sample.clientY })) brush({ clientX: point.x, clientY: point.y, altKey })
      }
      flush()
      this.showRing(pick(e))
    }
    const down = (e: PointerEvent): void => {
      if (e.button !== 0 || this.stroking || this.painter === null || this.busy) return
      const at = pick(e)
      if (at === null || !this.editable.has(this.painter.parts[at.part]?.mesh)) return   // (off the editable skin: the camera orbits)
      e.stopPropagation(); e.preventDefault()
      stage.controls.enabled = false
      held = at.part < 0 ? null : { part: at.part, sheet: new Set() }
      pointer = e.pointerId; altKey = e.altKey
      const rect = canvas.getBoundingClientRect()
      const right = new THREE.Vector3().setFromMatrixColumn(stage.camera.matrixWorld, 0)
      const a = at.point.clone().project(stage.camera)
      const b = at.point.clone().addScaledVector(right, this.radius * view.height).project(stage.camera)
      const pixels = Math.hypot((b.x - a.x) * rect.width / 2, (b.y - a.y) * rect.height / 2)
      stroke = new BrushStroke({ x: e.clientX, y: e.clientY }, pixels * 0.15)
      canvas.setPointerCapture(e.pointerId)
      animator.setPlaying(false) // one stroke edits one pose, even when painting began during playback
      this.stroking = true
      const maskOnly = this.tool === 'area' || this.tool === 'protect'
      this.painter.begin({ bounded: true, stableSurface: true, preserveSurface: !maskOnly,
        ...(maskOnly ? {} : { deferClip: true, animation: { root: view.root, clip: animator.clip } }) })
      brush(e)
      flush()
    }
    const up = (e?: Event): void => {
      if (!this.stroking) return
      if (e instanceof PointerEvent && e.pointerId !== pointer) return
      if (e instanceof PointerEvent && e.type === 'pointerup') {
        for (const point of stroke?.move({ x: e.clientX, y: e.clientY }) ?? []) brush({ clientX: point.x, clientY: point.y, altKey })
      }
      for (const point of stroke?.end() ?? []) brush({ clientX: point.x, clientY: point.y, altKey })
      flush()
      const painter = this.painter
      this.stroking = false
      held = null
      stroke = null
      if (pointer !== null && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer)
      pointer = null
      stage.controls.enabled = true
      if (painter !== null) {
        if (this.tool === 'area' || this.tool === 'protect') { painter.end(); this.redraw() }
        else void this.checkStroke(painter)
      }
    }
    canvas.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', up)
    this.listeners = () => {
      if (this.stroking) this.painter?.stepBack() // a disappearing canvas cancels its unfinished gesture
      if (pointer !== null && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer)
      canvas.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', up)
    }
  }

  private detach (): void {
    if (this.validating) {
      this.painter?.stepBack()
      this.workVersion++; this.validating = false; this.busy = false
      app.setBusy('paint', null)
    }
    this.listeners?.(); this.listeners = null
    this.ring?.removeFromParent()
    if (this.stroking && viewer.stage !== null) viewer.stage.controls.enabled = true
    this.stroking = false
  }

  /** Gear put on again (new meshes) while painting it: paint on those. (The next frame would find them too.) */
  rebuild (): void {
    if (this.active && this.view !== null) this.attach()
  }

  private showRing (at: { point: THREE.Vector3, normal: THREE.Vector3 } | null): void {
    if (this.ring === null || this.view === null) return
    this.ring.visible = at !== null
    if (at === null) return
    ;(this.ring.material as THREE.MeshBasicMaterial).color.setHex(this.tool === 'protect' ? 0x36d6e7 : 0xff3df0)
    const r = this.radius * this.view.height
    this.ring.position.copy(at.point).addScaledVector(at.normal, r * 0.02)
    this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), at.normal)
    this.ring.scale.setScalar(r)
  }

  private boneIndex (part: number): number {
    if (this.bone === null || this.painter === null) return -1
    return this.painter.parts[part].mesh.skeleton.bones.findIndex(b => b.name === this.bone)
  }

  /** The tool or bone changed: what the Weights view shows. */
  refreshView (): void {
    this.view?.setHighlightBone(this.tool === 'add' || this.tool === 'remove' ? this.bone : this.tool === 'rigid' ? this.boneUnder : null)
    this.redraw()
  }

  private redraw (): void {
    const view = this.view; const painter = this.painter
    if (view === null || painter === null) return
    painter.parts.forEach(({ mesh, members }, part) => {
      const mask = new Float32Array(mesh.geometry.attributes.position.count)
      for (const [p, f] of painter.area[part]) for (const v of members.get(p) ?? [p]) mask[v] = f
      for (const p of painter.protectedPoints[part]) for (const v of members.get(p) ?? [p]) mask[v] = -1
      view.paintMasks.set(mesh, mask)
    })
    view.refreshWeights()
    this.edited = painter.editedCount
    this.limited = painter.limitedCount
    this.contactLimited = painter.contactLimitedCount
    this.marked = painter.area.reduce((n, a) => n + a.size, 0)
    this.protectedCount = painter.protectedCount
  }

  private async working<T> (text: string, fn: () => T | Promise<T>): Promise<T> {
    const version = ++this.workVersion
    this.busy = true
    app.setBusy('paint', text)
    try {
      return await fn()
    } finally {
      if (version === this.workVersion) { this.busy = false; app.setBusy('paint', null) }
    }
  }

  /** The finished drag stays visible while the full clip check yields to camera/redraw events. */
  private async checkStroke (painter: WeightPainter): Promise<void> {
    const version = this.workVersion + 1
    this.validating = true
    await this.working('Checking the stroke against the clip', async () => {
      try {
        if (await painter.endAsync() && this.painter === painter && version === this.workVersion) this.redraw()
      } catch (error) {
        // The engine restores this stroke on failure; do not undo an earlier stroke a second time.
        if (this.painter === painter && version === this.workVersion) { this.redraw(); app.toast('error', `Stroke check failed: ${(error as Error).message}`) }
      } finally {
        if (this.painter === painter && version === this.workVersion) this.validating = false
      }
    })
  }

  cancelStroke (): void {
    if (!this.validating) return
    this.workVersion++; this.validating = false; this.busy = false
    app.setBusy('paint', null)
    if (this.painter?.stepBack() === true) this.redraw()
  }

  /** Heal the marked area: its weights refilled from the skin round it. */
  async heal (): Promise<void> {
    const painter = this.painter
    if (painter === null || this.stroking || this.busy) return
    await this.working('Healing the marked skin', () => {
      const n = painter.heal()
      this.redraw()
      app.toast(n > 0 ? 'ok' : 'error', n > 0 ? `Healed ${n} points from the skin round them${this.marked > 0 ? '; the rest of the marked skin needs some good skin left unmarked round it' : ''}` : 'Leave some good skin unmarked round the area to heal from')
    })
  }

  setMirror (on: boolean): void {
    if (this.stroking || this.busy) return
    this.mirror = on
    if (this.painter !== null) this.painter.mirror = on && !this.pulled
  }

  /** The whole other side set from one: `from` the body's left (+1) or its right (-1). */
  async copySide (from: 1 | -1): Promise<void> {
    const painter = this.painter
    if (painter === null || this.stroking || this.busy) return
    await this.working('Mirroring the weights', () => {
      const n = painter.copySide(from)
      this.redraw()
      app.toast('ok', `${from === 1 ? 'Left' : 'Right'} side copied onto the ${from === 1 ? 'right' : 'left'} (${n} points); Save to keep it`)
    })
  }

  clearArea (): void { if (!this.stroking && !this.busy) { this.painter?.clearArea(); this.redraw() } }
  clearProtection (): void { if (!this.stroking && !this.busy) { this.painter?.clearProtection(); this.redraw() } }
  undo (): void { if (!this.stroking && !this.busy && this.painter?.stepBack() === true) this.redraw() }

  /** The strokes as the weights routes take them: the body's by bodySkinned index, a gear piece's by its model's mesh
   * (and a pulled piece's bones as its weight keys). */
  private editsToSave (): WeightEdit[] {
    const painter = this.painter
    if (painter === null) return []
    const gear = this.gear === null ? null : app.byId(this.characterId)?.gear.find(g => g.id === this.gear) ?? null
    const keys = gear === null ? null : pullWeightKeys(gear.name, gear.handles)
    const out: WeightEdit[] = []
    for (const e of painter.edits()) {
      const mesh = painter.parts[e.mesh].mesh
      if (!this.editable.has(mesh)) continue
      if (gear === null || keys === null) { out.push(e); continue }
      const weights = this.pulled
        ? e.weights.flatMap(([bone, w]): Array<[string, number]> => { const key = keys.get(bone); return key === undefined ? [] : [[key, w]] })
        : e.weights
      out.push({ mesh: (mesh.userData.garmentMesh as number | undefined) ?? 0, vertex: e.vertex, weights })
    }
    return out
  }

  /** Save the strokes: the body's into its rig (kept for re-rigs), a gear piece's beside it. */
  async save (): Promise<void> {
    const c = app.byId(this.characterId)
    const painter = this.painter
    if (c === null || painter === null || this.busy || this.stroking) return
    const edits = this.editsToSave()
    const gear = this.gear
    const revision = this.revision
    // (lifted skin, Lift: the body's only)
    const lifts = gear === null ? painter.shapeEdits() : []
    if (edits.length === 0 && lifts.length === 0) return
    await this.working(gear === null ? 'Saving the weights into the rig' : 'Saving the gear\'s weights', async () => {
      try {
        const job = gear === null ? await api.savePainting(c.id, edits, lifts, revision ?? undefined) : await api.saveGearWeights(c.id, gear, edits)
        const done = await app.jobDone(job.id)
        // One body job publishes both halves and increments the revision once. A failed job leaves the same
        // unsaved painter available; there is no shape-only reload between saving Lift and weight strokes.
        if (done.status !== 'done') return
        painter.saved()
        if (this.painter === painter) { this.edited = 0; this.limited = 0; this.contactLimited = 0 }
        const said = [lifts.length > 0 ? `${lifts.length} lifted` : '', edits.length > 0 ? `${edits.length} weighted` : ''].filter(Boolean).join(', ')
        app.toast('ok', `Saved: ${said} vertices${gear === null ? ' (kept for re-rigs)' : ''}`)
      } catch (error) {
        app.toast('error', (error as Error).message)
      }
    })
  }

  /** Forget a character's lifts: the rig's lifted vertices put back where they were. */
  async forgetLifts (c: Character): Promise<boolean> {
    try {
      const done = await app.jobDone((await api.forgetShape(c.id)).id)
      return done.status === 'done'
    } catch (error) {
      app.toast('error', (error as Error).message)
      return false
    }
  }

  /** Start the body over: every painted weight and every lift forgotten, and the body rigged afresh at once, so its
   * weights are the auto-rig's again (forgetting alone leaves the live rig's weights until the next rig: painting over
   * several sessions only piled up; the designer, 2026-10-31). Clips, gear, hands and sounds stay. Ask first (the
   * panel does). */
  async startOver (c: Character): Promise<boolean> {
    if (this.active && this.characterId === c.id) this.stop()
    try {
      for (const drop of [() => api.forgetWeights(c.id), () => api.forgetShape(c.id)]) {
        const job = await drop()
        if ((await app.jobDone(job.id)).status !== 'done') return false
      }
      const rig = await app.rig(c.id)
      return rig !== null && (await app.jobDone(rig.id)).status === 'done'
    } catch (error) {
      app.toast('error', (error as Error).message)
      return false
    }
  }

  /** Forget a character's painting (its body's, or a gear piece's): the body's live rig keeps the weights until the
   * next rig; a gear piece takes its unpainted weights at once. Ask first (the panel does). */
  async forget (c: Character, gear: Gear | null): Promise<boolean> {
    try {
      const job = gear === null ? await api.forgetWeights(c.id) : await api.forgetGearWeights(c.id, gear.id)
      const done = await app.jobDone(job.id)
      return done.status === 'done'
    } catch (error) {
      app.toast('error', (error as Error).message)
      return false
    }
  }
}

export const paint = new Paint()
