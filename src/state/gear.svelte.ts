// Gear on stage and the Gear step's actions. The character's gear is worn on its view as soon as it loads (viewer
// onLoad, before the animator's bakes: a clip's gear tracks need the place nodes), and on its horse when it rides
// (wearing the horse's mount.gear). Each piece is worn on its own (src/engine/garments.ts wear) and only put on again
// when what it is made from changes; a placement change just moves its node. Every change is a command (app.do);
// placing goes through the shared gizmo (gizmo.svelte.ts). Catalog gear still kept in the old props' grip frame
// (attach.legacyFrame, from the migration) is converted to rest space the first time its rig loads.
import * as THREE from 'three'
import { untrack } from 'svelte'
import type { Command } from '../model/command-types.ts'
import { newId } from '../model/ids.ts'
import { gearById, handSide, heightOf, hierarchyOf, slotById } from '../model/select.ts'
import type { Character, Gear, GearAttach, Handle, Placement, Side, Window } from '../model/types.ts'
import type { CharacterView } from '../engine/CharacterView.ts'
import { boneFrame, GARMENT_FLAG, type GarmentEdit, hideBodyUnder, takeOff, takeOffAll, tickMechanisms, wear, type Worn } from '../engine/garments.ts'
import { counterpart, mirroredPlacement, nearerMirror, placementMatrix, placementOf } from '../engine/placement.ts'
import { catalogItem, catalogPlacement, catalogUrl, defaultPlacement, defaultScale, gripPoint, gripToRest } from '../engine/props.ts'
import { findHolds as holdsOf, strandMiddle, strandSegment, tickPulls } from '../engine/pulls.ts'
import { animator } from './animator.svelte.ts'
import { api, fileUrl, type GearKind } from './api.ts'
import { app } from './app.svelte.ts'
import { gizmo } from './gizmo.svelte.ts'
import { hands } from './hands.svelte.ts'
import { paint } from './paint.svelte.ts'
import { viewer } from './viewer.svelte.ts'
import { freeHandleName } from '../app/gear/text.ts'

export type WearKind = GearAttach['kind']

/** Picking on the viewport: a spot piece's spot on the body, or a pull's point on its piece. */
export type Picking = { kind: 'spot', gear: string } | { kind: 'pull', gear: string, handle: string }

/** A piece as worn: what it was made from (`key`), its frame (bone gear, made at once) and what wear() put on. */
interface Piece { key: string, gear: Gear, frame: ReturnType<typeof boneFrame>, worn: Worn | null, placed: string }

/** A character wearing gear on stage: the one selected, or the horse it rides. */
interface Wearer { view: CharacterView, id: string, rider: boolean, pieces: Map<string, Piece> }

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4
const r5 = (v: number): number => Math.round(v * 1e5) / 1e5
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const sleep = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }

class GearState {
  /** The piece open in the panel. */
  selected = $state<string | null>(null)
  /** A skin or spot piece shown unbound while it is placed (bound again when done). */
  fitting = $state<string | null>(null)
  picking = $state.raw<Picking | null>(null)
  /** What the rest pose with the hands closed was shown as ("Rest, fists closed"; null: not shown). */
  private restShown = $state<string | null>(null)
  /** Bumped when a piece goes on or comes off (what the panel can place). */
  worn = $state(0)
  /** Finding a pull's hold windows. */
  finding = $state<string | null>(null)

  private rider: Wearer | null = null
  private horse: Wearer | null = null
  private converted = new Set<string>()
  /** The character last loaded (a reload of the same one keeps the piece open). */
  private lastId: string | null = null
  private offPicking: (() => void) | null = null
  private loading = 0
  private refreshing = false

