// The crowd view's scene (src/app/gear/CrowdView.svelte): many units of a dynamic character side by side, each dressed
// as the pick engine dressed it, the clip on stage playing on all of them a little out of step. Cheap by sharing:
//
// - One template body is loaded and every piece a unit needs is worn on it once (garments.ts wear: its weights computed
//   once, a piece at a time while the page is idle); a unit wears the template's geometry bound to its own skeleton.
// - A unit is a SkeletonUtils clone of the bare template (its own bones, the body's geometry shared), with its own
//   materials (its skin, its hair tint) and its own index on the body per set: the regions its set hides, worked out
//   once per set on the template (hideBodyUnder) and shared by every unit wearing that set.
// - The female shape is a morph: a piece's female field is added once to the shared geometry and turned on per mesh.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import type { Gear } from '../model/types.ts'
import { CharacterView } from './CharacterView.ts'
import { FEMALE } from './folk.ts'
import { shapeFemale, showSkin, tint } from './folkview.ts'
import { hideBodyUnder, takeOffAll, wear, type Worn } from './garments.ts'
import { light, place, tone } from './lighting.ts'
import { mark } from './perf.ts'

/** How one unit looks: what the pick engine drew for it, as files. */
export interface UnitLook {
  uid: number
  /** Its set's id (the body's hidden regions are per set), null for none. */
  set: string | null
  /** The set's pieces and its hair and beard, each with its model's URL. */
  pieces: Array<{ gear: Gear, url: string }>
  skin: string | null
  clothes: string | null
  long: boolean
  /** The skin's hair colour: its hair and beard pieces are tinted to it. */
  hair: string | null
  female: boolean
}

interface Unit {
  look: UnitLook
  root: THREE.Object3D
  body: THREE.SkinnedMesh[]
  gear: THREE.Object3D[]
  mixer: THREE.AnimationMixer | null
  /** Where it stands, for picking it. */
  hit: THREE.Mesh
  /** Which of its pieces it wears already (the rest come as the template gets them). */
  worn: Set<string>
  /** Its body's index is its set's (false: still the whole body). */
  hidden: boolean
}

const idle = (fn: () => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 1000 })
  else setTimeout(fn, 16)
}

