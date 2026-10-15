// Joint markers for placing the skeleton on an unrigged mesh (Mixamo-style), with mirrored editing.
import * as THREE from 'three'
import { hierarchy, mirrorName, side, type FingerLevel } from './mixamo.ts'
import type { Stage } from './Stage.ts'
import { templateSide, type Template } from './templates.ts'

/** What the editor needs to know about a skeleton: hierarchy, sides and mirror partners. */
export interface SkeletonSpec {
  bones: Array<[string, string | null]>
  side: (name: string) => 'left' | 'right' | 'center'
  mirror: (name: string) => string
}

export function humanSpec (fingers: FingerLevel): SkeletonSpec {
  return { bones: hierarchy(fingers), side, mirror: mirrorName }
}

export function templateSpec (template: Template): SkeletonSpec {
  return {
    bones: template.order.map(b => [b, template.parents[b]] as [string, string | null]),
    side: name => templateSide(template, name),
    mirror: name => template.mirror[name] ?? name,
  }
}

export type Joints = Record<string, [number, number, number]>

/** Plain deep copy (works on Svelte state proxies, unlike structuredClone). */
export function copyJoints (joints: Joints): Joints {
  return Object.fromEntries(Object.entries(joints).map(([k, v]) => [k, [v[0], v[1], v[2]]]))
}

const COLORS = { left: 0x6aaaff, right: 0xff7ab8, center: 0xf5c45e }

export interface JointEditorEvents {
  change: (joints: Joints) => void
  commit: (joints: Joints) => void
  hover: (name: string | null) => void
  select: (name: string | null) => void
}

export class JointEditor {
  readonly group = new THREE.Group()
  private joints: Joints
  private readonly markers = new Map<string, THREE.Mesh>()
  private readonly lines: THREE.LineSegments
  private readonly bones: Array<[string, string | null]>
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private dragging: { name: string, plane: THREE.Plane, offset: THREE.Vector3 } | null = null
  private hovered: string | null = null
  private selected: string | null = null
  mirror = true
  private readonly centerX: number
  private readonly radius: number
  private readonly unsubscribe: Array<() => void> = []