  /** Start following the viewer (called once, below). */
  start (): void {
    viewer.onLoad((view, c) => this.load(view, c), 10)
    viewer.onSync(() => { this.syncAll() })
    viewer.onMountLoad(() => { this.loadHorse() })
    viewer.onMountUnload(() => { this.unloadHorse() })
    $effect.root(() => {
      // (every copy of the character and of its horse, the optimistic ones too: what is worn follows at once)
      $effect(() => {
        void app.characters
        void paint.active
        untrack(() => { this.syncAll() })
      })
      $effect(() => {
        void app.step; void this.selected; void this.fitting; void this.picking; void paint.active; void this.worn
        untrack(() => { this.updateGizmo() })
      })
      // (leaving the step: nothing half placed or picked is left behind)
      $effect(() => {
        if (app.step === 'gear') return
        untrack(() => {
          if (this.picking !== null) this.stopPicking()
          if (this.fitting !== null) this.fitting = null
        })
      })
      $effect(() => {
        const playing = animator.playing
        if (playing === null || playing.slotId !== null) untrack(() => { this.restShown = null })
      })
    })
  }

  /** The character on stage, as the app has it now. */
  private get character (): Character | null {
    const id = this.rider?.id
    return id === undefined ? null : app.byId(id)
  }

  /** The selected piece's worn node, if it has one to place (the gizmo's target). */
  nodeOf (id: string): THREE.Object3D | null {
    void this.worn
    return this.rider?.pieces.get(id)?.worn?.node ?? null
  }

  /** Whether `id` is worn and loaded on stage. */
  isWorn (id: string): boolean {
    void this.worn
    return this.rider?.pieces.get(id)?.worn != null
  }

  // ---- on stage ------------------------------------------------------------------------------------------------

  private load (view: CharacterView, c: Character): () => void {
    if (this.lastId !== c.id) { this.selected = null; this.fitting = null }
    this.lastId = c.id
    this.stopPicking()
    const rider: Wearer = { view, id: c.id, rider: true, pieces: new Map() }
    this.rider = rider
    if (view.rest !== null) this.convertLegacy(view, c)
    this.sync(rider, c.gear, c)
    const off = viewer.stage?.onFrame(dt => {
      tickMechanisms(dt)
      // (nothing playing: every pull at rest; while a slot plays the animator ticks them)
      if (animator.playing === null) tickPulls(null, 0)
    })
    return () => {
      off?.()
      this.stopPicking()
      for (const p of rider.pieces.values()) gizmo.detach(p.frame?.place ?? p.worn?.node)
      takeOffAll(view)
      rider.pieces.clear()
      if (this.rider === rider) this.rider = null
      this.worn++
    }
  }

  private loadHorse (): void {
    this.unloadHorse()
    const m = viewer.mount
    if (m === null) return
    this.horse = { view: m.view, id: m.character.id, rider: false, pieces: new Map() }
    this.syncHorse()
  }

  private unloadHorse (): void {
    const h = this.horse
    if (h === null) return
    takeOffAll(h.view)
    h.pieces.clear()
    this.horse = null
  }

  private syncAll (): void {
    const c = this.character
    if (this.rider !== null && c !== null) this.sync(this.rider, c.gear, c)
    this.syncHorse()
  }

  /** The horse wears its gear as the rider's mount says: the pieces it names, else its own shown ones. */
  private syncHorse (): void {
    const h = this.horse
    if (h === null) return
    const horse = app.byId(h.id) ?? viewer.mount?.character ?? null
    if (horse === null) return
    const wears = this.character?.mount?.gear
    const on = horse.gear.map(g => (wears === undefined ? g : { ...g, hidden: !wears.includes(g.id) }))
    this.sync(h, on, horse)
  }

  /** What a piece is worn from: null when it isn't shown. A bone piece's placement isn't in it (its node just moves). */
  private keyOf (g: Gear, c: Character, w: Wearer): string | null {
    const url = this.urlOf(c, g)
    const fitting = w.rider && this.fitting === g.id
    if (g.status !== 'ready' || url === null || (g.hidden === true && !fitting)) return null
    const a = g.attach
    // (the painted count while painting it: the painter has its weights on the meshes already)
    const painted = paint.active ? null : g.painted ?? 0
    if (a.kind === 'bone') {
      const pulls = g.handles.filter(h => h.kind === 'pull').map(h => [h.id, h.name, h.pull])
      return JSON.stringify(['bone', g.name, url, a.bone, pulls, pulls.length > 0 ? painted : null])
    }
    return JSON.stringify([a.kind, g.name, url, a, a.kind === 'skin' ? painted : null, fitting])
  }

