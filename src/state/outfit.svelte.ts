// Props in the viewport: attaching the selected character's props, selection, and the gizmo.
import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { api, fileUrl, type Garment, type Mount } from './api.ts'
import { app } from './app.svelte.ts'
import { CharacterView } from '../engine/CharacterView.ts'
import { attachGarments, GARMENT_FLAG, garmentMatrix, restFrame } from '../engine/garments.ts'
import { riderScale, straddle } from '../engine/mount.ts'
import { animator } from './animator.svelte.ts'
import { paint } from './paint.svelte.ts'
import {
  applyOffset, attachProps, CATALOG, defaultPlacement, defaultScale, gripFrame, readOffset, type PropAttachment, type Socket,
} from '../engine/props.ts'
import { strandNear, type PullSocket } from '../engine/pulls.ts'
import type { Stage } from '../engine/Stage.ts'

export type GizmoMode = 'translate' | 'rotate' | 'scale'

class Outfit {
  selected = $state<string | null>(null)
  /** Garment being fitted, with the gizmo: a rigid one on its bone (move it at any pose or frame), a clothing one shown
   * unbound until it is bound again. */
  fitting = $state<string | null>(null)
  /** The accessory whose settings are open (stays when a clothing piece is bound again: to paint it, or pin a part). */
  focus = $state<string | null>(null)
  /** Picking a part's spot on the body: the next click on the body sets it. */
  picking = $state<string | null>(null)
  mode = $state<GizmoMode>('translate')
  busy = $state(false)
  /** What the gizmo moves for a rider: his seat on the horse ('seat'), or one of his held bones ('bone:<name>'). */
  mountTarget = $state<string | null>(null)
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
        // (hold the frame while a piece is moved on a playing clip; the clip lets go of the props meanwhile)
        if ((e as unknown as { value: boolean }).value && animator.playing) animator.setPlaying(false)
        animator.holding = (e as unknown as { value: boolean }).value
        if (!(e as unknown as { value: boolean }).value) {
          if (this.mountTarget !== null) void this.commitMount()
          else if (this.fitting !== null) this.commitFit()
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
    // (a garment's sockets aren't seen: changing them attaches nothing again)
    const garmentKey = JSON.stringify([this.garments.map(g => ({ ...g, sockets: undefined })), fitting])
    if (garmentKey !== this.appliedGarments) {
      this.appliedGarments = garmentKey
      const token = ++this.garmentToken
      const character = app.selected
      if (character !== null) {
        this.busy = this.garments.some(g => g.status === 'ready' && g.id !== fitting)
        try {
          const objects = await attachGarments(view, this.garments, g => fileUrl(character, g.file) ?? '', fitting)
          if (token === this.garmentToken) {
            this.garmentObjects = objects
            // (a garment being painted is a new mesh now: paint on it)
            paint.rebuild()
            // (the clip playing carries the props' placements: play it again with these)
            if (animator.current !== null) void animator.refresh(true)
          }
        } finally {
          if (token === this.garmentToken) this.busy = false
        }
      }
    }
    this.updateGizmo(showGizmo)
  }

  private updateGizmo (show: boolean): void {
    if (this.gizmo === null) return
    const object = this.mountTarget !== null ? this.mountObject() ?? undefined
      : this.fitting !== null ? this.garmentObjects.get(this.fitting) : this.selected === null ? undefined : this.objects.get(this.selected)
    if (!show || object === undefined) {
      this.gizmo.detach()
      return
    }
    if (this.gizmo.object !== object) this.gizmo.attach(object)
    this.gizmo.setMode(this.mountTarget !== null && this.mountTarget !== 'seat' && this.mountTarget !== 'bone:Hips' ? 'rotate' : this.mode)
    this.gizmo.setSpace(this.fitting !== null || this.mountTarget === 'seat' ? 'world' : 'local')
  }

  // ---- riding --------------------------------------------------------------------------------------------------

