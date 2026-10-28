// The viewport's one move/turn/size gizmo (three's TransformControls), shared by whatever places things by hand: gear
// (src/state/gear.svelte.ts) and Ship's seat editor. Whoever attaches it owns it until it is detached or another
// attaches it. Dragging pauses the clip playing (the gizmo moves the frame shown), turns the camera's orbit off, and
// letting go calls the owner's onCommit, which saves what it moved as a command.
import type * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import type { Stage } from '../engine/Stage.ts'
import { animator } from './animator.svelte.ts'
import { viewer } from './viewer.svelte.ts'

export type GizmoMode = 'translate' | 'rotate' | 'scale'
export type GizmoSpace = 'local' | 'world'

export interface GizmoOptions {
  mode?: GizmoMode
  space?: GizmoSpace
  /** Each move while dragging. */
  onChange?: () => void
  /** Let go: save it. */
  onCommit: () => void
}

class Gizmo {
  private mode_ = $state<GizmoMode>('translate')
  /** A drag is on. */
  dragging = $state(false)
  /** What it is on (null: hidden). */
  target = $state.raw<THREE.Object3D | null>(null)
  private controls: TransformControls | null = null
  private stage: Stage | null = null
  private options: GizmoOptions | null = null

  get mode (): GizmoMode { return this.mode_ }
  set mode (mode: GizmoMode) {
    this.mode_ = mode
    this.controls?.setMode(mode)
  }

  /** Put it on `target` (taking it from whoever had it). */
  attach (target: THREE.Object3D, o: GizmoOptions): void {
    const controls = this.ensure()
    if (controls === null) return
    this.options = o
    if (o.mode !== undefined) this.mode_ = o.mode
    controls.setMode(this.mode_)
    controls.setSpace(o.space ?? 'world')
    if (controls.object !== target) controls.attach(target)
    this.target = target
  }

  /** Take it off (only if it is on `target`, when given: another owner keeps it). */
  detach (target?: THREE.Object3D | null): void {
    if (target !== undefined && target !== null && target !== this.target) return
    if (this.dragging) this.endDrag(false)
    this.controls?.detach()
    this.target = null
    this.options = null
  }

  /** The controls for the viewer's stage now (made again when the stage was). */
  private ensure (): TransformControls | null {
    const stage = viewer.stage
    if (stage === this.stage && this.controls !== null) return this.controls
    this.dispose()
    if (stage === null) return null
    const controls = new TransformControls(stage.camera, stage.renderer.domElement)
    controls.setSize(0.8)
    controls.addEventListener('dragging-changed', (e) => {
      const on = (e as unknown as { value: boolean }).value
      if (on) this.startDrag()
      else this.endDrag(true)
    })
    controls.addEventListener('objectChange', () => { this.options?.onChange?.() })
    stage.scene.add(controls.getHelper())
    this.controls = controls
    this.stage = stage
    return controls
  }

  private startDrag (): void {
    if (this.stage !== null) this.stage.controls.enabled = false
    this.dragging = true
    // (the gizmo moves the frame shown: a playing clip would carry it off)
    if (animator.playing !== null) animator.setPlaying(false)
  }

  private endDrag (commit: boolean): void {
    if (this.stage !== null) this.stage.controls.enabled = true
    this.dragging = false
    if (commit) this.options?.onCommit()
  }

  private dispose (): void {
    if (this.controls === null) return
    this.controls.detach()
    this.controls.getHelper().removeFromParent()
    this.controls.dispose()
    this.controls = null
    this.stage = null
    this.target = null
    this.options = null
  }
}

export const gizmo = new Gizmo()