  /** Where its model loads from (catalog gear: the bundled file). */
  urlOf (c: Character, g: Gear): string | null {
    if (g.catalog !== undefined) return catalogUrl(g.catalog)
    return fileUrl(c, g.model)
  }

  /** Its placement in rest space (catalog gear in the old grip frame converted). */
  placeOf (g: Gear, view: CharacterView | null = this.rider?.view ?? null): Placement {
    const a = g.attach
    if (a.kind === 'bone' && a.legacyFrame === 'grip' && view !== null) return gripToRest(view, a.bone, a.place) ?? a.place
    return a.place
  }

  private sync (w: Wearer, list: Gear[], c: Character): void {
    if (w.view.rest === null) return
    const wanted = new Map<string, { g: Gear, key: string }>()
    for (const g of list) {
      const key = this.keyOf(g, c, w)
      if (key !== null) wanted.set(g.id, { g, key })
    }
    let changed = false
    for (const [id, p] of w.pieces) {
      if (wanted.get(id)?.key === p.key) continue
      this.off(w, p)
      w.pieces.delete(id)
      changed = true
    }
    for (const [id, { g, key }] of wanted) {
      const p = w.pieces.get(id)
      if (p === undefined) { this.on(w, c, g, key); changed = true } else this.move(w, p, g)
    }
    if (changed) { this.worn++; this.refreshAnimator() }
  }

  private on (w: Wearer, c: Character, g: Gear, key: string): void {
    const view = w.view
    const place = this.placeOf(g, view)
    const frame = g.attach.kind === 'bone' ? boneFrame(view, g, g.attach.bone, place) : null
    const piece: Piece = { key, gear: g, frame, worn: null, placed: JSON.stringify(place) }
    w.pieces.set(g.id, piece)
    const fitting = w.rider && this.fitting === g.id
    // (skinning to the body is the slow part: say so)
    const heavy = g.attach.kind !== 'bone' && !fitting
    if (heavy) this.busy(1)
    const url = this.urlOf(c, g)!
    const weights = fileUrl(c, `garments/${g.id}/weights.json`, g.painted ?? 0)
    const edits = async (): Promise<GarmentEdit[]> => {
      if (weights === null) return []
      const res = await fetch(weights)
      return res.ok ? await res.json() as GarmentEdit[] : []
    }
    wear(view, g, { url, place, fitting, edits, frame: frame ?? undefined })
      .then(worn => {
        if (w.pieces.get(g.id) !== piece) { if (worn !== null) takeOff(view, worn); return }
        piece.worn = worn
        if (worn === null) frame?.group.removeFromParent()
        if (g.attach.kind === 'skin') hideBodyUnder(view, this.wornOf(w))
        this.worn++
      })
      .catch((error: unknown) => {
        if (w.pieces.get(g.id) !== piece) return
        frame?.group.removeFromParent()
        app.toast('error', `${g.name} didn't load: ${message(error)}`)
      })
      .finally(() => { if (heavy) this.busy(-1) })
  }

  private off (w: Wearer, p: Piece): void {
    if (w.rider) gizmo.detach(p.worn?.node ?? p.frame?.place)
    // (the painter is on its meshes: they are going)
    if (w.rider && paint.active && p.worn !== null && p.worn.meshes.some(m => (m as THREE.SkinnedMesh).isSkinnedMesh === true)) paint.stop()
    if (p.worn !== null) takeOff(w.view, p.worn)
    else p.frame?.group.removeFromParent()
    if (p.gear.attach.kind === 'skin') hideBodyUnder(w.view, this.wornOf(w))
  }

