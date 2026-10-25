// Props in the viewport: attaching the selected character's props, selection, and the gizmo.
import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { api, fileUrl, type Garment } from './api.ts'
import { app } from './app.svelte.ts'
import type { CharacterView } from '../engine/CharacterView.ts'
import { attachGarments } from '../engine/garments.ts'
import { animator } from './animator.svelte.ts'
import {
  applyOffset, attachProps, CATALOG, defaultPlacement, defaultScale, readOffset, type PropAttachment, type Socket,
} from '../engine/props.ts'
import type { Stage } from '../engine/Stage.ts'

export type GizmoMode = 'translate' | 'rotate' | 'scale'

class Outfit {
  selected = $state<string | null>(null)
  /** Garment being fitted, with the gizmo: a rigid one on its bone (move it at any pose or frame), a clothing one shown
   * unbound until it is bound again. */
  fitting = $state<string | null>(null)
  mode = $state<GizmoMode>('translate')
  busy = $state(false)
  private objects = new Map<string, THREE.Object3D>()
  private garmentObjects = new Map<string, THREE.Object3D>()
  private appliedGarments = ''
  private garmentToken = 0
  private view: CharacterView | null = null
  private stage: Stage | null = null
  private gizmo: TransformControls | null = null
  private applied = ''
  private token = 0

  get props (): PropAttachment[] {
    return (app.selected?.props ?? []) as PropAttachment[]
  }

  get garments (): Garment[] {
    return app.selected?.garments ?? []
  }

  bind (view: CharacterView | null, stage: Stage | null): void {
    this.view = view
    this.stage = stage
    this.applied = ''
    this.appliedGarments = ''
    this.objects.clear()
    this.garmentObjects.clear()
    if (this.gizmo === null && stage !== null) {
      this.gizmo = new TransformControls(stage.camera, stage.renderer.domElement)
      this.gizmo.setSize(0.8)
      this.gizmo.addEventListener('dragging-changed', (e) => {
        stage.controls.enabled = !(e as unknown as { value: boolean }).value
        // (hold the frame while a piece is moved on a playing clip)
        if ((e as unknown as { value: boolean }).value && animator.playing) animator.setPlaying(false)
        if (!(e as unknown as { value: boolean }).value) {
          if (this.fitting !== null) this.commitFit()
          else this.commitGizmo()
        }
      })
      stage.scene.add(this.gizmo.getHelper())
    }
    this.gizmo?.detach()
  }

  /** Make the viewport match the character's props (called whenever they may have changed). */
  async sync (showGizmo: boolean): Promise<void> {
    const view = this.view
    if (view === null || view.rest === null) return
    const key = JSON.stringify(this.props)
    if (key !== this.applied) {
      this.applied = key
      const token = ++this.token
      const objects = await attachProps(view, this.props)
      if (token !== this.token) return
      this.objects = objects
    }
    const fitting = showGizmo ? this.fitting : null
    const garmentKey = JSON.stringify([this.garments, fitting])
    if (garmentKey !== this.appliedGarments) {
      this.appliedGarments = garmentKey
      const token = ++this.garmentToken
      const character = app.selected
      if (character !== null) {
        this.busy = this.garments.some(g => g.status === 'ready' && g.id !== fitting)
        try {
          const objects = await attachGarments(view, this.garments, g => fileUrl(character, g.file) ?? '', fitting)
          if (token === this.garmentToken) this.garmentObjects = objects
        } finally {
          if (token === this.garmentToken) this.busy = false
        }
      }
    }
    this.updateGizmo(showGizmo)
  }

  private updateGizmo (show: boolean): void {
    if (this.gizmo === null) return
    const object = this.fitting !== null ? this.garmentObjects.get(this.fitting) : this.selected === null ? undefined : this.objects.get(this.selected)
    if (!show || object === undefined) {
      this.gizmo.detach()
      return
    }
    if (this.gizmo.object !== object) this.gizmo.attach(object)
    this.gizmo.setMode(this.mode)
    this.gizmo.setSpace(this.fitting !== null ? 'world' : 'local')
  }

