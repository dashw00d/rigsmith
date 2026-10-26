// Tuning a clip at a frame: a gizmo on a bone or a prop of the entry playing; letting go keys the change there (the
// pose as it is now, against the clip as it plays before its keys), in the entry's keys (src/engine/keys.ts).
import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import type { AnimationEntry, ClipKey } from './api.ts'
import { app } from './app.svelte.ts'
import { animator } from './animator.svelte.ts'
import { KEY_FPS, lowestPoints } from '../engine/keys.ts'
import { garmentMatrix } from '../engine/placement.ts'

export type TuneMode = 'rotate' | 'translate'

/** A target: "bone:<name>" or "prop:<garment name>". */
const boneOf = (target: string): string | null => target.startsWith('bone:') ? target.slice(5) : null
const propOf = (target: string): string | null => target.startsWith('prop:') ? target.slice(5) : null
export const propNode = (name: string): string => `${name.replace(/[^\w]+/g, '_')}_place`

class Tune {
  target = $state<string | null>(null)
  mode = $state<TuneMode>('rotate')
  busy = $state(false)
  private gizmo: TransformControls | null = null

  /** The entry playing (its index), if any. */
  get entry (): { entry: AnimationEntry, index: number } | null {
    const i = animator.current?.entry ?? null
    const e = i === null ? undefined : app.selected?.animations[i]
    return e === undefined || i === null ? null : { entry: e, index: i }
  }

  /** The object a target moves on stage. */
  object (target: string | null): THREE.Object3D | null {
    const view = animator.character
    if (target === null || view === null) return null
    const bone = boneOf(target)
    if (bone !== null) return view.bones.get(bone) ?? null
    const prop = propOf(target)
    return prop === null ? null : view.root.getObjectByName(propNode(prop)) ?? null
  }

  /** Show the gizmo on the target (or hide it). */
  show (on: boolean): void {
    const stage = animator.stage
    if (stage === null) return
    if (this.gizmo === null) {
      this.gizmo = new TransformControls(stage.camera, stage.renderer.domElement)
      this.gizmo.setSize(0.7)
      this.gizmo.addEventListener('dragging-changed', (e) => {
        const dragging = (e as unknown as { value: boolean }).value
        stage.controls.enabled = !dragging
        if (dragging) { animator.setPlaying(false); animator.holding = true } else { animator.holding = false; void this.commit() }
      })
      stage.scene.add(this.gizmo.getHelper())
    }
    const object = on ? this.object(this.target) : null
    if (object === null) { this.gizmo.detach(); return }
    if (this.gizmo.object !== object) this.gizmo.attach(object)
    const moves = this.target !== null && (propOf(this.target) !== null || boneOf(this.target) === 'Hips')
    if (!moves && this.mode === 'translate') this.mode = 'rotate'
    this.gizmo.setMode(this.mode)
    this.gizmo.setSpace('local')
  }

  /** The frame playing, as a phase of the clip (snapped to a frame of it). */
  phase (): number {
    const e = this.entry
    if (e === null || animator.duration <= 0) return 0
    // (a ridden loop holds several of the rider's cycles, fitted to the horse's gait: a key's phase is within one)
    const cycles = Math.max(1, animator.cycles)
    const frames = Math.max(1, Math.round(animator.duration / e.entry.speed / cycles * KEY_FPS))
    const u = ((animator.time % animator.duration) / animator.duration * cycles) % 1
    return Math.round(u * frames) / frames
  }