  /** A bone piece placed elsewhere: its node moves (unless the gizmo is dragging it). */
  private move (w: Wearer, p: Piece, g: Gear): void {
    p.gear = g
    const node = p.frame?.place
    if (node === undefined) return
    const place = this.placeOf(g, w.view)
    const placed = JSON.stringify(place)
    if (placed === p.placed) return
    p.placed = placed
    if (!(gizmo.dragging && gizmo.target === node)) placementMatrix(place).decompose(node.position, node.quaternion, node.scale)
    // (the clip playing carries its placement in its gear tracks: bake it again)
    this.refreshAnimator()
  }

  private wornOf (w: Wearer): Worn[] {
    return [...w.pieces.values()].flatMap(p => (p.worn === null ? [] : [p.worn]))
  }

  private busy (by: number): void {
    this.loading = Math.max(0, this.loading + by)
    app.setBusy('gear', this.loading > 0 ? 'Fitting clothes' : null)
  }

  /** The clip playing baked again (its gear tracks hold placements; new nodes need tracks), once per change burst. */
  private refreshAnimator (): void {
    if (this.refreshing || animator.playing === null) return
    this.refreshing = true
    queueMicrotask(() => {
      this.refreshing = false
      if (animator.playing !== null && !gizmo.dragging) void animator.refresh()
    })
  }

  /** Catalog gear placed in the old grip frame, placed in rest space once its rig is on stage (one entry). */
  private convertLegacy (view: CharacterView, c: Character): void {
    const commands: Command[] = []
    for (const g of c.gear) {
      const a = g.attach
      const seen = `${c.id}/${g.id}`
      if (a.kind !== 'bone' || a.legacyFrame !== 'grip' || this.converted.has(seen)) continue
      const place = gripToRest(view, a.bone, a.place)
      if (place === null) continue
      this.converted.add(seen)
      commands.push({ type: 'gear.place', id: g.id, place })
    }
    if (commands.length > 0) void app.do(c.id, commands)
  }

  // ---- the gizmo -----------------------------------------------------------------------------------------------

  private gizmoOn: THREE.Object3D | null = null

  private updateGizmo (): void {
    const id = this.selected
    const node = app.step === 'gear' && this.picking === null && !paint.active && id !== null ? this.rider?.pieces.get(id)?.worn?.node ?? null : null
    if (node === null) {
      gizmo.detach(this.gizmoOn)
      this.gizmoOn = null
      return
    }
    if (gizmo.target === node) return
    this.gizmoOn = node
    gizmo.attach(node, { space: 'world', onCommit: () => { this.commitPlace(id!, node) } })
  }

  private commitPlace (id: string, node: THREE.Object3D): void {
    const c = this.character
    if (c === null || gearById(c, id) === undefined) return
    void app.do(c.id, { type: 'gear.place', id, place: placementOf(node) })
  }

  // ---- actions -------------------------------------------------------------------------------------------------

  select (id: string | null): void {
    if (id === this.selected) return
    this.stopPicking()
    if (this.fitting !== null && this.fitting !== id) this.fitting = null
    this.selected = id
  }

  /** Show a skin or spot piece unbound to place it (null: bind it again). */
  fit (id: string | null): void {
    this.stopPicking()
    if (id !== null) this.selected = id
    this.fitting = id
  }

  /** A bone the skeleton has to put new gear on: `want` if it has it, else a hand, else its first. */
  boneFor (c: Character, want = 'RightHand'): string {
    const joints = hierarchyOf(c).map(([j]) => j)
    return joints.includes(want) ? want : joints.find(j => j === 'RightHand' || j === 'LeftHand') ?? joints[0] ?? want
  }

  async upload (c: Character, files: Iterable<File>, kind: GearKind = 'bone'): Promise<void> {
    for (const file of files) {
      const before = new Set(c.gear.map(g => g.id))
      try {
        const after = await api.uploadGear(c.id, file, kind, kind === 'bone' ? { bone: this.boneFor(c) } : {})
        app.upsert(after)
        const added = after.gear.find(g => !before.has(g.id))
        if (added !== undefined) this.select(added.id)
      } catch (error) {
        app.toast('error', `${file.name}: ${message(error)}`)
      }
    }
  }

