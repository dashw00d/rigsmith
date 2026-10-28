// The Skeleton step's 3D joints: a sphere on every joint of the character's skeleton (blue left, pink right, yellow
// on the middle line; smaller on fingers, tips and ears) and white lines for its bones, drawn over the model. A drag
// moves a joint on the plane facing the camera; with mirroring on, its partner follows mirrored and middle joints stay
// on the symmetry plane (the right side's spheres are hidden then). Letting go commits the joints the drag moved:
// they become the user's placements (skeleton.place), the marker board's other camera on the same overrides.
import * as THREE from 'three'
import type { Joints } from '../model/types.ts'
import type { Stage } from './Stage.ts'
import type { SkeletonSpec } from './templates.ts'

export type { Joints }

/** Plain deep copy (works on Svelte state proxies, unlike structuredClone). */
export function copyJoints (joints: Joints): Joints {
  return Object.fromEntries(Object.entries(joints).map(([k, v]) => [k, [v[0], v[1], v[2]]]))
}

const COLORS = { left: 0x6aaaff, right: 0xff7ab8, center: 0xf5c45e }
const SMALL = /Hand.+|leaf|tip|_end|Toe_End|finger|feather|ear|teeth|mouth/i
/** How near (screen pixels) the pointer must come to a joint to take it. */
const REACH = 14

export interface JointEditorEvents {
  /** A drag ended: the joints it moved (the one dragged and, mirrored, its partner), where they are now. */
  commit: (moved: Joints) => void
  hover: (name: string | null) => void
  select: (name: string | null) => void
}

export class JointEditor {
  readonly group = new THREE.Group()
  private readonly joints: Joints
  private readonly markers = new Map<string, THREE.Mesh>()
  private readonly lines: THREE.LineSegments
  private readonly bones: Array<[string, string | null]>
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  // (kept and reused: a pointer move allocates nothing)
  private readonly hit = new THREE.Vector3()
  private readonly screen = new THREE.Vector3()
  private readonly plane = new THREE.Plane()
  private readonly offset = new THREE.Vector3()
  private dragging: string | null = null
  private hovered: string | null = null
  private selected: string | null = null
  private enabled = true
  mirror = true
  private readonly centerX: number
  private readonly radius: number
  private readonly unsubscribe: Array<() => void> = []

  private readonly stage: Stage
  private readonly spec: SkeletonSpec
  private readonly events: Partial<JointEditorEvents>