  private mountObject (): THREE.Object3D | null {
    const t = this.mountTarget
    if (t === null || this.stage === null) return null
    if (t === 'seat') return this.stage.scene.getObjectByName('mount_seat') ?? null
    return t.startsWith('bone:') ? this.view?.bones.get(t.slice(5)) ?? null : null
  }

  aim (target: string | null): void {
    this.mountTarget = target
    if (target !== null) { this.fitting = null; this.selected = null }
    this.updateGizmo(app.step === 'outfit')
  }

  async patchMount (change: Partial<Mount>): Promise<void> {
    const c = app.selected
    if (c === null || c.mount === undefined) return
    await app.update(c.id, { mount: { ...c.mount, ...change } })
    void animator.refresh(true)
    if (animator.current === null) animator.stop()   // (at rest: seated again, as changed)
  }

  /** Ride `horseId` (a new seat worked out from the two bodies: src/engine/mount.ts straddle), or stop riding (null). */
  async setMount (horseId: string | null): Promise<void> {
    const c = app.selected
    if (c === null) return
    this.mountTarget = null
    if (horseId === null) { await app.update(c.id, { mount: null as unknown as undefined }); return }
    const horse = app.characters.find(x => x.id === horseId)
    const url = horse === undefined ? null : fileUrl(horse, horse.files.rigged)
    if (url === null || this.view === null) return
    const hv = await CharacterView.load(url)
    const heights = await fetch(`/api/characters/${c.id}/game`).then(async x => (x.ok ? await x.json() : null) as { height: number | null, companion?: { height: number | null } } | null).catch(() => null)
    const k = riderScale({}, { game: heights?.height ?? null, own: this.view.height }, { game: heights?.companion?.height ?? null, own: hv.height })
    // (seated again on the same horse: its look for him, its gear and skin, kept)
    const kept = c.mount?.character === horseId ? { gear: c.mount.gear, skin: c.mount.skin } : {}
    const mount: Mount = { character: horseId, rotation: [0, 0, 0], ...straddle(hv, this.view, k), ...kept }
    await app.update(c.id, { mount })
  }

  /** His held bones as they stand now (a seated clip paused on the right frame): the seat's new pose. */
  async takeSeatPose (): Promise<void> {
    const m = app.selected?.mount
    if (m === undefined || this.view === null) return
    const pose: Record<string, [number, number, number, number]> = {}
    for (const b of m.freeze) {
      const o = this.view.bones.get(b)
      if (o !== undefined) pose[b] = o.quaternion.toArray().map(v => Math.round(v * 1e6) / 1e6) as [number, number, number, number]
    }
    const h = this.view.bones.get('Hips')
    await this.patchMount({ pose, hips: h === undefined ? m.hips : h.position.toArray().map(v => Math.round(v * 1e5) / 1e5) as [number, number, number] })
  }