  /** A catalog item as new bone gear on its usual bone, placed as the catalog places it. */
  async addCatalog (c: Character, file: string): Promise<void> {
    const item = catalogItem(file)
    if (item === undefined) return
    const bone = this.boneFor(c, item.socket)
    const view = this.rider?.id === c.id ? this.rider.view : null
    const place = view === null ? null : catalogPlacement(view, item, bone)
    // (no rig on stage to measure the bone on: kept in its grip frame, converted when the rig loads)
    const attach: GearAttach = place !== null ? { kind: 'bone', bone, place }
      : { kind: 'bone', bone, place: { ...defaultPlacement(bone, item.category), scale: defaultScale(heightOf(c)) }, legacyFrame: 'grip' }
    let id = newId()
    while (gearById(c, id) !== undefined) id = newId()
    // (on a hand it is carried, the hand closed on it in the default fist, as an uploaded prop is)
    const hand = handSide(bone)
    const handles: Handle[] = hand === null ? [] : [{ id: 'carry', name: 'Carried', kind: 'carry', hand, pose: 'default' }]
    const entry = await app.do(c.id, { type: 'gear.add', gear: { id, name: item.name, catalog: file, from: `catalog:${file}`, status: 'ready', attach, handles } })
    if (entry !== null) this.select(id)
  }

  /** Back to where the catalog first puts it (catalog gear). */
  async resetPlacement (c: Character, g: Gear): Promise<void> {
    const item = g.catalog === undefined ? undefined : catalogItem(g.catalog)
    const view = this.rider?.view ?? null
    if (item === undefined || g.attach.kind !== 'bone' || view === null) return
    const place = catalogPlacement(view, item, g.attach.bone)
    if (place !== null) await app.do(c.id, { type: 'gear.place', id: g.id, place })
  }

  async remove (c: Character, g: Gear): Promise<void> {
    const ok = await app.confirm({
      title: `Remove ${g.name}?`,
      body: 'Keys and holds on it in this character\'s clips go too. Undo brings it all back.',
      confirm: 'Remove', danger: true,
    })
    if (!ok) return
    if (this.selected === g.id) this.select(null)
    await app.do(c.id, { type: 'gear.remove', id: g.id })
  }

  async setShown (c: Character, g: Gear, shown: boolean): Promise<void> {
    await app.do(c.id, { type: 'gear.update', id: g.id, patch: { hidden: !shown } })
  }

  async rename (c: Character, g: Gear, name: string): Promise<void> {
    const next = name.trim()
    if (next === '' || next === g.name) return
    await app.do(c.id, { type: 'gear.update', id: g.id, patch: { name: next } })
  }

  async setSwapSet (c: Character, g: Gear, set: string | null): Promise<void> {
    const next = set?.trim() ?? ''
    if (next === (g.swapSet ?? '')) return
    await app.do(c.id, { type: 'gear.update', id: g.id, patch: { swapSet: next === '' ? null : next } })
  }

  async place (c: Character, g: Gear, change: Partial<Placement>): Promise<void> {
    await app.do(c.id, { type: 'gear.place', id: g.id, place: { ...this.placeOf(g), ...change } })
  }

  /**
   * Put a bone piece on another bone, from where it sits at rest. Given to the bone on the other side of the body (one
   * hand to the other) while it sits by this side, it moves across, held the same way (placement.ts mirroredPlacement).
   * One command: its carry handle and the hand poses that follow it go with it.
   */
  async setBone (c: Character, g: Gear, bone: string): Promise<void> {
    const a = g.attach
    if (a.kind !== 'bone' || a.bone === bone) return
    const view = this.rider?.view ?? null
    const place = this.placeOf(g)
    let next = place
    const at = view?.rest?.bones.get(bone)?.worldPosition
    const worn = this.rider?.pieces.get(g.id)?.worn
    if (at !== undefined && worn != null && counterpart(bone) === a.bone && nearerMirror(place.position, at)) {
      next = mirroredPlacement(place, pointsOf(worn.meshes)) ?? place
    }
    // (still in the grip frame with no rig to convert it: it stays so, on the new bone)
    const legacy = a.legacyFrame === 'grip' && view === null
    await app.do(c.id, { type: 'gear.attach', id: g.id, attach: legacy ? { ...a, bone } : { kind: 'bone', bone, place: next } })
  }