  setMode (mode: GizmoMode): void {
    this.mode = mode
    this.gizmo?.setMode(mode)
  }

  select (id: string | null): void {
    this.selected = id
    this.fitting = null
    void this.sync(app.step === 'outfit')
  }

  fit (id: string | null): void {
    this.fitting = id
    this.selected = null
    void this.sync(app.step === 'outfit')
  }

  private commitFit (): void {
    const id = this.fitting
    const object = id === null ? undefined : this.garmentObjects.get(id)
    if (id === null || object === undefined) return
    const r = (v: number): number => Math.round(v * 10000) / 10000
    const e = new THREE.Euler().setFromQuaternion(object.quaternion)
    void this.patchGarment(id, {
      position: [r(object.position.x), r(object.position.y), r(object.position.z)],
      rotation: [e.x, e.y, e.z].map(v => Math.round(THREE.MathUtils.radToDeg(v) * 10) / 10) as [number, number, number],
      scale: r(object.scale.x),
    })
  }

  async upload (file: File): Promise<void> {
    const c = app.selected
    if (c === null) return
    try {
      app.upsert(await api.uploadGarment(c.id, file))
    } catch (error) {
      app.toast('error', (error as Error).message)
    }
  }

  async patchGarment (id: string, change: Partial<Garment>): Promise<void> {
    const c = app.selected
    if (c === null) return
    await app.update(c.id, { garments: this.garments.map(g => (g.id === id ? { ...g, ...change } : g)) })
  }

  async removeGarment (id: string): Promise<void> {
    const c = app.selected
    if (c === null) return
    if (this.fitting === id) this.fitting = null
    await app.update(c.id, { garments: this.garments.filter(g => g.id !== id) })
  }

  private commitGizmo (): void {
    const id = this.selected
    const object = id === null ? undefined : this.objects.get(id)
    if (id === null || object === undefined) return
    void this.patch(id, readOffset(object), false)
  }

  async save (props: PropAttachment[]): Promise<void> {
    const c = app.selected
    if (c === null) return
    await app.update(c.id, { props })
  }

  async add (file: string): Promise<void> {
    const c = app.selected
    if (c === null) return
    const item = CATALOG.find(p => p.file === file)!
    const placement = defaultPlacement(item.socket, item.category)
    const prop: PropAttachment = {
      id: Math.random().toString(36).slice(2, 10),
      ref: `catalog:${file}`,
      name: item.name,
      socket: item.socket,
      ...placement,
      scale: defaultScale(c.stats?.height ?? 1),
    }
    this.selected = prop.id
    await this.save([...this.props, prop])
  }

  async patch (id: string, change: Partial<PropAttachment>, reapply = true): Promise<void> {
    const next = this.props.map(p => (p.id === id ? { ...p, ...change } : p))
    const object = this.objects.get(id)
    const updated = next.find(p => p.id === id)
    if (!reapply && updated !== undefined) {
      // The gizmo already moved the object; keep the viewport as is and just persist.
      this.applied = JSON.stringify(next)
    } else if (object !== undefined && updated !== undefined && change.socket === undefined && change.ref === undefined) {
      applyOffset(object, updated)
      this.applied = JSON.stringify(next)
    }
    await this.save(next)
  }

  async remove (id: string): Promise<void> {
    if (this.selected === id) this.select(null)
    await this.save(this.props.filter(p => p.id !== id))
  }

  async setSocket (id: string, socket: Socket): Promise<void> {
    const prop = this.props.find(p => p.id === id)
    if (prop === undefined) return
    const category = CATALOG.find(c => `catalog:${c.file}` === prop.ref)?.category ?? ''
    await this.patch(id, { socket, ...defaultPlacement(socket, category) })
  }

  async reset (id: string): Promise<void> {
    const prop = this.props.find(p => p.id === id)
    if (prop === undefined) return
    const category = CATALOG.find(c => `catalog:${c.file}` === prop.ref)?.category ?? ''
    await this.patch(id, { ...defaultPlacement(prop.socket as Socket, category), scale: defaultScale(app.selected?.stats?.height ?? 1) })
  }
}

export const outfit = new Outfit()