  /** Key the target's pose at this frame (what the gizmo left, or as it stands). */
  async commit (): Promise<void> {
    const e = this.entry
    const target = this.target
    const object = this.object(target)
    const c = app.selected
    if (e === null || target === null || object === null || c === null) return
    const u = this.phase()
    const t = u * animator.duration
    let key: ClipKey
    const bone = boneOf(target)
    if (bone !== null) {
      const rest = animator.character?.rest?.bones.get(bone)
      const at = (suffix: string, size: number, fallback: number[]): number[] => {
        const track = animator.unkeyed?.tracks.find(x => x.name === `${bone}.${suffix}`)
        if (track === undefined) return fallback
        const i = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
        return Array.from(i.evaluate(t) as ArrayLike<number>).slice(0, size)
      }
      const base = new THREE.Quaternion().fromArray(at('quaternion', 4, rest?.localQuaternion.toArray() ?? [0, 0, 0, 1]))
      const q = base.invert().multiply(object.quaternion).normalize()
      key = { u, q: q.toArray() as ClipKey['q'] }
      if (bone === 'Hips') {
        const p = object.position.clone().sub(new THREE.Vector3().fromArray(at('position', 3, rest?.localPosition.toArray() ?? [0, 0, 0])))
        if (p.length() > 1e-6) key.p = p.toArray().map(v => Math.round(v * 1e5) / 1e5) as ClipKey['p']
      }
    } else {
      const name = propOf(target)!
      const g = c.garments?.find(x => x.name === name)
      if (g === undefined) return
      const gp = new THREE.Vector3(); const gq = new THREE.Quaternion(); const gs = new THREE.Vector3()
      garmentMatrix(g).decompose(gp, gq, gs)
      const inv = gq.clone().invert()
      const q = inv.clone().multiply(object.quaternion).normalize()
      const p = object.position.clone().sub(gp).applyQuaternion(inv).divideScalar(g.scale)
      key = { u, q: q.toArray() as ClipKey['q'] }
      if (p.length() > 1e-6) key.p = p.toArray().map(v => Math.round(v * 1e5) / 1e5) as ClipKey['p']
    }
    key.q = key.q.map(v => Math.round(v * 1e6) / 1e6) as ClipKey['q']
    await this.setKeys(target, keys => [...keys.filter(k => Math.abs(k.u - u) > 1e-4), key].sort((a, b) => a.u - b.u))
  }

  /** Change one target's keys on the entry playing, then play it again where it was. */
  async setKeys (target: string, change: (keys: ClipKey[]) => ClipKey[]): Promise<void> {
    const e = this.entry
    const c = app.selected
    if (e === null || c === null) return
    const kind = boneOf(target) !== null ? 'bones' : 'props'
    const name = (boneOf(target) ?? propOf(target))!
    const keys = { ...(e.entry.keys ?? {}) }
    const table = { ...(keys[kind] ?? {}) }
    const next = change(table[name] ?? [])
    if (next.length > 0) table[name] = next
    else delete table[name]
    keys[kind] = table
    await this.patchEntry(e.index, { keys })
  }

  async patchEntry (index: number, change: Partial<AnimationEntry>): Promise<void> {
    const c = app.selected
    if (c === null) return
    const next = c.animations.map((a, i) => (i === index ? { ...a, ...change } : a))
    await app.update(c.id, { animations: next })
    animator.playEntry(next[index], index, true)
  }

  /** The lift that sets this clip's lowest point on the ground (the soles' height at rest): measured on the clip as it
   * plays now, with the lift it has. */
  async autoGround (): Promise<void> {
    const e = this.entry
    const view = animator.character
    const root = animator.posableCopy()
    const clip = animator.clip
    if (e === null || view === null || root === null || clip === null) return
    this.busy = true
    try {
      let body: THREE.SkinnedMesh | undefined
      root.traverse(o => { if (body === undefined && (o as THREE.SkinnedMesh).isSkinnedMesh) body = o as THREE.SkinnedMesh })
      if (body === undefined) return
      const lowest = Math.min(...lowestPoints(root, body, clip))
      const lift = (e.entry.lift ?? 0) + (view.box.min.y - lowest)
      await this.patchEntry(e.index, { lift: Math.round(lift * 1e4) / 1e4 })
    } finally {
      this.busy = false
    }
  }
}

export const tune = new Tune()