  /** How it follows the body, changed whole: on a bone, on the skin, pinned to a spot (its placement kept). */
  async setKind (c: Character, g: Gear, kind: WearKind): Promise<void> {
    if (g.attach.kind === kind) return
    const place = this.placeOf(g)
    const attach: GearAttach = kind === 'bone' ? { kind: 'bone', bone: this.boneFor(c), place }
      : kind === 'skin' ? { kind: 'skin', policy: 'body', place } : { kind: 'spot', place }
    if (this.fitting === g.id) this.fitting = null
    await app.do(c.id, { type: 'gear.attach', id: g.id, attach })
  }

  /** Change a skin or spot piece's way of following (policy, hiding the body, its spot, its animation). */
  async setAttach (c: Character, g: Gear, change: Partial<Extract<GearAttach, { kind: 'skin' }>> | Partial<Extract<GearAttach, { kind: 'spot' }>>): Promise<void> {
    const merged = { ...g.attach, ...change } as Record<string, unknown>
    for (const [k, v] of Object.entries(change)) if (v === undefined) delete merged[k]
    await app.do(c.id, { type: 'gear.attach', id: g.id, attach: merged as unknown as GearAttach })
  }

  // ---- handles -------------------------------------------------------------------------------------------------

  async updateHandle (c: Character, g: Gear, h: Handle, patch: Extract<Command, { type: 'gear.handle.update' }>['patch']): Promise<void> {
    await app.do(c.id, { type: 'gear.handle.update', gear: g.id, id: h.id, patch })
  }

  async removeHandle (c: Character, g: Gear, h: Handle): Promise<void> {
    await app.do(c.id, { type: 'gear.handle.remove', gear: g.id, id: h.id })
  }

  /** A grip for `side`'s hand where that hand is now on the piece (pause a clip on the frame where it holds it). */
  async addGrip (c: Character, g: Gear, side: Side): Promise<void> {
    const node = this.nodeOf(g.id)
    const hand = this.rider?.view.bones.get(`${side}Hand`)
    if (node === null || hand === undefined) return
    node.updateWorldMatrix(true, false)
    hand.updateWorldMatrix(true, false)
    const position = hand.getWorldPosition(new THREE.Vector3()).applyMatrix4(node.matrixWorld.clone().invert())
    const turn = node.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(hand.getWorldQuaternion(new THREE.Quaternion()))
    const name = freeHandleName(g, `${side} grip`)
    await app.do(c.id, {
      type: 'gear.handle.add', gear: g.id,
      handle: { id: freeHandleId(g), name, kind: 'grip', hand: side, exact: true, place: { position: [r5(position.x), r5(position.y), r5(position.z)], rotation: [r5(turn.x), r5(turn.y), r5(turn.z), r5(turn.w)] } },
    })
  }

  /** A pull on a bone piece: drawn by the hand that doesn't carry it, resting on the piece's longest, thinnest part
   * (a bowstring), at its middle. */
  async addPull (c: Character, g: Gear): Promise<void> {
    const view = this.rider?.view ?? null
    if (g.attach.kind !== 'bone' || view === null) return
    const worn = this.rider?.pieces.get(g.id)?.worn
    const rest = worn == null ? null : strandMiddle(worn.meshes)
    const carried = handSide(g.attach.bone)
    const bone = this.boneFor(c, carried === 'Right' ? 'LeftHand' : 'RightHand')
    const pulls = g.handles.filter(h => h.kind === 'pull').length
    await app.do(c.id, {
      type: 'gear.handle.add', gear: g.id,
      handle: {
        id: freeHandleId(g), name: freeHandleName(g, pulls === 0 ? 'Draw' : 'Pull'), kind: 'pull',
        pull: { bone, grip: gripPoint(view, bone), rest: rest === null ? [0, 0, 0] : [r5(rest.x), r5(rest.y), r5(rest.z)] },
      },
    })
  }

