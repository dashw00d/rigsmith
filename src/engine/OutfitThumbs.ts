// The Wardrobe's pictures (src/app/gear/thumbs.svelte.ts asks for them): a dynamic character's body in its rest pose
// wearing a set's pieces, a skin, clothes or a hair or beard piece, or one piece alone, drawn on the shared offscreen
// renderer (src/engine/offscreen.ts) with the viewport's lighting. In the rest pose a piece sits where its placement
// puts it, so every piece is worn as the fitting gizmo shows it (garments.ts wear, `fitting`): unbound, no weights
// computed, nothing hidden; a few milliseconds a piece. The body stays loaded between pictures of the same file.
import * as THREE from 'three'
import type { Gear, Placement } from '../model/types.ts'
import { CharacterView } from './CharacterView.ts'
import { showSkin, tint } from './folkview.ts'
import { takeOff, wear, type Worn } from './garments.ts'
import { light } from './lighting.ts'
import { encode, grab, offscreen } from './offscreen.ts'
import { mark } from './perf.ts'

export const THUMB_SIZE = 160

export type Framing = 'body' | 'head' | 'torso' | 'piece'

export interface ThumbPiece { gear: Gear, url: string, place: Placement }

export interface ThumbSpec {
  /** The body's file. */
  body: string
  pieces: ThumbPiece[]
  /** A skin's image (null: the body's own texture), clothes' image over it. */
  skin?: string | null
  clothes?: string | null
  long?: boolean
  /** The hair colour the hair and beard pieces are tinted to (#rrggbb). */
  hair?: string | null
  framing: Framing
}

/** A body let go: its own textures back first (a skin's texture is folkview's, shared: not the view's to dispose). */
async function release (view: CharacterView): Promise<void> {
  await showSkin(view.bodySkinned, null).catch(() => {})
  view.dispose()
}

export class OutfitThumbs {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(24, 1, 0.01, 100)
  private lit = false
  private body: { url: string, view: Promise<CharacterView> } | null = null

  private async viewOf (url: string): Promise<CharacterView> {
    if (this.body?.url !== url) {
      const old = this.body
      this.body = { url, view: CharacterView.load(url) }
      void old?.view.then(release, () => {})
    }
    return await this.body.view
  }

  /** A WebP picture of the spec. */
  async render (spec: ThumbSpec): Promise<Blob> {
    const view = await this.viewOf(spec.body)
    const done = mark('OutfitThumbs.render', spec.framing)
    const worn: Worn[] = []
    try {
      for (const p of spec.pieces) {
        const w = await wear(view, p.gear, { url: p.url, place: p.place, fitting: p.gear.attach.kind !== 'bone', owner: this })
        if (w !== null) worn.push(w)
      }
      const meshes = worn.flatMap(w => w.meshes)
      if (spec.hair !== undefined) {
        const hairy = worn.filter(w => spec.pieces.find(p => p.gear.id === w.gear)?.gear.role !== undefined).flatMap(w => w.meshes)
        // (their materials are copies already: wear copies them)
        for (const m of hairy) m.userData.ownTintMaterial = true
        tint(hairy, spec.hair ?? null)
      }
      await showSkin(view.bodySkinned, spec.skin ?? null, spec.clothes ?? null, spec.long === true)
      const alone = spec.framing === 'piece'
      for (const m of view.meshes) m.visible = !alone
      view.root.updateMatrixWorld(true)
      this.aim(view, alone ? meshes : null, spec.framing)
      const picture = await offscreen(THUMB_SIZE, THUMB_SIZE, renderer => {
        if (!this.lit) { light(this.scene, renderer); this.lit = true }
        this.scene.add(view.root)
        try {
          renderer.render(this.scene, this.camera)
          return grab(renderer)
        } finally {
          this.scene.remove(view.root)
        }
      })
      return await encode(picture, 'image/webp', 0.85)
    } finally {
      for (const w of worn) takeOff(view, w, this)
      for (const m of view.meshes) m.visible = true
      done()
    }
  }

  /** The camera on the framing: the whole body, the head, the torso, or the pieces alone. */
  private aim (view: CharacterView, alone: THREE.Object3D[] | null, framing: Framing): void {
    const box = new THREE.Box3()
    if (alone !== null && alone.length > 0) for (const m of alone) box.expandByObject(m)
    else box.copy(view.box)
    const h = view.height
    if (framing === 'head') { box.min.y = view.box.max.y - h * 0.2; box.max.y = view.box.max.y + h * 0.01; const cx = (view.box.min.x + view.box.max.x) / 2; box.min.x = cx - h * 0.12; box.max.x = cx + h * 0.12 }
    if (framing === 'torso') { box.min.y = view.box.min.y + h * 0.4; box.max.y = view.box.max.y - h * 0.12; const cx = (view.box.min.x + view.box.max.x) / 2; box.min.x = cx - h * 0.2; box.max.x = cx + h * 0.2 }
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const extent = Math.max(size.y, size.x * 0.9, size.z * 0.9, 1e-3) * 1.1
    const distance = extent / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const direction = new THREE.Vector3(0.35, 0.1, 1).normalize()
    this.camera.position.copy(center).addScaledVector(direction, distance + size.z / 2)
    this.camera.lookAt(center)
    this.camera.near = distance * 0.05
    this.camera.far = distance * 4 + size.z
    this.camera.updateProjectionMatrix()
  }

  /** Let the body go. */
  dispose (): void {
    void this.body?.view.then(release, () => {})
    this.body = null
  }
}
