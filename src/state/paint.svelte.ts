// The Rig step's "Fix weights": painting weights on the body as it stands (a test clip paused on the frame that shows
// the problem), src/engine/weightpaint.ts. Left-drag on the body paints; off it the camera orbits as ever. The Weights
// view shows the bone painted (or every bone), the area marked in pink.
import * as THREE from 'three'
import { api } from './api.ts'
import { app } from './app.svelte.ts'
import { viewer } from './viewer.svelte.ts'
import type { CharacterView } from '../engine/CharacterView.ts'
import { WeightPainter } from '../engine/weightpaint.ts'

export type PaintTool = 'area' | 'add' | 'remove' | 'smooth'

class Paint {
  active = $state(false)
  tool = $state<PaintTool>('area')
  bone = $state<string | null>(null)
  /** Brush radius, a share of the body's height. */
  radius = $state(0.05)
  strength = $state(0.5)
  /** Strokes land on both sides of the body (each point's mirror twin, its bones swapped for the other side's). */
  mirror = $state(true)
  edited = $state(0)
  marked = $state(0)
  busy = $state(false)
  /** What the painter is busy with (the viewport's spinner), or null. */
  busyText = $state<string | null>(null)
  private painter: WeightPainter | null = null
  private view: CharacterView | null = null
  private ring: THREE.Mesh | null = null
  private off: (() => void) | null = null
  private ray = new THREE.Raycaster()
  private stroking = false

  /** Paint on the character on stage (or stop). */
  setActive (on: boolean): void {
    this.active = on
    if (!on) { this.detach(); return }
    this.attach()
  }

  private attach (): void {
    const stage = viewer.stage
    const view = viewer.character
    if (stage === null || view === null || view.skinned.length === 0) { this.active = false; return }
    if (this.view !== view) {
      this.painter = new WeightPainter(view.skinned)
      this.painter.mirror = this.mirror
      this.view = view
      this.edited = 0; this.marked = 0
    }
    viewer.setMode('weights')
    view.setHighlightBone(this.tool === 'area' || this.tool === 'smooth' ? null : this.bone)
    const canvas = stage.renderer.domElement
    this.ring ??= new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 40), new THREE.MeshBasicMaterial({ color: 0xff3df0, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }))
    this.ring.renderOrder = 999
    stage.scene.add(this.ring)
    const pick = (e: PointerEvent): { part: number, point: THREE.Vector3, normal: THREE.Vector3 } | null => {
      const r = canvas.getBoundingClientRect()
      this.ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2), stage.camera)
      // (the body as it stands: its bounds follow the pose)
      for (const m of view.skinned) m.computeBoundingSphere()
      const hit = this.ray.intersectObjects(view.skinned, false)[0]
      if (hit === undefined) return null
      const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? new THREE.Vector3(0, 0, 1)
      return { part: view.skinned.indexOf(hit.object as THREE.SkinnedMesh), point: hit.point, normal }
    }
    const brush = (e: PointerEvent): void => {
      const at = pick(e)
      this.showRing(at)
      if (!this.stroking || at === null || this.painter === null) return
      const points = this.painter.under(at.part, at.point, this.radius * view.height)
      if (this.tool === 'area') this.painter.mark(at.part, points, !e.altKey)
      else if (this.tool === 'add' && this.boneIndex(at.part) >= 0) this.painter.add(at.part, points, this.boneIndex(at.part), this.strength * 0.25)
      else if (this.tool === 'remove' && this.boneIndex(at.part) >= 0) this.painter.remove(at.part, points, this.boneIndex(at.part), this.strength * 0.25)
      else if (this.tool === 'smooth') this.painter.smooth(at.part, points, this.strength * 0.5)
      this.redraw()
    }
    const down = (e: PointerEvent): void => {
      if (e.button !== 0 || this.painter === null) return
      if (pick(e) === null) return   // (off the body: the camera orbits)
      e.stopPropagation(); e.preventDefault()
      stage.controls.enabled = false
      this.stroking = true
      this.painter.begin()
      brush(e)
    }
    const up = (): void => {
      if (!this.stroking) return
      this.stroking = false
      stage.controls.enabled = true
    }
    canvas.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('pointermove', brush)
    window.addEventListener('pointerup', up)
    this.off = () => {
      canvas.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('pointermove', brush)
      window.removeEventListener('pointerup', up)
    }
  }

  /** The character on stage changed (another picked, the rig reloaded): paint on the new one. */
  sync (): void {
    if (!this.active || viewer.character === this.view) return
    this.detach()
    this.view = null
    this.attach()
  }

  private detach (): void {
    this.off?.(); this.off = null
    if (this.ring !== null) this.ring.removeFromParent()
    this.stroking = false
    if (viewer.stage !== null) viewer.stage.controls.enabled = true
  }

  private showRing (at: { point: THREE.Vector3, normal: THREE.Vector3 } | null): void {
    if (this.ring === null || this.view === null) return
    this.ring.visible = at !== null
    if (at === null) return
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
    this.view?.setHighlightBone(this.tool === 'area' || this.tool === 'smooth' ? null : this.bone)
    this.redraw()
  }

  private redraw (): void {
    const view = this.view; const painter = this.painter
    if (view === null || painter === null) return
    painter.parts.forEach(({ mesh, members }, part) => {
      const mask = new Float32Array(mesh.geometry.attributes.position.count)
      for (const [p, f] of painter.area[part]) for (const v of members.get(p) ?? [p]) mask[v] = f
      view.paintMasks.set(mesh, mask)
    })
    view.refreshWeights()
    this.edited = painter.editedCount
    this.marked = painter.area.reduce((n, a) => n + a.size, 0)
  }

  /** Heal the marked area: its weights refilled from the skin round it. */
  heal (): void {
    if (this.painter === null) return
    this.busy = true
    this.busyText = 'Healing the marked skin'
    try {
      const n = this.painter.heal()
      this.painter.clearArea()
      this.redraw()
      app.toast('ok', n > 0 ? `Healed ${n} points from the skin round them` : 'Mark the problem area first')
    } finally {
      this.busy = false
      this.busyText = null
    }
  }
  setMirror (on: boolean): void {
    this.mirror = on
    if (this.painter !== null) this.painter.mirror = on
  }

  /** The whole other side set from one: `from` the body's left (+1) or its right (-1). */
  copySide (from: 1 | -1): void {
    if (this.painter === null) return
    this.busy = true
    this.busyText = 'Mirroring the weights'
    try {
      const n = this.painter.copySide(from)
      this.redraw()
      app.toast('ok', `${from === 1 ? 'Left' : 'Right'} side copied onto the ${from === 1 ? 'right' : 'left'} (${n} points); Save to keep it`)
    } finally {
      this.busy = false
      this.busyText = null
    }
  }

  clearArea (): void { this.painter?.clearArea(); this.redraw() }
  undo (): void { if (this.painter?.stepBack() === true) this.redraw() }

  async save (): Promise<void> {
    const c = app.selected
    if (c === null || this.painter === null) return
    const edits = this.painter.edits()
    if (edits.length === 0) return
    this.busy = true
    this.busyText = 'Saving the weights into the rig'
    try {
      const r = await api.saveWeights(c.id, edits)
      this.painter.saved()
      this.edited = 0
      app.toast('ok', `Weights saved: ${r.written} vertices (kept for re-rigs)`)
      // (the rig reloads with them: sync() takes the new one up when it is on stage)
    } catch (error) {
      app.toast('error', (error as Error).message)
    } finally {
      this.busy = false
      this.busyText = null
    }
  }
}

export const paint = new Paint()