  /** A pull drawn by another bone (held at that bone's grip). */
  async setPullBone (c: Character, g: Gear, h: Handle, bone: string): Promise<void> {
    const view = this.rider?.view ?? null
    if (h.pull === undefined || view === null || bone === h.pull.bone) return
    await this.updateHandle(c, g, h, { pull: { bone, grip: gripPoint(view, bone), rest: h.pull.rest } })
  }

  // ---- picking -------------------------------------------------------------------------------------------------

  /** Pin a spot piece to the spot of the body clicked next (its rest position: the same skin whatever the pose). */
  pickSpot (c: Character, g: Gear): void {
    if (g.attach.kind !== 'spot') return
    this.startPicking({ kind: 'spot', gear: g.id }, (ray) => {
      const view = this.rider?.view
      if (view === undefined) return false
      const body = view.skinned.filter(m => m.userData[GARMENT_FLAG] === undefined)
      for (const m of body) m.computeBoundingSphere()
      const hit = ray.intersectObjects(body, false)[0]
      if (hit === undefined || hit.face === undefined || hit.face === null) return false
      const mesh = hit.object as THREE.SkinnedMesh
      // where on the triangle as it stands, then that point of it at rest
      const corners = [hit.face.a, hit.face.b, hit.face.c]
      const posed = corners.map(v => mesh.getVertexPosition(v, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld))
      const bary = THREE.Triangle.getBarycoord(hit.point, posed[0], posed[1], posed[2], new THREE.Vector3()) ?? new THREE.Vector3(1 / 3, 1 / 3, 1 / 3)
      const pos = mesh.geometry.attributes.position
      const rest = corners.map(v => new THREE.Vector3().fromBufferAttribute(pos, v).applyMatrix4(mesh.bindMatrix))
      const at = rest[0].multiplyScalar(bary.x).addScaledVector(rest[1], bary.y).addScaledVector(rest[2], bary.z)
      const now = gearById(app.byId(c.id) ?? c, g.id)
      if (now !== undefined && now.attach.kind === 'spot') void this.setAttach(c, now, { anchor: [r4(at.x), r4(at.y), r4(at.z)] })
      return true
    })
  }

  /** Put a pull's point where the piece is clicked next (in the piece's own space). */
  pickPull (c: Character, g: Gear, h: Handle): void {
    if (h.pull === undefined) return
    this.startPicking({ kind: 'pull', gear: g.id, handle: h.id }, (ray) => {
      const worn = this.rider?.pieces.get(g.id)?.worn
      if (worn == null || worn.node === null) return false
      for (const m of worn.meshes) if ((m as THREE.SkinnedMesh).isSkinnedMesh === true) (m as THREE.SkinnedMesh).computeBoundingSphere()
      const hit = ray.intersectObjects(worn.meshes, false)[0]
      if (hit === undefined) return false
      const at = worn.node.worldToLocal(hit.point.clone())
      const now = gearById(app.byId(c.id) ?? c, g.id)?.handles.find(x => x.id === h.id)
      if (now?.pull !== undefined) void this.updateHandle(c, g, now, { pull: { ...now.pull, rest: [r5(at.x), r5(at.y), r5(at.z)] } })
      return true
    })
  }

  stopPicking (): void {
    this.offPicking?.()
    this.offPicking = null
    if (this.picking !== null) this.picking = null
  }

