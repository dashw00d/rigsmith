// Posing a character in the stage, for the animation editor (src/state/clipedit.svelte.ts). A dot on every joint:
// dragging a limb's end (a hand, a foot, the head, a hoof) reaches the limb there (src/engine/ik.ts); dragging any other
// joint swings the bone above it towards the pointer; the hips handle crouches and jumps (up and down, the feet kept
// where they stand; Shift: any way). Clicking a joint selects its bone, and a gizmo turns it. Every joint is held in its
// limits (src/engine/limits.ts) and no foot goes under the floor. The clip stops driving the bones while a drag lasts
// (`begin`); letting go reports the bones it moved (`commit`), to key there.
import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import type { CharacterView } from './CharacterView.ts'
import type { JointLimits } from './limits.ts'
import { keepOffFloor, moveHips, plantedFeet, reach, type Leg, type Limb } from './ik.ts'
import type { Stage } from './Stage.ts'

/** How a body is posed: its hips, the limbs a dragged end reaches with, the legs that stand. Names as the rig has them. */
export interface PoseRig {
  hips: string
  /** By the joint dragged: the limb reaching it there. */
  limbs: Record<string, { upper: string, lower: string, end: string }>
  legs: Array<{ upper: string, lower: string, end: string, ball: string | null, tip: string | null }>
}

export const HUMAN_RIG: PoseRig = {
  hips: 'Hips',
  limbs: Object.fromEntries([
    ...(['Left', 'Right'] as const).flatMap(s => [
      [`${s}Hand`, { upper: `${s}Arm`, lower: `${s}ForeArm`, end: `${s}Hand` }],
      [`${s}Foot`, { upper: `${s}UpLeg`, lower: `${s}Leg`, end: `${s}Foot` }],
    ]),
    ['Head', { upper: 'Neck', lower: 'Head', end: 'HeadTop_End' }],
    ['HeadTop_End', { upper: 'Neck', lower: 'Head', end: 'HeadTop_End' }],
  ]),
  legs: (['Left', 'Right'] as const).map(s => ({ upper: `${s}UpLeg`, lower: `${s}Leg`, end: `${s}Foot`, ball: `${s}ToeBase`, tip: `${s}Toe_End` })),
}

// (a horse's leg: the two long bones above the fetlock reach it; the pastern and the hoof keep their turn)
const front = (s: string): PoseRig['legs'][number] => ({ upper: `front_leg_upper_${s}`, lower: `front_leg_lower_${s}`, end: `front_leg_ankle_${s}`, ball: `front_leg_foot_${s}`, tip: `front_leg_leaf_${s}` })
const hind = (s: string): PoseRig['legs'][number] => ({ upper: `back_leg_lower_${s}`, lower: `back_leg_ankle_${s}`, end: `back_leg_foot_${s}`, ball: `back_leg_toe_${s}`, tip: `back_leg_leaf_${s}` })
export const HORSE_RIG: PoseRig = {
  hips: 'hips',
  limbs: Object.fromEntries(['l', 'r'].flatMap(s => [front(s), hind(s)].flatMap(l => [[l.end, l], [l.ball!, l]]))),
  legs: ['l', 'r'].flatMap(s => [front(s), hind(s)]),
}

export interface PoseEditorEvents {
  select: (bone: string | null) => void
  hover: (bone: string | null) => void
  begin: () => void
  commit: (bones: string[]) => void
}

const COLOR = { joint: 0xe9ebf1, end: 0x6aaaff, hips: 0xf5c45e, selected: 0xff7ab8 }

