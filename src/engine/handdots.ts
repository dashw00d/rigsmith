// Posing a hand by its finger joints (Rig → Hand poses): a ring on each joint past the knuckle and on each fingertip.
// Dragging one turns the joint behind it toward the pointer, so the finger curls in, opens out or spreads; the
// caller holds the turn within what a finger reaches and keeps it as the pose.
import * as THREE from 'three'
import { FINGERS, type Side } from './handposes.ts'
import type { Stage } from './Stage.ts'

export interface HandDotsEvents {
  /** `bone` (a finger joint) turned to `local` while a ring is dragged */
  turn: (bone: string, local: THREE.Quaternion) => void
  /** the drag let go */
  end: () => void
}

export class HandDots {
  private readonly group = new THREE.Group()
  private readonly spots = new Map<string, THREE.Sprite>()
  private readonly bones = new Map<string, THREE.Bone>()
  private readonly lines: THREE.LineSegments
  private dragging: { name: string, plane: THREE.Plane } | null = null
  private hovered: string | null = null
  private readonly raycaster = new THREE.Raycaster()
  private readonly off: Array<() => void> = []
  private readonly texture: THREE.CanvasTexture

  constructor (private readonly stage: Stage, root: THREE.Object3D, side: Side, private readonly events: HandDotsEvents) {
    const wanted = new Set(FINGERS.flatMap(f => [1, 2, 3, 4].map(i => `${side}Hand${f}${i}`)))
    root.traverse(o => { if ((o as THREE.Bone).isBone && wanted.has(o.name) && !this.bones.has(o.name)) this.bones.set(o.name, o as THREE.Bone) })
    this.texture = ring(side === 'Left' ? '#6aaaff' : '#ff7ab8')
    // (a ring on each joint a drag can turn the finger by: every one past the knuckle, and the tip)
    for (const [name, bone] of this.bones) {
      if (name.endsWith('1') || !this.bones.has(bone.parent?.name ?? '')) continue
      const spot = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, depthTest: false, transparent: true }))
      spot.renderOrder = 21
      this.spots.set(name, spot)
      this.group.add(spot)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.bones.size * 6), 3))
    this.lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xffb547, transparent: true, opacity: 0.45, depthTest: false }))
    this.lines.renderOrder = 20
    this.lines.frustumCulled = false
    this.group.add(this.lines)
    stage.scene.add(this.group)

    const canvas = stage.renderer.domElement
    const down = (e: PointerEvent): void => { this.onDown(e) }
    const move = (e: PointerEvent): void => { if (!this.stage.covered) this.onMove(e) }
    const up = (): void => { this.onUp() }
    canvas.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    this.off.push(() => {
      canvas.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    })
    this.off.push(stage.onFrame(() => { this.draw() }))
  }

  /** The rings on the joints as posed now, each a few pixels across on screen (bigger under the pointer). */
  draw (): void {
    const camera = this.stage.camera
    const height = this.stage.renderer.domElement.clientHeight || 1
    const perPixel = (d: number): number => 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / height
    for (const [name, spot] of this.spots) {
      this.bones.get(name)!.getWorldPosition(spot.position)
      const hot = name === this.hovered || name === this.dragging?.name
      spot.scale.setScalar(perPixel(camera.position.distanceTo(spot.position)) * (hot ? 18 : 13))
    }
    const positions = this.lines.geometry.attributes.position as THREE.BufferAttribute
    let i = 0
    const a = new THREE.Vector3(); const b = new THREE.Vector3()
    for (const bone of this.bones.values()) {
      if (bone.parent === null) continue
      bone.parent.getWorldPosition(a); bone.getWorldPosition(b)
      positions.setXYZ(i++, a.x, a.y, a.z); positions.setXYZ(i++, b.x, b.y, b.z)
    }
    for (; i < positions.count; i++) positions.setXYZ(i, 0, 0, 0)
    positions.needsUpdate = true
  }

  private pick (e: PointerEvent): string | null {
    const rect = this.stage.renderer.domElement.getBoundingClientRect()
    let best: string | null = null
    let bestDistance = 12
    for (const [name, spot] of this.spots) {
      const p = this.stage.project(spot.position)
      const d = Math.hypot(p.x - (e.clientX - rect.left), p.y - (e.clientY - rect.top))
      if (d < bestDistance) { best = name; bestDistance = d }
    }
    return best
  }

  private hit (e: PointerEvent, plane: THREE.Plane): THREE.Vector3 | null {
    const rect = this.stage.renderer.domElement.getBoundingClientRect()
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), this.stage.camera)
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3())
  }

  private onDown (e: PointerEvent): void {
    if (e.button !== 0) return
    const name = this.pick(e)
    if (name === null) return
    e.stopPropagation()
    this.stage.controls.enabled = false
    const at = this.bones.get(name)!.getWorldPosition(new THREE.Vector3())
    this.dragging = { name, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(this.stage.camera.getWorldDirection(new THREE.Vector3()).negate(), at) }
  }

  private onMove (e: PointerEvent): void {
    const canvas = this.stage.renderer.domElement
    if (this.dragging === null) {
      const name = e.target === canvas ? this.pick(e) : null
      if (name !== this.hovered) { this.hovered = name; canvas.style.cursor = name !== null ? 'grab' : '' }
      return
    }
    const target = this.hit(e, this.dragging.plane)
    const child = this.bones.get(this.dragging.name)!
    const joint = child.parent as THREE.Bone | null
    if (target === null || joint === null || joint.parent === null) return
    // (the joint behind the ring turned so the finger points at the pointer: the shortest turn there)
    joint.updateWorldMatrix(true, false)
    const at = new THREE.Vector3().setFromMatrixPosition(joint.matrixWorld)
    const now = child.getWorldPosition(new THREE.Vector3()).sub(at)
    const want = target.sub(at)
    if (now.lengthSq() < 1e-12 || want.lengthSq() < 1e-12) return
    const swing = new THREE.Quaternion().setFromUnitVectors(now.normalize(), want.normalize())
    const world = joint.getWorldQuaternion(new THREE.Quaternion())
    const parent = joint.parent.getWorldQuaternion(new THREE.Quaternion())
    const local = parent.invert().multiply(swing.multiply(world)).normalize()
    canvas.style.cursor = 'grabbing'
    this.events.turn(joint.name, local)
  }

  private onUp (): void {
    if (this.dragging === null) return
    this.dragging = null
    this.stage.controls.enabled = true
    this.stage.renderer.domElement.style.cursor = this.hovered !== null ? 'grab' : ''
    this.events.end()
  }

  dispose (): void {
    for (const off of this.off) off()
    this.stage.scene.remove(this.group)
    this.lines.geometry.dispose()
    for (const spot of this.spots.values()) spot.material.dispose()
    this.texture.dispose()
    this.stage.controls.enabled = true
    this.stage.renderer.domElement.style.cursor = ''
  }
}

/** A ring in the hand's color, edged dark to stand out on skin, hollow so the finger shows through. */
function ring (color: string): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  const c = size / 2
  g.lineWidth = 14; g.strokeStyle = 'rgba(10, 12, 18, 0.85)'
  g.beginPath(); g.arc(c, c, c - 9, 0, Math.PI * 2); g.stroke()
  g.lineWidth = 7; g.strokeStyle = color
  g.beginPath(); g.arc(c, c, c - 9, 0, Math.PI * 2); g.stroke()
  g.fillStyle = color
  g.beginPath(); g.arc(c, c, 4, 0, Math.PI * 2); g.fill()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