  constructor (private readonly stage: Stage, joints: Joints, private readonly spec: SkeletonSpec, height: number, private readonly events: Partial<JointEditorEvents>) {
    this.joints = copyJoints(joints)
    this.bones = spec.bones.filter(([b]) => b in this.joints)
    this.radius = height * 0.011
    const centers = Object.entries(joints).filter(([n]) => spec.side(n) === 'center').map(([, p]) => p[0])
    this.centerX = centers.length > 0 ? centers.reduce((a, b) => a + b, 0) / centers.length : 0
    const sphere = new THREE.SphereGeometry(1, 20, 14)
    for (const [name] of this.bones) {
      const material = new THREE.MeshBasicMaterial({ color: COLORS[spec.side(name)], depthTest: false, transparent: true })
      const marker = new THREE.Mesh(sphere, material)
      marker.name = name
      marker.renderOrder = 20
      const small = /Hand.+|leaf|tip|_end|Toe_End|finger|feather|ear|teeth|mouth/i.test(name) && name !== 'LeftHand' && name !== 'RightHand'
      const fingerScale = small ? 0.55 : 1
      marker.scale.setScalar(this.radius * fingerScale)
      marker.userData.baseScale = this.radius * fingerScale
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
    const move = (e: PointerEvent): void => { this.onMove(e) }
    const up = (e: PointerEvent): void => { this.onUp(e) }
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

  get value (): Joints { return copyJoints(this.joints) }

  setJoints (joints: Joints): void {
    this.joints = copyJoints(joints)
    this.sync()
  }

  setMirror (mirror: boolean): void {
    this.mirror = mirror
    this.sync()
  }

  select (name: string | null): void {
    this.selected = name
    this.events.select?.(name)
  }

  position (name: string): THREE.Vector3 | null {
    const p = this.joints[name]
    return p === undefined ? null : new THREE.Vector3(...p)
  }

  private sync (): void {
    for (const [name, marker] of this.markers) {
      marker.position.set(...this.joints[name])
      marker.visible = !(this.mirror && this.spec.side(name) === 'right')
    }
    const positions = this.lines.geometry.attributes.position as THREE.BufferAttribute
    let i = 0
    for (const [name, parent] of this.bones) {
      if (parent === null || !(parent in this.joints)) { positions.setXYZ(i++, 0, 0, 0); positions.setXYZ(i++, 0, 0, 0); continue }
      positions.setXYZ(i++, ...this.joints[parent])
      positions.setXYZ(i++, ...this.joints[name])
    }
    positions.needsUpdate = true
  }

  private animateMarkers (): void {
    for (const [name, marker] of this.markers) {
      const target = marker.userData.baseScale * (name === this.hovered || name === this.dragging?.name ? 1.6 : name === this.selected ? 1.35 : 1)
      marker.scale.setScalar(THREE.MathUtils.lerp(marker.scale.x, target, 0.3))
      ;(marker.material as THREE.MeshBasicMaterial).opacity = this.selected === null || name === this.selected || this.spec.mirror(name) === this.selected ? 1 : 0.75
    }
  }

  private pick (e: PointerEvent): string | null {
    const rect = this.stage.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.stage.camera)
    // Generous screen-space picking: nearest visible marker within ~14px.
    let best: string | null = null
    let bestDistance = 14
    for (const [name, marker] of this.markers) {
      if (!marker.visible) continue
      const p = this.stage.project(marker.position)
      const d = Math.hypot(p.x - (e.clientX - rect.left), p.y - (e.clientY - rect.top))
      if (d < bestDistance) { best = name; bestDistance = d }
    }
    return best
  }

  private onDown (e: PointerEvent): void {
    if (e.button !== 0) return
    const name = this.pick(e)
    if (name === null) return
    e.stopPropagation()
    this.stage.controls.enabled = false
    const position = this.position(name)!
    const normal = this.stage.camera.getWorldDirection(new THREE.Vector3()).negate()
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, position)
    const hit = new THREE.Vector3()
    this.raycaster.ray.intersectPlane(plane, hit)
    this.dragging = { name, plane, offset: position.clone().sub(hit) }
    this.select(name)
  }

  private onMove (e: PointerEvent): void {
    if (this.dragging === null) {
      const name = e.target === this.stage.renderer.domElement ? this.pick(e) : null
      if (name !== this.hovered) {
        this.hovered = name
        this.stage.renderer.domElement.style.cursor = name !== null ? 'grab' : ''
        this.events.hover?.(name)
      }
      return
    }
    const rect = this.stage.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.stage.camera)
    const hit = new THREE.Vector3()
    if (this.raycaster.ray.intersectPlane(this.dragging.plane, hit) === null) return
    hit.add(this.dragging.offset)
    this.move(this.dragging.name, hit)
    this.stage.renderer.domElement.style.cursor = 'grabbing'
    this.events.change?.(this.value)
  }

  /** Move a joint; with mirroring, its partner follows and center joints stay on the symmetry plane. */
  move (name: string, p: THREE.Vector3): void {
    const s = this.spec.side(name)
    if (this.mirror && s === 'center') p.x = this.centerX
    this.joints[name] = [p.x, p.y, p.z]
    const partner = this.spec.mirror(name)
    if (this.mirror && s !== 'center' && partner in this.joints) {
      this.joints[partner] = [2 * this.centerX - p.x, p.y, p.z]
    }
    this.sync()
  }

  private onUp (_e: PointerEvent): void {
    if (this.dragging === null) return
    this.dragging = null
    this.stage.controls.enabled = true
    this.stage.renderer.domElement.style.cursor = this.hovered !== null ? 'grab' : ''
    this.events.commit?.(this.value)
  }

  dispose (): void {
    for (const off of this.unsubscribe) off()
    this.stage.scene.remove(this.group)
    this.lines.geometry.dispose()
    for (const marker of this.markers.values()) (marker.material as THREE.Material).dispose()
    this.stage.controls.enabled = true
  }
}
