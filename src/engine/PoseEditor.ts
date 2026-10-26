// Posing a character in the stage, for the animation editor (src/state/clipedit.svelte.ts). A dot on every joint:
// dragging a limb's end (a hand, a foot, the head, a hoof) reaches the limb there (src/engine/ik.ts); dragging any other
// joint swings the bone above it towards the pointer; the hips handle crouches and jumps (up and down, the feet kept
// where they stand; Shift: any way). Clicking a joint selects it: the gizmo moves it as a drag does (arrows: one axis or
// a plane), or turns its bone (rings; about its own axes or the world's). Every joint is held in its
// limits (src/engine/limits.ts) and no foot goes under the floor. The clip stops driving the bones while a drag lasts
// (`begin`); letting go reports the bones it moved (`commit`), to key there.
import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import type { CharacterView } from './CharacterView.ts'
import type { JointLimits } from './limits.ts'
import { keepOffFloor, moveHips, plantedFeet, reach, setWorldQuaternion, type Leg, type Limb } from './ik.ts'
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
  /** After every move or turn, as it happens (`moving`: the joint moved): what holds (a hand on a prop) puts it back
   * on, but the joint being moved. */
  constrain: (moving: string | null) => void
  /** A prop picked (its name), or none. */
  selectProp: (prop: string | null) => void
  /** A prop moved or turned by the gizmo, to `place` (world): `done` when let go. */
  moveProp: (prop: string, place: THREE.Matrix4, done: boolean) => void
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
  /** What the gizmo does to the joint selected: moves it (the limb follows, as a drag) or turns its bone. */
  private mode: 'move' | 'rotate' = 'move'
  private space: 'local' | 'world' = 'local'
  /** What the move gizmo holds: a point at the joint (the joint follows it). */
  private readonly proxy = new THREE.Object3D()
  private gizmoDragging = false
  private gizmoFeet: Array<{ at: THREE.Vector3, turn: THREE.Quaternion }> = []
  private gizmoMoved = new Set<string>()
  private hovered: string | null = null
  private readonly legs: Leg[]
  private readonly soles: number[][]
  private readonly nameOf = (b: THREE.Bone): string => b.name

  private readonly stage: Stage
  private readonly view: CharacterView
  private readonly rig: PoseRig
  private readonly limits: JointLimits | null
  private readonly events: Partial<PoseEditorEvents>
  private readonly floor: number
  /** The props on stage: by name, the node each is placed by (its meshes under it). */
  private readonly props: () => Map<string, THREE.Object3D>
  /** The prop selected (the gizmo on it), or none. */
  private prop: string | null = null
  /** A joint held on a prop (a hand on a socket): where it holds it (world) and the prop's long axis there; the gizmo
   * then only slides it along that axis and rolls it round it. Given by the caller; null: no joint is. */
  private gripLock: ((bone: string) => { at: THREE.Vector3, axis: THREE.Vector3 } | null) | null = null
  /** A locked drag: where it began (the hold, the axis, the joint's place and turn, the gizmo's). */
  private lockStart: { at: THREE.Vector3, axis: THREE.Vector3, wrist: THREE.Vector3, turn: THREE.Quaternion, proxyAt: THREE.Vector3, proxyTurn: THREE.Quaternion } | null = null

  constructor (stage: Stage, view: CharacterView, rig: PoseRig, limits: JointLimits | null, events: Partial<PoseEditorEvents>, floor = 0, props: () => Map<string, THREE.Object3D> = () => new Map()) {
    this.stage = stage; this.view = view; this.rig = rig; this.limits = limits; this.events = events; this.floor = floor; this.props = props
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
    this.gizmo.setSize(0.7)
    stage.scene.add(this.proxy)
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const on = (e as unknown as { value: boolean }).value
      stage.controls.enabled = !on
      this.gizmoDragging = on
      if (on) {
        this.allowed = this.sunk()
        this.gizmoFeet = plantedFeet(this.legs)
        this.gizmoMoved = new Set(this.selected !== null && this.mode === 'rotate' ? [this.selected] : [])
        // (a joint held on a prop: the drag slides or rolls it from here)
        const lock = this.selected === null || this.prop !== null ? null : this.gripLock?.(this.selected) ?? null
        const held = this.selected === null ? undefined : this.view.bones.get(this.selected)
        this.lockStart = lock === null || held === undefined ? null : { ...lock, wrist: held.getWorldPosition(new THREE.Vector3()), turn: held.getWorldQuaternion(new THREE.Quaternion()), proxyAt: this.proxy.position.clone(), proxyTurn: this.proxy.quaternion.clone() }
        this.events.begin?.()
        return
      }
      if (this.prop !== null) { this.proxy.updateMatrixWorld(true); this.events.moveProp?.(this.prop, this.proxy.matrixWorld.clone(), true); return }
      if (this.gizmoMoved.size > 0) this.events.commit?.([...this.gizmoMoved])
    })
    this.gizmo.addEventListener('objectChange', () => {
      if (!this.gizmoDragging) return
      if (this.prop !== null) { this.proxy.updateMatrixWorld(true); this.events.moveProp?.(this.prop, this.proxy.matrixWorld.clone(), false); return }
      if (this.selected === null) return
      if (this.lockStart !== null) { this.moveHeld(this.selected, this.lockStart); return }
      if (this.mode === 'move') { this.moveJoint(this.selected, this.proxy.position.clone(), this.gizmoFeet, this.gizmoMoved); return }
      const b = bone(this.selected)
      if (b !== null && this.limits !== null && this.limits.has(b.name)) b.quaternion.copy(this.limits.clamp(b.name, b.quaternion))
      b?.updateMatrixWorld(true)
      this.events.constrain?.(this.selected)
      if (this.keepFeet()) for (const l of this.legs) for (const x of [l.upper, l.lower, l.end]) this.gizmoMoved.add(x.name)
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
    this.proxy.removeFromParent()
    this.group.removeFromParent()
    this.stage.controls.enabled = true
  }

  /** Select a joint (the gizmo on it), or none. */
  select (name: string | null): void {
    this.selected = name
    if (name !== null && this.prop !== null) { this.prop = null; this.events.selectProp?.(null) }
    this.attachGizmo()
    this.events.select?.(name)
  }

  /** Select a prop (the gizmo moves and turns it), or none. */
  selectProp (name: string | null): void {
    this.prop = name
    if (name !== null && this.selected !== null) { this.selected = null; this.events.select?.(null) }
    this.attachGizmo()
    this.events.selectProp?.(name)
  }

  get selectedProp (): string | null { return this.prop }

  /** Which joints are held on a prop (see gripLock): their gizmo slides them along the prop and rolls them round it. */
  setGripLock (lock: ((bone: string) => { at: THREE.Vector3, axis: THREE.Vector3 } | null) | null): void { this.gripLock = lock; this.attachGizmo() }

  /** A held joint dragged by its locked gizmo: slid along the prop's axis (moved), or rolled round it about where it holds
   * (turned: the roll only, whatever handle turned the gizmo); its limb reaches after it. */
  private moveHeld (name: string, from: NonNullable<PoseEditor['lockStart']>): void {
    const l = this.rig.limbs[name]; const end = this.view.bones.get(name)
    if (l === undefined || end === undefined) return
    const limb: Limb = { upper: this.view.bones.get(l.upper)!, lower: this.view.bones.get(l.lower)!, end: this.view.bones.get(l.end)! }
    const opts = { limits: this.limits ?? undefined, nameOf: this.nameOf }
    if (this.mode === 'move') {
      const d = this.proxy.position.clone().sub(from.proxyAt).dot(from.axis)
      this.proxy.position.copy(from.proxyAt).addScaledVector(from.axis, d)
      reach(limb, from.wrist.clone().addScaledVector(from.axis, d), { ...opts, keepEnd: true })
      setWorldQuaternion(end, from.turn)
    } else {
      // (the gizmo's turn since the drag began, its roll round the axis only)
      const delta = this.proxy.quaternion.clone().multiply(from.proxyTurn.clone().invert())
      const angle = 2 * Math.atan2(delta.x * from.axis.x + delta.y * from.axis.y + delta.z * from.axis.z, delta.w)
      const roll = new THREE.Quaternion().setFromAxisAngle(from.axis, angle)
      this.proxy.quaternion.copy(roll.clone().multiply(from.proxyTurn))
      reach(limb, from.wrist.clone().sub(from.at).applyQuaternion(roll).add(from.at), { ...opts, keepEnd: false })
      setWorldQuaternion(end, roll.clone().multiply(from.turn))
    }
    end.updateMatrixWorld(true)
    for (const b of [limb.upper, limb.lower, limb.end]) this.gizmoMoved.add(b.name)
    this.events.constrain?.(name)
  }

  /** Move the joint (the limb follows) or turn its bone; turn about the bone's own axes or the world's. */
  setMode (mode: 'move' | 'rotate'): void { this.mode = mode; this.attachGizmo() }
  setSpace (space: 'local' | 'world'): void { this.space = space; this.attachGizmo() }
  get gizmoMode (): 'move' | 'rotate' { return this.mode }

  /** The proxy where the prop is now (its world place, scale dropped). */
  private proxyOnProp (): boolean {
    const node = this.prop === null ? undefined : this.props().get(this.prop)
    if (node === undefined) return false
    node.updateMatrixWorld(true)
    const s = new THREE.Vector3()
    node.matrixWorld.decompose(this.proxy.position, this.proxy.quaternion, s)
    this.proxy.updateMatrixWorld(true)
    return true
  }

  private attachGizmo (): void {
    if (this.prop !== null) {
      if (!this.proxyOnProp()) { this.gizmo.detach(); return }
      this.gizmo.setMode(this.mode === 'move' ? 'translate' : 'rotate')
      this.gizmo.setSpace(this.mode === 'move' ? 'world' : this.space)
      this.gizmo.attach(this.proxy)
      return
    }
    const b = this.selected === null ? undefined : this.view.bones.get(this.selected)
    if (b === undefined) { this.gizmo.detach(); return }
    // (a joint held on a prop: the gizmo where it holds it, its X along the prop: slide along it, or roll round it)
    const lock = this.gripLock?.(b.name) ?? null
    const gz = this.gizmo as unknown as { showX: boolean, showY: boolean, showZ: boolean }
    gz.showX = true; gz.showY = lock === null; gz.showZ = lock === null
    if (lock !== null) {
      this.placeOnLock(lock)
      this.gizmo.setMode(this.mode === 'move' ? 'translate' : 'rotate')
      this.gizmo.setSpace('local')
      this.gizmo.attach(this.proxy)
      return
    }
    if (this.mode === 'move') {
      b.getWorldPosition(this.proxy.position)
      this.proxy.updateMatrixWorld(true)
      this.gizmo.setMode('translate')
      this.gizmo.setSpace('world')
      this.gizmo.attach(this.proxy)
    } else {
      this.gizmo.setMode('rotate')
      this.gizmo.setSpace(this.space)
      this.gizmo.attach(b)
    }
  }

  get selection (): string | null { return this.selected }

  /** The gizmo's proxy where a held joint holds, its X along the prop. */
  private placeOnLock (lock: { at: THREE.Vector3, axis: THREE.Vector3 }): void {
    this.proxy.position.copy(lock.at)
    this.proxy.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), lock.axis.clone().normalize())
    this.proxy.updateMatrixWorld(true)
  }

  /** The handles follow the bones (each frame), and the move gizmo its joint (but while it's dragged). */
  private place (): void {
    const v = new THREE.Vector3()
    const lock = this.selected === null || this.prop !== null || this.gizmoDragging ? null : this.gripLock?.(this.selected) ?? null
    if (this.prop !== null && !this.gizmoDragging) this.proxyOnProp()
    else if (lock !== null) this.placeOnLock(lock)
    else if (this.mode === 'move' && !this.gizmoDragging && this.selected !== null) {
      this.view.bones.get(this.selected)?.getWorldPosition(this.proxy.position)
      this.proxy.updateMatrixWorld(true)
    }
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

  /** Is the pointer on one of the gizmo's handles (an arrow, a plane, a ring)? */
  private overGizmo (e: PointerEvent): boolean {
    const gz = this.gizmo as unknown as { object?: THREE.Object3D, dragging: boolean, mode: string, _gizmo?: { picker?: Record<string, THREE.Object3D> } }
    if (gz.dragging) return true
    if (gz.object === undefined) return false
    const picker = gz._gizmo?.picker?.[gz.mode]
    if (picker === undefined) return false
    const r = this.stage.renderer.domElement.getBoundingClientRect()
    this.ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.stage.camera)
    this.gizmo.getHelper().updateMatrixWorld(true)
    return this.ray.intersectObject(picker, true).some(h => h.object.visible)
  }

  /** The prop under the pointer (the ray set by pick), or none. */
  private pickProp (): string | null {
    let best: { name: string, d: number } | null = null
    for (const [name, node] of this.props()) {
      const hit = this.ray.intersectObject(node, true)[0]
      if (hit !== undefined && (best === null || hit.distance < best.d)) best = { name, d: hit.distance }
    }
    return best?.name ?? null
  }

  private onDown (e: PointerEvent): void {
    // (the gizmo's handles first: what is under them is moved or turned by the gizmo, not picked)
    if (e.button !== 0 || this.overGizmo(e)) return
    const name = this.pick(e)
    if (name === null) {
      // (no joint there: a prop?)
      const prop = this.pickProp()
      if (prop !== null) { e.stopPropagation(); e.preventDefault(); this.selectProp(prop) }
      return
    }
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
    const want = d.kind === 'hips' && !(d.free || e.shiftKey) ? new THREE.Vector3(d.start.x, target.y, d.start.z) : target
    this.moveJoint(d.bone, want, d.feet, d.moved)
  }

  /** Move a joint to `target` (world): a limb's end reaches it, the hips go there with the feet kept (`feet`: where
   * they stood when the move began), any other joint swings the bone above it there. The bones moved go in `moved`. */
  private moveJoint (name: string, target: THREE.Vector3, feet: Array<{ at: THREE.Vector3, turn: THREE.Quaternion }>, moved: Set<string>): void {
    const bone = this.view.bones.get(name)
    if (bone === undefined) return
    const opts = { limits: this.limits ?? undefined, nameOf: this.nameOf }
    if (name === this.rig.hips) {
      const now = bone.getWorldPosition(new THREE.Vector3())
      moveHips(bone, target.clone().sub(now), this.legs, { ...opts, floor: this.floor, soles: this.soles, planted: feet })
      moved.add(bone.name)
      for (const l of this.legs) for (const b of [l.upper, l.lower, l.end]) moved.add(b.name)
    } else if (this.rig.limbs[name] !== undefined) {
      const l = this.rig.limbs[name]
      const limb: Limb = { upper: this.view.bones.get(l.upper)!, lower: this.view.bones.get(l.lower)!, end: this.view.bones.get(l.end)! }
      // (the joint moved may be below the limb's end, a hoof below its fetlock: the end moves with it)
      const offset = bone === limb.end ? new THREE.Vector3() : bone.getWorldPosition(new THREE.Vector3()).sub(limb.end.getWorldPosition(new THREE.Vector3()))
      reach(limb, target.clone().sub(offset), { ...opts, keepEnd: true })
      for (const b of [limb.upper, limb.lower, limb.end]) moved.add(b.name)
    } else {
      // swing the bone above towards the target
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
      moved.add(parent.name)
    }
    this.events.constrain?.(name)
    if (this.keepFeet()) for (const l of this.legs) for (const b of [l.upper, l.lower, l.end]) moved.add(b.name)
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