  /** The next left click on the canvas that `hit` takes (true) picks; a click it doesn't take turns the camera as
   * ever. Escape stops. */
  private startPicking (what: Picking, hit: (ray: THREE.Raycaster) => boolean): void {
    this.stopPicking()
    const stage = viewer.stage
    if (stage === null) return
    const canvas = stage.renderer.domElement
    const ray = new THREE.Raycaster()
    const down = (e: PointerEvent): void => {
      if (e.button !== 0) return
      const r = canvas.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2), stage.camera)
      if (!hit(ray)) return
      e.stopPropagation(); e.preventDefault()
      this.stopPicking()
    }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') this.stopPicking() }
    canvas.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('keydown', key)
    this.offPicking = () => {
      canvas.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('keydown', key)
    }
    this.picking = what
  }

  // ---- looking at it in a pose ---------------------------------------------------------------------------------

  /** What the pose picker shows: 'rest', 'fists', a slot id, or 'other' (something else playing). */
  get pose (): string {
    const playing = animator.playing
    if (playing === null) return 'rest'
    if (playing.slotId !== null) return playing.slotId
    // (by what it was shown as: another one-frame clip, a hand pose, is something else)
    return this.restShown !== null && playing.label === this.restShown ? 'fists' : 'other'
  }

  async setPose (c: Character, value: string): Promise<void> {
    if (value === 'rest') { await animator.stop(); return }
    if (value === 'fists') { await this.showRestFists(c); return }
    if (slotById(c, value) !== undefined) await animator.playSlot(c, value)
  }

  /** The rest pose with each hand closed as its layers say at rest (what it carries, what it holds in every clip). */
  async showRestFists (c: Character): Promise<void> {
    await hands.showRest(c)
    const playing = animator.playing
    if (playing !== null && playing.slotId === null) this.restShown = playing.label
  }

  /**
   * When a slot holds a pull, found by playing the slot (pulls.ts findHolds): from when the pulling bone first reaches
   * the strand to the slot's blow (its blow timing), or a full draw. [] when it never reaches it. The windows are
   * returned, not saved: they are the slot's handleHold adjustment (Motion's).
   */
  async findHolds (c: Character, gearId: string, handleId: string, slotId: string): Promise<Window[]> {
    const g = gearById(c, gearId)
    const h = g?.handles.find(x => x.id === handleId)
    const slot = slotById(c, slotId)
    const view = this.rider?.view
    const worn = this.rider?.pieces.get(gearId)?.worn
    if (g === undefined || h?.pull === undefined || slot === undefined || view === undefined || worn == null || worn.node === null) return []
    const hand = view.bones.get(h.pull.bone)
    const strand = strandSegment(worn.meshes, h.pull.rest)
    if (hand === undefined || strand === null) return []
    this.finding = `${gearId}/${handleId}/${slotId}`
    try {
      await animator.playSlot(c, slotId)
      for (let i = 0; i < 100 && !(animator.playing?.slotId === slotId && animator.playing.baked !== null && animator.duration > 0); i++) await sleep(50)
      if (animator.playing?.slotId !== slotId || animator.duration <= 0) return []
      animator.setPlaying(false)
      const duration = animator.duration
      const blow = slot.time?.fit?.enabled === true ? slot.time.fit : undefined
      const node = worn.node
      const windows = holdsOf({
        seek: u => { animator.seek(u * duration); view.root.updateMatrixWorld(true) },
        hand, grip: h.pull.grip, node, strand, reach: view.height * 0.03, release: blow?.at,
      })
      animator.seek(0)
      return windows
    } finally {
      this.finding = null
    }
  }
}

/** The vertices of a piece's meshes in its own space (each mesh's matrix applied), for working out its plane. */
function pointsOf (meshes: readonly THREE.Mesh[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  for (const m of meshes) {
    const pos = m.geometry.attributes.position
    // (a dense mesh needn't give every vertex to tell its plane)
    const step = Math.max(1, Math.floor(pos.count / 20000))
    for (let i = 0; i < pos.count; i += step) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrix))
  }
  return out
}

function freeHandleId (g: Gear): string {
  let id = newId()
  while (g.handles.some(h => h.id === id)) id = newId()
  return id
}

export const gear = new GearState()
gear.start()