export class PoseEditor {
  readonly group = new THREE.Group()
  private readonly handles = new Map<string, THREE.Mesh>()
  private readonly lines: THREE.LineSegments
  private readonly pairs: Array<[THREE.Bone, THREE.Bone]> = []
  private readonly ray = new THREE.Raycaster()
  private readonly gizmo: TransformControls
  private readonly off: Array<() => void> = []
  private drag: { bone: string, kind: 'reach' | 'swing' | 'hips', plane: THREE.Plane, grab: THREE.Vector3, start: THREE.Vector3, moved: Set<string>, free: boolean, feet: Array<{ at: THREE.Vector3, turn: THREE.Quaternion }> } | null = null
  private selected: string | null = null
  private hovered: string | null = null
  private readonly legs: Leg[]
  private readonly soles: number[][]
  private readonly nameOf = (b: THREE.Bone): string => b.name

  constructor (private readonly stage: Stage, private readonly view: CharacterView, private readonly rig: PoseRig, private readonly limits: JointLimits | null,
    private readonly events: Partial<PoseEditorEvents>, private readonly floor = 0) {
    const radius = view.height * 0.012
    const sphere = new THREE.SphereGeometry(1, 16, 12)
    const diamond = new THREE.OctahedronGeometry(1)
    const ends = new Set(Object.keys(rig.limbs))
    for (const bone of view.bones.values()) {
      const name = bone.name
      const hips = name === rig.hips
      const small = /Hand.+\d|leaf|_End$|ear|mouth|nose/i.test(name) && !ends.has(name)
      const m = new THREE.Mesh(hips ? diamond : sphere, new THREE.MeshBasicMaterial({ color: hips ? COLOR.hips : ends.has(name) ? COLOR.end : COLOR.joint, depthTest: false, transparent: true, opacity: 0.9 }))
      m.name = name
      m.renderOrder = 30
      const size = radius * (hips ? 2.2 : ends.has(name) ? 1.4 : small ? 0.5 : 0.85)
      m.scale.setScalar(size)
      m.userData.size = size
      this.handles.set(name, m)
      this.group.add(m)
      const parent = bone.parent as THREE.Bone | null
      if (parent?.isBone === true) this.pairs.push([parent, bone])
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pairs.length * 6), 3))
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xe9ebf1, transparent: true, opacity: 0.45, depthTest: false }))
    this.lines.renderOrder = 29
    this.lines.frustumCulled = false
    this.group.add(this.lines)
    stage.scene.add(this.group)
    const bone = (n: string | null): THREE.Bone | null => (n === null ? null : view.bones.get(n) ?? null)
    this.legs = rig.legs.filter(l => bone(l.upper) !== null && bone(l.lower) !== null && bone(l.end) !== null)
      .map(l => ({ upper: bone(l.upper)!, lower: bone(l.lower)!, end: bone(l.end)!, ball: bone(l.ball), tip: bone(l.tip) }))
    // (the soles' heights above the floor, the character standing at rest)
    const rest = view.rest
    this.soles = this.legs.map(l => [l.end, l.ball, l.tip].map(b => (b === null ? -Infinity : (rest?.bones.get(b.name)?.worldPosition.y ?? b.getWorldPosition(new THREE.Vector3()).y) - floor)))

    this.gizmo = new TransformControls(stage.camera, stage.renderer.domElement)
    this.gizmo.setSize(0.6)
    this.gizmo.setMode('rotate')
    this.gizmo.setSpace('local')
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const on = (e as unknown as { value: boolean }).value
      stage.controls.enabled = !on
      if (on) { this.allowed = this.sunk(); this.events.begin?.(); return }
      if (this.selected !== null) this.events.commit?.([this.selected])
    })
    this.gizmo.addEventListener('objectChange', () => {
      const b = bone(this.selected)
      if (b !== null && this.limits !== null && this.limits.has(b.name)) b.quaternion.copy(this.limits.clamp(b.name, b.quaternion))
      this.keepFeet()
    })
    stage.scene.add(this.gizmo.getHelper())

    const canvas = stage.renderer.domElement
    const down = (e: PointerEvent): void => { this.onDown(e) }
    const move = (e: PointerEvent): void => { if (!stage.covered) this.onMove(e) }
    const up = (): void => { this.onUp() }
    canvas.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    this.off.push(() => {
      canvas.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    })
    this.off.push(stage.onFrame(() => { this.place() }))
  }

  dispose (): void {
    for (const f of this.off) f()
    this.gizmo.detach()
    this.gizmo.getHelper().removeFromParent()
    this.gizmo.dispose()
    this.group.removeFromParent()
    this.stage.controls.enabled = true
  }

  /** Select a bone (the gizmo turns it), or none. */
  select (name: string | null): void {
    this.selected = name
    const b = name === null ? undefined : this.view.bones.get(name)
    if (b === undefined) this.gizmo.detach(); else this.gizmo.attach(b)
    this.events.select?.(name)
  }

  get selection (): string | null { return this.selected }

  /** The handles follow the bones (each frame). */
  private place (): void {
    const v = new THREE.Vector3()
    for (const [name, m] of this.handles) {
      const b = this.view.bones.get(name)!
      b.getWorldPosition(v)
      m.position.copy(v)
      // (a constant size on screen, about)
      const k = this.stage.camera.position.distanceTo(v) / 3
      m.scale.setScalar(m.userData.size as number * Math.max(k, 0.3) * (name === this.hovered || name === this.selected ? 1.35 : 1));
      (m.material as THREE.MeshBasicMaterial).color.setHex(name === this.selected ? COLOR.selected : name === this.rig.hips ? COLOR.hips : this.rig.limbs[name] !== undefined ? COLOR.end : COLOR.joint)
    }
    const p = this.lines.geometry.attributes.position as THREE.BufferAttribute
    this.pairs.forEach(([a, b], i) => {
      a.getWorldPosition(v); p.setXYZ(i * 2, v.x, v.y, v.z)
      b.getWorldPosition(v); p.setXYZ(i * 2 + 1, v.x, v.y, v.z)
    })
    p.needsUpdate = true
  }

  private pick (e: PointerEvent): string | null {
    const r = this.stage.renderer.domElement.getBoundingClientRect()
    this.ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.stage.camera)
    const hits = this.ray.intersectObjects([...this.handles.values()], false)
    if (hits.length === 0) return null
    // (the handle nearest the pointer's line, then the nearest the eye: small dots inside big ones stay pickable)
    hits.sort((a, b) => (a.object.userData.size as number) - (b.object.userData.size as number) || a.distance - b.distance)
    return hits[0].object.name
  }

  private onDown (e: PointerEvent): void {
    // (the gizmo's rings first: a joint under them is turned, not dragged)
    const gizmo = this.gizmo as unknown as { dragging: boolean, axis: string | null }
    if (e.button !== 0 || gizmo.dragging || (this.selected !== null && gizmo.axis !== null)) return
    const name = this.pick(e)
    if (name === null) return
    e.stopPropagation(); e.preventDefault()
    const bone = this.view.bones.get(name)!
    const at = bone.getWorldPosition(new THREE.Vector3())
    const normal = this.stage.camera.getWorldDirection(new THREE.Vector3()).negate()
    const kind = name === this.rig.hips ? 'hips' : this.rig.limbs[name] !== undefined ? 'reach' : 'swing'
    // (the hips go up and down: a plane through them facing the eye, upright)
    if (kind === 'hips') { normal.y = 0; if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1); normal.normalize() }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, at)
    const grab = this.ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? at.clone()
    this.drag = { bone: name, kind, plane, grab, start: at, moved: new Set(), free: e.shiftKey, feet: plantedFeet(this.legs) }
    this.allowed = this.sunk()
    this.stage.controls.enabled = false
    this.select(name)
    this.events.begin?.()
  }

  private onMove (e: PointerEvent): void {
    const d = this.drag
    if (d === null) {
      const h = this.pick(e)
      if (h !== this.hovered) { this.hovered = h; this.events.hover?.(h) }
      return
    }
    const r = this.stage.renderer.domElement.getBoundingClientRect()
    this.ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.stage.camera)
    const hit = this.ray.ray.intersectPlane(d.plane, new THREE.Vector3())
    if (hit === null) return
    const target = d.start.clone().add(hit.sub(d.grab))
    const bone = this.view.bones.get(d.bone)!
    const opts = { limits: this.limits ?? undefined, nameOf: this.nameOf }
    if (d.kind === 'hips') {
      const hips = this.view.bones.get(this.rig.hips)!
      const now = hips.getWorldPosition(new THREE.Vector3())
      const want = d.free || e.shiftKey ? target : new THREE.Vector3(d.start.x, target.y, d.start.z)
      moveHips(hips, want.sub(now), this.legs, { ...opts, floor: this.floor, soles: this.soles, planted: d.feet })
      d.moved.add(hips.name)
      for (const l of this.legs) for (const b of [l.upper, l.lower, l.end]) d.moved.add(b.name)
    } else if (d.kind === 'reach') {
      const l = this.rig.limbs[d.bone]
      const limb: Limb = { upper: this.view.bones.get(l.upper)!, lower: this.view.bones.get(l.lower)!, end: this.view.bones.get(l.end)! }
      // (the joint dragged may be below the limb's end, a hoof below its fetlock: the end moves with it)
      const offset = bone === limb.end ? new THREE.Vector3() : bone.getWorldPosition(new THREE.Vector3()).sub(limb.end.getWorldPosition(new THREE.Vector3()))
      reach(limb, target.clone().sub(offset), { ...opts, keepEnd: true })
      for (const b of [limb.upper, limb.lower, limb.end]) d.moved.add(b.name)
    } else {
      // swing the bone above towards the pointer
      const parent = bone.parent as THREE.Bone
      if (parent?.isBone !== true) return
      const p = parent.getWorldPosition(new THREE.Vector3())
      const from = bone.getWorldPosition(new THREE.Vector3()).sub(p)
      const to = target.clone().sub(p)
      if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return
      const q = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize()).multiply(parent.getWorldQuaternion(new THREE.Quaternion()))
      const pq = parent.parent === null ? new THREE.Quaternion() : parent.parent.getWorldQuaternion(new THREE.Quaternion())
      parent.quaternion.copy(pq.invert().multiply(q))
      if (this.limits !== null && this.limits.has(parent.name)) parent.quaternion.copy(this.limits.clamp(parent.name, parent.quaternion))
      parent.updateMatrixWorld(true)
      d.moved.add(parent.name)
    }
    if (this.keepFeet()) for (const l of this.legs) for (const b of [l.upper, l.lower, l.end]) d.moved.add(b.name)
  }

  /** How far under the floor each leg's soles are now (0 above it). */
  private sunk (): number[] {
    const v = new THREE.Vector3()
    return this.legs.map((l, i) => Math.max(0, ...[l.end, l.ball, l.tip].map((b, k) => (b === null || !Number.isFinite(this.soles[i][k]) ? 0 : this.floor + this.soles[i][k] - b.getWorldPosition(v).y))))
  }

  /** As far as each leg was under the floor when the drag began: a drag sinks no foot further (the clip's own pose,
   * a foot a hair under the floor, stays as it was). */
  private allowed: number[] = []

  /** No foot under the floor (further than it was when the drag began). Returns whether a leg was lifted. */
  private keepFeet (): boolean {
    const before = this.legs.map(l => l.end.getWorldPosition(new THREE.Vector3()).y)
    this.legs.forEach((leg, i) => keepOffFloor([leg], this.floor - (this.allowed[i] ?? 0) - 1e-4, [this.soles[i]], { limits: this.limits ?? undefined, nameOf: this.nameOf }))
    return this.legs.some((l, i) => Math.abs(l.end.getWorldPosition(new THREE.Vector3()).y - before[i]) > 1e-6)
  }

  private onUp (): void {
    const d = this.drag
    if (d === null) return
    this.drag = null
    this.stage.controls.enabled = true
    this.events.commit?.([...d.moved])
  }
}