  private async commitMount (): Promise<void> {
    const t = this.mountTarget
    const m = app.selected?.mount
    const object = this.mountObject()
    if (t === null || m === undefined || object === null) return
    const r = (v: number): number => Math.round(v * 10000) / 10000
    if (t === 'seat') {
      const e = new THREE.Euler().setFromQuaternion(object.quaternion)
      await this.patchMount({
        position: [r(object.position.x), r(object.position.y), r(object.position.z)],
        rotation: [e.x, e.y, e.z].map(v => Math.round(THREE.MathUtils.radToDeg(v) * 10) / 10) as [number, number, number],
      })
      return
    }
    const bone = t.slice(5)
    const pose = { ...m.pose, [bone]: object.quaternion.toArray().map(v => Math.round(v * 1e6) / 1e6) as [number, number, number, number] }
    await this.patchMount(bone === 'Hips' ? { pose, hips: object.position.toArray().map(v => Math.round(v * 1e5) / 1e5) as [number, number, number] } : { pose })
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
    if (id !== null) this.focus = id
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

  async upload (file: File, kind: 'prop' | 'clothing' | 'part' = 'clothing'): Promise<void> {
    const c = app.selected
    if (c === null) return
    try {
      app.upsert(await api.uploadGarment(c.id, file, kind))
    } catch (error) {
      app.toast('error', (error as Error).message)
    }
  }

  /** Put a rigid garment on another bone. Given to the other hand (or foot, arm...) while it sits by this one, it moves
   * into that hand held the same way: turned over its own plane of symmetry (an axe's blade, a pick's head: its
   * thinnest axis) and across the body's middle, which together are a plain turn, so the mesh stays as it is. Any
   * other bone carries it from where it sits at rest. */
  async setBone (id: string, bone: string): Promise<void> {
    const g = this.garments.find(x => x.id === id)
    const view = this.view
    const node = this.garmentObjects.get(id)
    const to = view !== null ? restFrame(view, bone) : null
    const counterpart = /^Left/.test(bone) ? bone.replace(/^Left/, 'Right') : /^Right/.test(bone) ? bone.replace(/^Right/, 'Left') : null
    if (g === undefined || g.mode !== 'rigid' || view === null || node === undefined || to === null || counterpart === null || counterpart !== g.bone) {
      await this.patchGarment(id, { bone })
      return
    }
    const at = new THREE.Vector3().setFromMatrixPosition(to)
    const here = new THREE.Vector3(...g.position)
    if (here.distanceTo(at.clone().setX(-at.x)) >= here.distanceTo(at)) {   // (already on that side)
      await this.patchGarment(id, { bone })
      return
    }
    // its vertices at rest (rest space), their middle and thinnest axis
    const place = garmentMatrix(g)
    const pts: THREE.Vector3[] = []
    node.updateMatrixWorld(true)
    node.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh !== true) return
      const pos = m.geometry.attributes.position
      const local = new THREE.Matrix4().copy(node.matrixWorld).invert().multiply(m.matrixWorld)
      for (let i = 0; i < pos.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(local).applyMatrix4(place))
    })
    if (pts.length < 3) { await this.patchGarment(id, { bone }); return }
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length)
    const n = thinnestAxis(pts, c)
    // T = mirror across x = 0 after the reflection over its own plane (through c, normal n): a proper turn
    const reflect = new THREE.Matrix4().set(
      1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, 0,
      -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z, 0,
      -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z, 0,
      0, 0, 0, 1)
    const S = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(reflect).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
    const T = new THREE.Matrix4().makeScale(-1, 1, 1).multiply(S)
    const moved = T.multiply(place)
    const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const sc = new THREE.Vector3()
    moved.decompose(p, q, sc)
    const r = (v: number): number => Math.round(v * 10000) / 10000
    const e = new THREE.Euler().setFromQuaternion(q)
    await this.patchGarment(id, {
      bone,
      position: [r(p.x), r(p.y), r(p.z)],
      rotation: [e.x, e.y, e.z].map(v => Math.round(THREE.MathUtils.radToDeg(v) * 10) / 10) as [number, number, number],
      scale: r(Math.abs(sc.x)),
    })
  }

  async patchGarment (id: string, change: Partial<Garment>): Promise<void> {
    const c = app.selected
    if (c === null) return
    await app.update(c.id, { garments: this.garments.map(g => (g.id === id ? { ...g, ...change } : g)) })
  }

  /** Show or switch off an accessory. Shown in a switch set, the others of its set are switched off. */
  async setShown (id: string, shown: boolean): Promise<void> {
    const c = app.selected
    const g = this.garments.find(x => x.id === id)
    if (c === null || g === undefined) return
    const set = g.group?.trim() ?? ''
    await app.update(c.id, {
      garments: this.garments.map(x => x.id === id ? { ...x, hidden: !shown }
        : shown && set !== '' && (x.group?.trim() ?? '') === set ? { ...x, hidden: true } : x),
    })
  }

  /** The switch sets there are, by name. */
  get groups (): string[] {
    return [...new Set(this.garments.map(g => g.group?.trim() ?? '').filter(x => x !== ''))].sort()
  }

  /** Pin a part to the spot on the body clicked next (its rest position: the same skin whatever the pose). */
  pickSpot (id: string | null): void {
    this.picking = id
    const stage = this.stage
    const view = this.view
    if (id === null || stage === null || view === null) return
    const canvas = stage.renderer.domElement
    const ray = new THREE.Raycaster()
    const down = (e: PointerEvent): void => {
      if (e.button !== 0) return
      const r = canvas.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2), stage.camera)
      const body = view.skinned.filter(m => m.userData[GARMENT_FLAG] === undefined)
      for (const m of body) m.computeBoundingSphere()
      const hit = ray.intersectObjects(body, false)[0]
      if (hit === undefined || hit.face === undefined || hit.face === null) return   // (off the body: the camera turns)
      e.stopPropagation(); e.preventDefault()
      canvas.removeEventListener('pointerdown', down, { capture: true })
      const mesh = hit.object as THREE.SkinnedMesh
      // where on the triangle as it stands, then that point of it at rest
      const corners = [hit.face.a, hit.face.b, hit.face.c]
      const posed = corners.map(v => mesh.getVertexPosition(v, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld))
      const bary = THREE.Triangle.getBarycoord(hit.point, posed[0], posed[1], posed[2], new THREE.Vector3()) ?? new THREE.Vector3(1 / 3, 1 / 3, 1 / 3)
      const pos = mesh.geometry.attributes.position
      const rest = corners.map(v => new THREE.Vector3().fromBufferAttribute(pos, v).applyMatrix4(mesh.bindMatrix))
      const at = rest[0].multiplyScalar(bary.x).addScaledVector(rest[1], bary.y).addScaledVector(rest[2], bary.z)
      this.picking = null
      const r4 = (v: number): number => Math.round(v * 1e4) / 1e4
      void this.patchGarment(id, { anchor: [r4(at.x), r4(at.y), r4(at.z)] })
    }
    canvas.addEventListener('pointerdown', down, { capture: true })
    this.stopPicking = () => { canvas.removeEventListener('pointerdown', down, { capture: true }); this.picking = null }
  }
  stopPicking: () => void = () => { this.picking = null }

  // ---- pulls (a prop's points another bone draws: a bowstring) -------------------------------------------------

  /** Add a pull to a prop: drawn by `bone` (its grip: the socket's, where a hand closes); resting on the prop's
   * longest thinnest piece (a bowstring), at its middle. */
  async addPull (id: string, bone = 'RightHand'): Promise<void> {
    const g = this.garments.find(x => x.id === id)
    const node = this.garmentObjects.get(id)
    const view = this.view
    if (g === undefined || node === undefined || view === null) return
    const meshes: THREE.Mesh[] = []
    node.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })
    const rest = strandMiddle(meshes) ?? new THREE.Vector3()
    const grip = gripFrame(view, bone as Socket)?.anchor ?? new THREE.Vector3()
    const r4 = (v: number): number => Math.round(v * 1e5) / 1e5
    const pull: PullSocket = {
      id: Math.random().toString(36).slice(2, 10), name: (g.pulls ?? []).length === 0 ? 'Draw' : `Pull ${(g.pulls ?? []).length + 1}`,
      bone, grip: [r4(grip.x), r4(grip.y), r4(grip.z)], rest: [r4(rest.x), r4(rest.y), r4(rest.z)], holds: {},
    }
    await this.patchGarment(id, { pulls: [...(g.pulls ?? []), pull] })
  }

  /** Where `bone` holds things (a hand's grip socket; any other bone: the bone itself), in its rest frame. */
  gripOf (bone: string): [number, number, number] {
    const view = this.view
    const grip = view === null ? null : gripFrame(view, bone as Socket)?.anchor ?? null
    const r5 = (v: number): number => Math.round(v * 1e5) / 1e5
    return grip === null ? [0, 0, 0] : [r5(grip.x), r5(grip.y), r5(grip.z)]
  }

  async patchPull (id: string, pullId: string, change: Partial<PullSocket>): Promise<void> {
    const g = this.garments.find(x => x.id === id)
    if (g === undefined) return
    await this.patchGarment(id, { pulls: (g.pulls ?? []).map(p => (p.id === pullId ? { ...p, ...change } : p)) })
  }

  async removePull (id: string, pullId: string): Promise<void> {
    const g = this.garments.find(x => x.id === id)
    if (g === undefined) return
    const pulls = (g.pulls ?? []).filter(p => p.id !== pullId)
    await this.patchGarment(id, { pulls: pulls.length > 0 ? pulls : undefined })
  }

  /** Set a pull's point on its prop: the next click on the prop (the camera turns off it). */
  pickPullPoint (id: string, pullId: string): void {
    const stage = this.stage
    const node = this.garmentObjects.get(id)
    if (stage === null || node === undefined) return
    this.picking = `${id}:${pullId}`
    const canvas = stage.renderer.domElement
    const ray = new THREE.Raycaster()
    const down = (e: PointerEvent): void => {
      if (e.button !== 0) return
      const r = canvas.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2), stage.camera)
      const meshes: THREE.Mesh[] = []
      node.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })
      for (const m of meshes) if ((m as THREE.SkinnedMesh).isSkinnedMesh) (m as THREE.SkinnedMesh).computeBoundingSphere()
      const hit = ray.intersectObjects(meshes, false)[0]
      if (hit === undefined) return
      e.stopPropagation(); e.preventDefault()
      canvas.removeEventListener('pointerdown', down, { capture: true })
      this.picking = null
      // (in the prop's own space: where it is on the prop, wherever the prop is)
      const at = node.worldToLocal(hit.point.clone())
      const r5 = (v: number): number => Math.round(v * 1e5) / 1e5
      void this.patchPull(id, pullId, { rest: [r5(at.x), r5(at.y), r5(at.z)] })
    }
    canvas.addEventListener('pointerdown', down, { capture: true })
    this.stopPicking = () => { canvas.removeEventListener('pointerdown', down, { capture: true }); this.picking = null }
  }

  /** When a clip holds a pull, found by playing it: from when its bone's grip first comes to the strand the pull
   * rests on (anywhere along it: a hand nocks by the bow's grip, then draws), until the clip's release (its blow
   * script, if that comes after) or until the grip goes past a full draw (most of the strand's length away). */
  async findHolds (id: string, pullId: string, entryIndex: number): Promise<Array<[number, number]>> {
    const c = app.selected
    const g = this.garments.find(x => x.id === id)
    const pull = g?.pulls?.find(p => p.id === pullId)
    const node = this.garmentObjects.get(id)
    const view = this.view
    const entry = c?.animations[entryIndex]
    if (c === null || g === undefined || pull === undefined || node === undefined || view === null || entry === undefined) return []
    animator.playEntry(entry, entryIndex)
    for (let i = 0; i < 100 && (animator.current?.entry !== entryIndex || animator.duration === 0); i++) await new Promise(r => setTimeout(r, 50))
    animator.setPlaying(false)
    const hand = view.bones.get(pull.bone)
    const strand = strandSegment(node, pull)
    if (hand === undefined || strand === null || animator.duration === 0) return []
    const reach = view.height * 0.03
    const samples = 120
    const dist: number[] = []
    const grip = new THREE.Vector3(); const on = new THREE.Vector3()
    for (let i = 0; i <= samples; i++) {
      animator.seek(animator.duration * i / samples)
      view.root.updateMatrixWorld(true)
      grip.set(...pull.grip).applyMatrix4(hand.matrixWorld).applyMatrix4(node.matrixWorld.clone().invert())
      dist.push(grip.distanceTo(strand.closestPointToPoint(grip, true, on)))
    }
    animator.seek(0)
    const start = dist.findIndex(d => d <= reach)
    if (start < 0) return []
    const blow = (c.scripts ?? []).find(s => s.kind === 'blow' && s.enabled && s.clip === entry.name) as { at: number } | undefined
    let end = start
    if (blow !== undefined && blow.at > start / samples) end = Math.round(blow.at * samples)
    else while (end + 1 <= samples && dist[end + 1] <= strand.distance() * 0.6) end++
    const holds: Array<[number, number]> = [[+(start / samples).toFixed(3), +(end / samples).toFixed(3)]]
    await this.patchPull(id, pullId, { holds: { ...(pull.holds ?? {}), [entry.name]: holds } })
    return holds
  }

  async removeGarment (id: string): Promise<void> {
    const c = app.selected
    if (c === null) return
    if (this.focus === id) this.focus = null
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

/** The direction a cloud of points is thinnest in (the smallest principal axis about its middle `c`): Jacobi on the
 * 3 x 3 covariance. */
function thinnestAxis (pts: THREE.Vector3[], c: THREE.Vector3): THREE.Vector3 {
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const p of pts) {
    const d = [p.x - c.x, p.y - c.y, p.z - c.z]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i][j] += d[i] * d[j]
  }
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let sweep = 0; sweep < 50; sweep++) {
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[i][j]) < 1e-12) continue
      const theta = (a[j][j] - a[i][i]) / (2 * a[i][j])
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const cs = 1 / Math.sqrt(t * t + 1); const sn = t * cs
      for (let k = 0; k < 3; k++) {
        const aik = a[i][k]; const ajk = a[j][k]
        a[i][k] = cs * aik - sn * ajk; a[j][k] = sn * aik + cs * ajk
      }
      for (let k = 0; k < 3; k++) {
        const aki = a[k][i]; const akj = a[k][j]
        a[k][i] = cs * aki - sn * akj; a[k][j] = sn * aki + cs * akj
      }
      for (let k = 0; k < 3; k++) {
        const vki = v[k][i]; const vkj = v[k][j]
        v[k][i] = cs * vki - sn * vkj; v[k][j] = sn * vki + cs * vkj
      }
    }
  }
  const k = [0, 1, 2].reduce((best, i) => (a[i][i] < a[best][best] ? i : best), 0)
  return new THREE.Vector3(v[0][k], v[1][k], v[2][k]).normalize()
}