export class Crowd {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.01, 200)
  private readonly controls: OrbitControls
  private readonly clock = new THREE.Clock()
  private readonly rig: ReturnType<typeof light>
  private frame = 0
  private template: CharacterView | null = null
  /** The template before anything was worn on it: what units are cloned from. */
  private bare: THREE.Object3D | null = null
  private bodyUrl: string | null = null
  private readonly pieces = new Map<string, Worn | null>()
  private readonly wanted = new Map<string, { gear: Gear, url: string }>()
  /** Per set: each body mesh's geometry with the set's regions hidden (the whole body for no set). */
  private readonly bodies = new Map<string, THREE.BufferGeometry[]>()
  private units: Unit[] = []
  private clip: THREE.AnimationClip | null = null
  private wearing = false
  private disposed = false
  private readonly hitMaterial = new THREE.MeshBasicMaterial({ visible: false })
  private readonly hitGeometry = new THREE.BoxGeometry(1, 1, 1)
  private readonly ray = new THREE.Raycaster()

  constructor (canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    tone(this.renderer)
    this.scene.background = new THREE.Color(0x14171e)
    this.rig = light(this.scene, this.renderer)
    const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshStandardMaterial({ color: 0x1d212b, roughness: 1 }))
    ground.rotation.x = -Math.PI / 2
    this.scene.add(ground)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    const tick = (): void => {
      if (this.disposed) return
      this.frame = requestAnimationFrame(tick)
      const dt = Math.min(this.clock.getDelta(), 0.1)
      for (const u of this.units) u.mixer?.update(dt)
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    }
    this.frame = requestAnimationFrame(tick)
  }

  resize (width: number, height: number): void {
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / Math.max(height, 1)
    this.camera.updateProjectionMatrix()
  }

  /** The body the crowd is made of (a new one: everything rebuilt). */
  async setBody (url: string): Promise<void> {
    if (this.bodyUrl === url) return
    this.bodyUrl = url
    this.clear()
    const view = await CharacterView.load(url)
    if (this.disposed || this.bodyUrl !== url) { view.dispose(); return }
    this.template = view
    this.bare = cloneSkeleton(view.root)
    place(this.rig, view.height)
  }

  /** The units shown: kept where their look is the same, made again where it changed. */
  setUnits (looks: UnitLook[]): void {
    const t = this.template
    if (t === null || this.bare === null) return
    const done = mark('crowd.setUnits', String(looks.length))
    const keep = new Map(this.units.map(u => [JSON.stringify(u.look), u]))
    const next: Unit[] = []
    for (const look of looks) {
      const key = JSON.stringify(look)
      const old = keep.get(key)
      if (old !== undefined) { keep.delete(key); next.push(old); continue }
      next.push(this.make(look))
    }
    for (const u of keep.values()) this.drop(u)
    this.units = next
    this.layout()
    for (const look of looks) for (const p of look.pieces) if (!this.pieces.has(p.gear.id)) this.wanted.set(p.gear.id, p)
    this.wearNext()
    done()
  }

  /** The clip every unit plays (null: the rest pose), each a little later in it than the one before. */
  setClip (clip: THREE.AnimationClip | null): void {
    this.clip = clip === null ? null : this.ownClip(clip)
    for (const [i, u] of this.units.entries()) this.play(u, i)
  }

  /** The unit under a point of the canvas (client coordinates), by its index. */
  unitAt (x: number, y: number): number | null {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.ray.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), this.camera)
    const hit = this.ray.intersectObjects(this.units.map(u => u.hit), false)[0]
    return hit === undefined ? null : this.units.findIndex(u => u.hit === hit.object)
  }

  dispose (): void {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.clear()
    this.controls.dispose()
    this.hitGeometry.dispose()
    this.renderer.dispose()
  }

  // ---- units -----------------------------------------------------------------------------------------------------

  private make (look: UnitLook): Unit {
    const root = cloneSkeleton(this.bare!)
    const body: THREE.SkinnedMesh[] = []
    root.traverse(o => {
      const m = o as THREE.SkinnedMesh
      if (m.isSkinnedMesh !== true) return
      // (its own materials: its skin goes on them)
      m.material = Array.isArray(m.material) ? m.material.map(x => x.clone()) : m.material.clone()
      body.push(m)
    })
    const hit = new THREE.Mesh(this.hitGeometry, this.hitMaterial)
    const h = this.template!.height
    hit.scale.set(h * 0.4, h, h * 0.4)
    hit.position.y = h / 2
    root.add(hit)
    const u: Unit = { look, root, body, gear: [], mixer: null, hit, worn: new Set(), hidden: false }
    this.scene.add(root)
    void showSkin(body, look.skin, look.clothes, look.long).catch(() => {})
    this.dress(u)
    return u
  }

  /** Whatever of its look the template has ready put on: pieces, the body cut for its set, the female shape. */
  private dress (u: Unit): void {
    const bones = new Map<string, THREE.Object3D>()
    u.root.traverse(o => { if ((o as THREE.Bone).isBone === true) bones.set(o.name, o) })
    const skeleton = u.body[0]?.skeleton
    let added = false
    for (const p of u.look.pieces) {
      if (u.worn.has(p.gear.id)) continue
      const w = this.pieces.get(p.gear.id)
      if (w === undefined) continue
      u.worn.add(p.gear.id)
      if (w === null) continue
      const meshes: THREE.Object3D[] = []
      if (w.node === null && skeleton !== undefined) {
        for (const m of w.meshes as THREE.SkinnedMesh[]) {
          const copy = new THREE.SkinnedMesh(m.geometry, Array.isArray(m.material) ? m.material.map(x => x.clone()) : m.material.clone())
          copy.frustumCulled = false
          u.body[0].parent?.add(copy)
          copy.bind(skeleton, u.body[0].bindMatrix)
          meshes.push(copy)
        }
      } else {
        // (a piece on a bone: a copy of its frame on the unit's bone of the same name)
        for (const o of w.objects) {
          const bone = bones.get(o.parent?.name ?? '')
          if (bone === undefined) continue
          const copy = o.clone()
          bone.add(copy)
          copy.traverse(x => {
            const m = x as THREE.Mesh
            if (m.isMesh !== true) return
            m.material = Array.isArray(m.material) ? m.material.map(y => y.clone()) : m.material.clone()
            meshes.push(m)
          })
        }
      }
      if (p.gear.role !== undefined) {
        // (their materials are the unit's copies already)
        for (const m of meshes) m.userData.ownTintMaterial = true
        tint(meshes, u.look.hair)
      }
      u.gear.push(...meshes)
      added = true
    }
    if (!u.hidden && u.look.pieces.every(p => u.worn.has(p.gear.id))) {
      const cut = this.bodyFor(u.look)
      if (cut !== null) { for (const [k, m] of u.body.entries()) if (cut[k] !== undefined) m.geometry = cut[k]; u.hidden = true }
    }
    if (added || u.look.female) this.shape(u)
  }

  /** The female shape on the unit's body and pieces (or off). */
  private shape (u: Unit): void {
    for (const o of u.gear) {
      const m = o as THREE.Mesh
      // (the shape another unit added to the shared geometry: this mesh's own switch for it)
      if (m.isMesh === true && m.geometry.userData.femaleShape === true && m.morphTargetDictionary?.[FEMALE] === undefined) {
        m.updateMorphTargets()
        m.morphTargetDictionary = { [FEMALE]: 0 }
      }
    }
    shapeFemale(u.body, u.gear, u.look.female, this.template!.height)
    for (const o of u.gear) {
      const m = o as THREE.Mesh
      if (m.isMesh === true && m.morphTargetDictionary?.[FEMALE] !== undefined) m.geometry.userData.femaleShape = true
    }
  }

  /** Each body mesh's geometry with the set's regions hidden: worked out on the template once per set. Null until every
   * piece of the set is on the template. */
  private bodyFor (look: UnitLook): THREE.BufferGeometry[] | null {
    const key = look.set ?? ''
    const known = this.bodies.get(key)
    if (known !== undefined) return known
    const t = this.template!
    const set = look.pieces.filter(p => p.gear.role === undefined).map(p => this.pieces.get(p.gear.id))
    if (set.some(w => w === undefined)) return null
    const done = mark('crowd.bodyFor', key)
    hideBodyUnder(t, set.filter((w): w is Worn => w !== null && w !== undefined))
    const out = t.bodySkinned.map(m => {
      const g = new THREE.BufferGeometry()
      for (const [name, a] of Object.entries(m.geometry.attributes)) g.setAttribute(name, a)
      g.morphAttributes = m.geometry.morphAttributes
      g.morphTargetsRelative = m.geometry.morphTargetsRelative
      if (m.geometry.index !== null) g.setIndex(m.geometry.index.clone())
      for (const gr of m.geometry.groups) g.addGroup(gr.start, gr.count, gr.materialIndex)
      g.boundingSphere = m.geometry.boundingSphere
      g.boundingBox = m.geometry.boundingBox
      return g
    })
    hideBodyUnder(t, [])
    this.bodies.set(key, out)
    done()
    return out
  }

  private play (u: Unit, i: number): void {
    u.mixer?.stopAllAction()
    u.mixer = null
    if (this.clip === null) {
      for (const b of u.body) b.skeleton.pose()
      return
    }
    u.mixer = new THREE.AnimationMixer(u.root)
    const action = u.mixer.clipAction(this.clip)
    action.play()
    // (out of step: each unit a share of the clip on from the one before, never in time with its neighbour)
    action.time = ((i * 0.618034) % 1) * this.clip.duration
  }

  /** The clip with only the unit's bones' tracks, and the hips kept over its spot (a walk plays in place). */
  private ownClip (clip: THREE.AnimationClip): THREE.AnimationClip {
    const names = new Set<string>()
    this.bare?.traverse(o => { if ((o as THREE.Bone).isBone === true) names.add(o.name) })
    const hips = [...names].find(n => /hips$/i.test(n)) ?? null
    const tracks = clip.tracks.filter(t => names.has(t.name.slice(0, t.name.lastIndexOf('.')))).map(t => {
      if (hips === null || t.name !== `${hips}.position`) return t
      const copy = t.clone()
      const v = copy.values
      for (let k = 0; k + 2 < v.length; k += 3) { v[k] = v[0]; v[k + 2] = v[2] }
      return copy
    })
    return new THREE.AnimationClip(clip.name, clip.duration, tracks)
  }

  private layout (): void {
    const t = this.template
    if (t === null) return
    const n = this.units.length
    const perRow = n <= 8 ? n : n <= 12 ? 6 : 8
    const gap = t.height * 0.55
    const rows = Math.ceil(n / Math.max(perRow, 1))
    for (const [i, u] of this.units.entries()) {
      const row = Math.floor(i / perRow)
      const col = i % perRow
      const inRow = Math.min(perRow, n - row * perRow)
      u.root.position.set((col - (inRow - 1) / 2) * gap + (row % 2) * gap * 0.25, 0, -row * gap * 1.1)
      this.play(u, i)
    }
    const width = perRow * gap
    const depth = rows * gap * 1.1
    const target = new THREE.Vector3(0, t.height * 0.5, -depth / 2 + gap * 0.5)
    const fit = Math.max(width / this.camera.aspect, t.height * 1.3) / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    this.camera.position.set(0, t.height * 0.9, target.z + fit + depth * 0.4)
    this.camera.near = 0.05
    this.camera.far = fit * 10 + depth
    this.camera.updateProjectionMatrix()
    this.controls.target.copy(target)
    this.controls.update()
  }

  /** The next piece some unit needs worn on the template, while idle; units dressed as they come. */
  private wearNext (): void {
    if (this.wearing || this.disposed) return
    const next = this.wanted.values().next().value as { gear: Gear, url: string } | undefined
    if (next === undefined || this.template === null) return
    this.wearing = true
    idle(() => {
      const t = this.template
      this.wanted.delete(next.gear.id)
      if (t === null || this.disposed) { this.wearing = false; return }
      void wear(t, next.gear, { url: next.url, place: next.gear.attach.place, owner: this })
        .catch(() => null)
        .then(w => {
          this.pieces.set(next.gear.id, w)
          this.wearing = false
          if (this.disposed || this.template !== t) return
          for (const u of this.units) if (u.look.pieces.some(p => p.gear.id === next.gear.id)) this.dress(u)
          this.wearNext()
        })
    })
  }

  private drop (u: Unit): void {
    u.mixer?.stopAllAction()
    u.root.removeFromParent()
    u.root.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh !== true || m === u.hit) return
      for (const x of Array.isArray(m.material) ? m.material : [m.material]) x.dispose()
    })
  }

  private clear (): void {
    for (const u of this.units) this.drop(u)
    this.units = []
    this.wanted.clear()
    for (const list of this.bodies.values()) for (const g of list) g.dispose()
    this.bodies.clear()
    this.pieces.clear()
    const t = this.template
    this.template = null
    this.bare = null
    if (t !== null) {
      takeOffAll(t, this)
      void showSkin(t.bodySkinned, null).catch(() => {}).then(() => { t.dispose() })
    }
  }
}