  constructor (stage: Stage, joints: Joints, spec: SkeletonSpec, height: number, events: Partial<JointEditorEvents>) {
    this.stage = stage
    this.spec = spec
    this.events = events
    this.joints = copyJoints(joints)
    this.bones = spec.bones.filter(([b]) => b in this.joints)
    this.radius = height * 0.011
    const centers = Object.keys(this.joints).filter(n => spec.side(n) === 'center').map(n => this.joints[n][0])
    this.centerX = centers.length > 0 ? centers.reduce((a, b) => a + b, 0) / centers.length : 0
    const sphere = new THREE.SphereGeometry(1, 20, 14)
    for (const [name] of this.bones) {
      const material = new THREE.MeshBasicMaterial({ color: COLORS[spec.side(name)], depthTest: false, transparent: true })
      const marker = new THREE.Mesh(sphere, material)
      marker.name = name
      marker.renderOrder = 20
      const small = SMALL.test(name) && name !== 'LeftHand' && name !== 'RightHand'
      const scale = this.radius * (small ? 0.55 : 1)
      marker.scale.setScalar(scale)
      marker.userData.baseScale = scale
      this.markers.set(name, marker)
      this.group.add(marker)
    }
    const lineGeometry = new THREE.BufferGeometry()
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.bones.length * 6), 3))
    this.lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: 0xe9ebf1, transparent: true, opacity: 0.55, depthTest: false }))
    this.lines.renderOrder = 19
    this.lines.frustumCulled = false
    this.group.add(this.lines)
    stage.scene.add(this.group)
    this.sync()

    const canvas = stage.renderer.domElement
    const down = (e: PointerEvent): void => { this.onDown(e) }
    // (not under something covering the stage: the marker board takes the pointer then)
    const move = (e: PointerEvent): void => { if (!this.stage.covered) this.onMove(e) }
    const up = (): void => { this.onUp() }
    canvas.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    this.unsubscribe.push(() => {
      canvas.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    })
    this.unsubscribe.push(stage.onFrame(() => { this.animateMarkers() }))
  }

  /** The joints it was built for, by name (a skeleton with other joints needs a new editor). */
  get names (): string[] { return this.bones.map(([b]) => b) }

  get busy (): boolean { return this.dragging !== null }

  /** The joints as shown now (the skeleton changed elsewhere: the marker board, an undo, a finger trace). A drag in
   * progress keeps its joint. */
  setJoints (joints: Joints): void {
    for (const [name, p] of Object.entries(joints)) {
      const j = this.joints[name]
      if (j === undefined || name === this.dragging) continue
      j[0] = p[0]; j[1] = p[1]; j[2] = p[2]
    }
    this.sync()
  }

  /** True when it shows these joints (within a hair). */
  shows (joints: Joints): boolean {
    for (const [name, p] of Object.entries(joints)) {
      const j = this.joints[name]
      if (j !== undefined && (Math.abs(j[0] - p[0]) > 1e-9 || Math.abs(j[1] - p[1]) > 1e-9 || Math.abs(j[2] - p[2]) > 1e-9)) return false
    }
    return true
  }

  setMirror (mirror: boolean): void {
    this.mirror = mirror
    this.sync()
  }

  /** Shown and taking the pointer (hidden while a clip plays: the joints are where the body is at rest). */
  setEnabled (on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    this.group.visible = on
    if (!on) {
      if (this.dragging !== null) this.onUp()
      this.setHovered(null)
    }
  }

  select (name: string | null): void {
    if (name === this.selected) return
    this.selected = name
    this.events.select?.(name)
  }

  /** Where a joint shows on screen (canvas pixels), or null when it has none or is behind the camera. */
  screenOf (name: string): { x: number, y: number } | null {
    const p = this.joints[name]
    if (p === undefined) return null
    this.screen.set(p[0], p[1], p[2]).project(this.stage.camera)
    if (this.screen.z > 1) return null
    const canvas = this.stage.renderer.domElement
    return { x: (this.screen.x + 1) / 2 * canvas.clientWidth, y: (1 - this.screen.y) / 2 * canvas.clientHeight }
  }

  private sync (): void {
    for (const [name, marker] of this.markers) {
      const p = this.joints[name]
      marker.position.set(p[0], p[1], p[2])
      marker.visible = !(this.mirror && this.spec.side(name) === 'right')
    }
    const positions = this.lines.geometry.attributes.position as THREE.BufferAttribute
    let i = 0
    for (const [name, parent] of this.bones) {
      const a = parent === null ? undefined : this.joints[parent]
      const b = this.joints[name]
      if (a === undefined) { positions.setXYZ(i++, 0, 0, 0); positions.setXYZ(i++, 0, 0, 0); continue }
      positions.setXYZ(i++, a[0], a[1], a[2])
      positions.setXYZ(i++, b[0], b[1], b[2])
    }
    positions.needsUpdate = true
  }

  private animateMarkers (): void {
    if (!this.enabled) return
    for (const [name, marker] of this.markers) {
      const target = marker.userData.baseScale * (name === this.hovered || name === this.dragging ? 1.6 : name === this.selected ? 1.35 : 1)
      marker.scale.setScalar(THREE.MathUtils.lerp(marker.scale.x, target, 0.3))
      ;(marker.material as THREE.MeshBasicMaterial).opacity = this.selected === null || name === this.selected || this.spec.mirror(name) === this.selected ? 1 : 0.75
    }
  }

  private aim (e: PointerEvent): DOMRect {
    const rect = this.stage.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    return rect
  }

  /** The visible joint nearest the pointer within reach, on screen. */
  private pick (e: PointerEvent): string | null {
    const rect = this.aim(e)
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    let best: string | null = null
    let bestDistance = REACH
    for (const [name, marker] of this.markers) {
      if (!marker.visible) continue
      this.screen.copy(marker.position).project(this.stage.camera)
      if (this.screen.z > 1) continue
      const d = Math.hypot((this.screen.x + 1) / 2 * rect.width - x, (1 - this.screen.y) / 2 * rect.height - y)
      if (d < bestDistance) { best = name; bestDistance = d }
    }
    return best
  }

  private setHovered (name: string | null): void {
    if (name === this.hovered) return
    this.hovered = name
    this.stage.renderer.domElement.style.cursor = name !== null ? 'grab' : ''
    this.events.hover?.(name)
  }

  private onDown (e: PointerEvent): void {
    if (e.button !== 0 || !this.enabled || this.stage.covered) return
    const name = this.pick(e)
    if (name === null) return
    e.stopPropagation()
    this.stage.controls.enabled = false
    const p = this.joints[name]
    this.hit.set(p[0], p[1], p[2])
    this.stage.camera.getWorldDirection(this.offset).negate()
    this.plane.setFromNormalAndCoplanarPoint(this.offset, this.hit)
    this.raycaster.setFromCamera(this.pointer, this.stage.camera)
    if (this.raycaster.ray.intersectPlane(this.plane, this.offset) === null) this.offset.copy(this.hit)
    this.offset.subVectors(this.hit, this.offset)
    this.dragging = name
    this.select(name)
  }

  private onMove (e: PointerEvent): void {
    if (!this.enabled) return
    if (this.dragging === null) {
      this.setHovered(e.target === this.stage.renderer.domElement ? this.pick(e) : null)
      return
    }
    this.aim(e)
    this.raycaster.setFromCamera(this.pointer, this.stage.camera)
    if (this.raycaster.ray.intersectPlane(this.plane, this.hit) === null) return
    this.hit.add(this.offset)
    this.move(this.dragging, this.hit)
    this.stage.renderer.domElement.style.cursor = 'grabbing'
  }

  /** Move a joint; with mirroring, its partner follows and middle joints stay on the symmetry plane. */
  move (name: string, p: THREE.Vector3): void {
    const j = this.joints[name]
    if (j === undefined) return
    const s = this.spec.side(name)
    j[0] = this.mirror && s === 'center' ? this.centerX : p.x
    j[1] = p.y
    j[2] = p.z
    const partner = this.spec.mirror(name)
    const other = this.joints[partner]
    if (this.mirror && s !== 'center' && other !== undefined) {
      other[0] = 2 * this.centerX - j[0]
      other[1] = j[1]
      other[2] = j[2]
    }
    this.sync()
  }

  private onUp (): void {
    const name = this.dragging
    if (name === null) return
    this.dragging = null
    this.stage.controls.enabled = true
    this.stage.renderer.domElement.style.cursor = this.hovered !== null ? 'grab' : ''
    const moved: Joints = { [name]: [...this.joints[name]] }
    const partner = this.spec.mirror(name)
    if (this.mirror && partner !== name && this.joints[partner] !== undefined) moved[partner] = [...this.joints[partner]]
    this.events.commit?.(moved)
  }

  dispose (): void {
    if (this.dragging !== null) this.stage.controls.enabled = true
    for (const off of this.unsubscribe) off()
    this.stage.scene.remove(this.group)
    this.lines.geometry.dispose()
    for (const marker of this.markers.values()) (marker.material as THREE.Material).dispose()
    this.markers.values().next().value?.geometry.dispose()
    this.stage.renderer.domElement.style.cursor = ''
  }
}