/** The middle of a prop's longest thinnest piece (a bowstring), in the prop's own space; null without meshes. */
function strandMiddle (meshes: THREE.Mesh[]): THREE.Vector3 | null {
  let best: { score: number, at: THREE.Vector3 } | null = null
  for (const m of meshes) {
    const geometry = m.geometry
    const pos = geometry.attributes.position
    const seen = new Set<number>()
    for (let i = 0; i < pos.count; i++) {
      if (seen.has(i)) continue
      const strand = strandNear(geometry, new THREE.Vector3().fromBufferAttribute(pos, i))
      for (const v of strand.vertices) seen.add(v)
      // thickness: how far its vertices stray from its long axis
      const c = new THREE.Vector3()
      for (const v of strand.vertices) c.add(new THREE.Vector3().fromBufferAttribute(pos, v))
      c.divideScalar(strand.vertices.size)
      let thick = 0
      for (const v of strand.vertices) {
        const d = new THREE.Vector3().fromBufferAttribute(pos, v).sub(c)
        thick = Math.max(thick, d.sub(strand.axis.clone().multiplyScalar(d.dot(strand.axis))).length())
      }
      const score = strand.length / Math.max(thick, 1e-6)
      if (best === null || score > best.score) best = { score, at: c.applyMatrix4(m.matrix) }
    }
  }
  return best?.at ?? null
}

/** The strand a pull rests on, end to end (its prop's own space): what a hand takes hold of, anywhere along it. */
function strandSegment (node: THREE.Object3D, pull: PullSocket): THREE.Line3 | null {
  let mesh: THREE.Mesh | null = null
  node.traverse(o => { if (mesh === null && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh })
  if (mesh === null) return null
  const geometry = (mesh as THREE.Mesh).geometry
  const rest = new THREE.Vector3(...pull.rest)
  const { vertices, axis } = strandNear(geometry, rest)
  const v = new THREE.Vector3()
  let lo = Infinity; let hi = -Infinity
  for (const i of vertices) { const t = v.fromBufferAttribute(geometry.attributes.position, i).sub(rest).dot(axis); lo = Math.min(lo, t); hi = Math.max(hi, t) }
  return new THREE.Line3(rest.clone().addScaledVector(axis, lo), rest.clone().addScaledVector(axis, hi))
}
