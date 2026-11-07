// Gear on stage and the Gear step's actions. The character's gear is worn on its view as soon as it loads (viewer
// onLoad, before the animator's bakes: a clip's gear tracks need the place nodes), and on its horse when it rides
// (wearing the horse's mount.gear). Each piece is worn on its own (src/engine/garments.ts wear) and only put on again
// when what it is made from changes; a placement change just moves its node. A dynamic character's outfit, hair and
// beard show as its dress says (dress.svelte.ts, view state): a piece hidden by browsing stays fitted while its set
// was worn lately or is fitted ahead (just not drawn), so flipping back and forth is instant. Every change is a
// command (app.do);
// placing goes through the shared gizmo (gizmo.svelte.ts). Catalog gear still kept in the old props' grip frame
// (attach.legacyFrame, from the migration) is converted to rest space the first time its rig loads.
import * as THREE from 'three'
import { untrack } from 'svelte'
import type { Command } from '../model/command-types.ts'
import { newId } from '../model/ids.ts'
import { carryHandle, gearById, handSide, heightOf, hierarchyOf, slotById } from '../model/select.ts'
import { originOf } from '../model/origin.ts'
import type { Character, ClipKey, Gear, GearAttach, Handle, Placement, Side, Vec3, Window } from '../model/types.ts'
import type { CharacterView } from '../engine/CharacterView.ts'
import { carrierGrip, handGrip } from '../engine/clipedit.ts'
import { boneFrame, GARMENT_FLAG, type GarmentEdit, hideBodyUnder, restFrame, takeOff, takeOffAll, tickMechanisms, wear, type Worn } from '../engine/garments.ts'
import type { DerivedStore } from '../engine/workers/derive.ts'
import { fistAt, fitMatrix, heldAt, inFist, offBox, onShaft, restPoints, shapeOf, surfacePoints, type HandAt, type Shape } from '../engine/gearfit.ts'
import { leadKeysMoved } from '../engine/geartracks.ts'
import { shapeFemale, showSkin, tint } from '../engine/folkview.ts'
import { longSleeves } from '../engine/folk.ts'
import { counterpart, mirroredPlacement, nearerMirror, placementFromMatrix, placementMatrix, placementOf } from '../engine/placement.ts'
import { catalogItem, catalogPlacement, catalogUrl, defaultPlacement, defaultScale, gripPoint, gripToRest } from '../engine/props.ts'
import { findHolds as holdsOf, strandMiddle, strandSegment, tickPulls } from '../engine/pulls.ts'
import { animator } from './animator.svelte.ts'
import { api, type GearKind } from './api.ts'
import { app } from './app.svelte.ts'
import { asset, assets } from './assets.svelte.ts'
import { dress as dressing } from './dress.svelte.ts'
import { documentDress, resolve, shows, type Dressed } from './dressing.ts'
import { mark } from '../engine/perf.ts'
import { gizmo } from './gizmo.svelte.ts'
import { hands } from './hands.svelte.ts'
import { paint } from './paint.svelte.ts'
import { viewer } from './viewer.svelte.ts'
import { freeHandleName } from '../app/gear/text.ts'

export type WearKind = GearAttach['kind']

/** Picking on the viewport: a spot piece's spot on the body, or a pull's point on its piece. */
export type Picking = { kind: 'spot', gear: string } | { kind: 'pull', gear: string, handle: string }

/** A piece as worn: what it was made from (`key`, and its model file's hash: `hash`, undefined while the character's
 * files index isn't in), its frame (bone gear, made at once), what wear() put on, and whether it is shown (a piece
 * kept fitted while hidden isn't drawn). */
interface Piece { key: string, hash: string | undefined, gear: Gear, frame: ReturnType<typeof boneFrame>, worn: Worn | null, placed: string, shown: boolean }

/** A character wearing gear on stage: the one selected, or the horse it rides. */
interface Wearer { view: CharacterView, id: string, rider: boolean, pieces: Map<string, Piece> }

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4
const r5 = (v: number): number => Math.round(v * 1e5) / 1e5
const r6 = (v: number): number => (Object.is(Math.round(v * 1e6) / 1e6, -0) ? 0 : Math.round(v * 1e6) / 1e6)

/** Where a piece's origin can be put (Gear: "Set origin"): its middle or its base (bottom middle) as it sits at rest,
 * where a hand holds it. */
export type OriginAt = 'middle' | 'base' | 'grip'
/** An upload whose origin lies farther off it than this share of the body's height gets one on it. */
const OFF_PIECE = 0.05
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
  /** The piece whose origin the gizmo is placing (its marker dragged, not the piece). */
  placingOrigin = $state<string | null>(null)

  private rider: Wearer | null = null
  private horse: Wearer | null = null
  /** The ids on stage (what the sync effect follows: only these characters' changes wear anything). */
  private onStage = $state<{ rider: string | null, horse: string | null }>({ rider: null, horse: null })
  private converted = new Set<string>()
  /** The character last loaded (a reload of the same one keeps the piece open). */
  private lastId: string | null = null
  private offPicking: (() => void) | null = null
  private loading = 0
  private refreshing = false
  /** Pieces uploaded here still importing: once worn, each gets an origin on it and goes into the hand (settle). */
  private fresh = new Set<string>()
  /** Wearers whose body is to be hidden again (hideLater). */
  private hiding = new Set<Wearer>()
  /** The selected piece's origin, shown on stage (and dragged while placing it). */
  private marker: THREE.Object3D | null = null
  /** The gizmo's mode before placing an origin (it places in Move). */
  private modeBefore: typeof gizmo.mode | null = null

  /** Start following the viewer (called once, below). */
  start (): () => void {
    const offs = [
      viewer.onLoad((view, c) => this.load(view, c), 10),
      viewer.onMountLoad(() => { this.loadHorse() }),
      viewer.onMountUnload(() => { this.unloadHorse() }),
    ]
    const stopEffects = $effect.root(() => {
      // (every copy of the character on stage and of its horse, the optimistic ones too: what is worn follows at once;
      // another character's change wears nothing, its copy being the same object)
      const rider = $derived(this.onStage.rider === null ? null : app.byId(this.onStage.rider))
      const horse = $derived(this.onStage.horse === null ? null : app.byId(this.onStage.horse))
      $effect(() => {
        void rider; void horse
        void paint.active
        // (the dress on stage, and the files the pieces are made from: a piece written again on disk is worn again)
        if (rider !== null) { void dressing.worn(rider); void dressing.keeping(rider.id); void assets.manifestOf(rider.id) }
        if (horse !== null) void assets.manifestOf(horse.id)
        untrack(() => { this.syncAll() })
      })
      $effect(() => {
        void app.step; void this.selected; void this.fitting; void this.picking; void paint.active; void this.worn; void this.placingOrigin
        untrack(() => { this.updateGizmo() })
      })
      // (leaving the step: nothing half placed or picked is left behind)
      $effect(() => {
        if (app.step === 'gear') return
        untrack(() => {
          if (this.picking !== null) this.stopPicking()
          if (this.fitting !== null) this.fitting = null
          if (this.placingOrigin !== null) this.placeOrigin(null)
        })
      })
      $effect(() => {
        const playing = animator.playing
        if (playing === null || playing.slotId !== null) untrack(() => { this.restShown = null })
      })
    })
    return () => { for (const off of offs) off(); stopEffects() }
  }

  /** The character on stage, as the app has it now. */
  private get character (): Character | null {
    const id = this.rider?.id
    return id === undefined ? null : app.byId(id)
  }

  /** The selected piece's worn node, if it has one to place (the gizmo's target). */
  nodeOf (id: string): THREE.Object3D | null {
    void this.worn
    const p = this.rider?.pieces.get(id)
    return p?.shown === true ? p.worn?.node ?? null : null
  }

  /** Whether `id` is worn, loaded and shown on stage. */
  isWorn (id: string): boolean {
    void this.worn
    const p = this.rider?.pieces.get(id)
    return p?.shown === true && p.worn != null
  }

  /** Whether a piece of the character shows on stage: as its dress says for a dynamic character's outfits, hair and
   * beards (browsing: dress.svelte.ts), else as the document has it (reactive). */
  shownOnStage (c: Character, g: Gear): boolean {
    if (this.fitting === g.id) return true
    return shows(c, g, dressing.worn(c), documentDress(c))
  }

  /** A shown piece on stage (a piece kept fitted while hidden is not there for the panels). */
  private shownPiece (id: string): Piece | undefined {
    const p = this.rider?.pieces.get(id)
    return p?.shown === true ? p : undefined
  }

  // ---- on stage ------------------------------------------------------------------------------------------------

  private load (view: CharacterView, c: Character): () => void {
    if (this.lastId !== c.id) { this.selected = null; this.fitting = null }
    this.lastId = c.id
    this.stopPicking()
    const rider: Wearer = { view, id: c.id, rider: true, pieces: new Map() }
    this.rider = rider
    this.onStage.rider = c.id
    if (view.rest !== null) this.convertLegacy(view, c)
    this.sync(rider, c.gear, c)
    dressing.plan(c)
    const off = viewer.stage?.onFrame(dt => {
      tickMechanisms(dt)
      // (nothing playing: every pull at rest; while a slot plays the animator ticks them)
      if (animator.playing === null) tickPulls(null, 0)
      this.followMarker()
    })
    return () => {
      off?.()
      this.dropMarker()
      this.stopPicking()
      for (const p of rider.pieces.values()) gizmo.detach(p.frame?.place ?? p.worn?.node)
      takeOffAll(view)
      rider.pieces.clear()
      if (this.rider === rider) { this.rider = null; this.onStage.rider = null }
      this.worn++
    }
  }

  private loadHorse (): void {
    this.unloadHorse()
    const m = viewer.mount
    if (m === null) return
    this.horse = { view: m.view, id: m.character.id, rider: false, pieces: new Map() }
    this.onStage.horse = m.character.id
    this.syncHorse()
  }

  private unloadHorse (): void {
    const h = this.horse
    if (h === null) return
    takeOffAll(h.view)
    h.pieces.clear()
    this.horse = null
    this.onStage.horse = null
  }

  private syncAll (): void {
    const done = mark('gear.sync')
    const c = this.character
    if (this.rider !== null && c !== null) this.sync(this.rider, c.gear, c)
    this.syncHorse()
    done()
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

  /** Whether a piece shows: the rider's as its dress says (the gear list's own hidden for the rest), the horse's as
   * its rider's mount says (syncHorse). A piece being fitted always shows. */
  private showsOn (c: Character, g: Gear, w: Wearer, worn: Dressed | null, own: Dressed | null): boolean {
    if (w.rider && this.fitting === g.id) return true
    return worn === null || own === null ? g.hidden !== true : shows(c, g, worn, own)
  }

  /** What a piece is worn from: null when it can't be worn. Not whether it shows (a piece kept fitted is only hidden),
   * nor a bone piece's placement (its node just moves), nor its model file's hash (hashOf: a piece worn before the
   * files index came in is the same piece once it has). */
  private keyOf (g: Gear, c: Character, w: Wearer): string | null {
    const url = g.catalog !== undefined ? catalogUrl(g.catalog) : g.model ?? null
    const fitting = w.rider && this.fitting === g.id
    if (g.status !== 'ready' || url === null || this.urlOf(c, g) === null) return null
    const a = g.attach
    // (the painted count while painting it: the painter has its weights on the meshes already)
    const painted = paint.active ? null : g.painted ?? 0
    if (a.kind === 'bone') {
      const pulls = g.handles.filter(h => h.kind === 'pull').map(h => [h.id, h.name, h.pull])
      return JSON.stringify(['bone', g.name, url, a.bone, pulls, pulls.length > 0 ? painted : null, g.origin ?? null])
    }
    return JSON.stringify([a.kind, g.name, url, a, a.kind === 'skin' ? painted : null, fitting, g.origin ?? null])
  }

  /** Where its model loads from (catalog gear: the bundled file). */
  urlOf (c: Character, g: Gear): string | null {
    if (g.catalog !== undefined) return catalogUrl(g.catalog)
    return asset(c, g.model)
  }

  /** Its placement in rest space (catalog gear in the old grip frame converted). */
  placeOf (g: Gear, view: CharacterView | null = this.rider?.view ?? null): Placement {
    const a = g.attach
    if (a.kind === 'bone' && a.legacyFrame === 'grip' && view !== null) return gripToRest(view, a.bone, a.place) ?? a.place
    return a.place
  }

  /** The hash of the file a piece's model loads from, when the character's files index has it (catalog gear: none). */
  private hashOf (c: Character, g: Gear): string | undefined {
    return g.catalog !== undefined || g.model === undefined ? undefined : assets.manifestOf(c.id)?.[g.model]
  }

  private sync (w: Wearer, list: Gear[], c: Character): void {
    if (w.view.rest === null) return
    // (the rider's dress; the horse wears what its rider's mount says, as the list has it)
    const worn = w.rider ? dressing.worn(c) : null
    const own = w.rider ? documentDress(c) : null
    const wanted = new Map<string, { g: Gear, key: string, hash: string | undefined, shown: boolean }>()
    for (const g of list) {
      const shown = this.showsOn(c, g, w, worn, own)
      if (!shown && !(w.rider && dressing.kept(c, g))) continue
      const key = this.keyOf(g, c, w)
      if (key !== null) wanted.set(g.id, { g, key, hash: this.hashOf(c, g), shown })
    }
    let changed = false
    for (const [id, p] of w.pieces) {
      const want = wanted.get(id)
      // (the same piece: its file's hash the same, or only now known)
      if (want !== undefined && want.key === p.key && (p.hash === undefined || want.hash === undefined || want.hash === p.hash)) { p.hash ??= want.hash; continue }
      this.off(w, p)
      w.pieces.delete(id)
      changed = true
    }
    for (const [id, { g, key, hash, shown }] of wanted) {
      const p = w.pieces.get(id)
      if (p === undefined) { this.on(w, c, g, key, hash, shown); changed = true; continue }
      this.move(w, p, g)
      if (p.shown !== shown) { this.show(w, p, shown); changed = true }
    }
    if (changed) { this.worn++; this.refreshAnimator() }
    this.dress(w, c, worn)
  }

  /** A worn piece shown or hidden (kept fitted): its nodes drawn or not, the body under it hidden again. */
  private show (w: Wearer, p: Piece, shown: boolean): void {
    p.shown = shown
    if (!shown && w.rider) gizmo.detach(p.worn?.node ?? p.frame?.place)
    for (const o of p.worn?.objects ?? (p.frame !== null ? [p.frame.group] : [])) o.visible = shown
    if (hidesBody(p.worn)) this.hideLater(w)
  }

  /** A dynamic character's look (engine/folk.ts): its skin shown on the body (the rider's dress picks it), its hair
   * and beard tinted to it. */
  private dress (w: Wearer, c: Character, worn: Dressed | null = w.rider ? dressing.worn(c) : null): void {
    const look = worn ?? resolve(c, undefined)
    const skin = (c.look.skins ?? []).find(s => s.name === look.skin)
    const clothes = (c.look.clothes ?? []).find(s => s.name === look.clothing)
    void showSkin(w.view.bodySkinned, skin === undefined ? null : asset(c, skin.file), clothes === undefined ? null : asset(c, clothes.file), longSleeves(clothes)).catch((error: unknown) => {
      app.toast('error', `The skin ${skin?.name ?? ''} didn't load: ${message(error)}`)
    })
    for (const p of w.pieces.values()) {
      if (p.worn === null || p.gear.role === undefined) continue
      tint(p.worn.meshes, skin?.hair ?? null)
    }
    // (a female skin: the body's female shape, the skinned gear taking the same where it sits)
    const gear = [...w.pieces.values()].flatMap(p => (p.worn !== null && p.gear.attach.kind !== 'bone' ? p.worn.meshes : []))
    shapeFemale(w.view.bodySkinned, gear, (skin?.tags ?? []).includes('female'), w.view.height)
  }

  private on (w: Wearer, c: Character, g: Gear, key: string, hash: string | undefined, shown: boolean): void {
    const view = w.view
    const place = this.placeOf(g, view)
    const frame = g.attach.kind === 'bone' ? boneFrame(view, g, g.attach.bone, place) : null
    if (frame !== null) frame.group.visible = shown
    const piece: Piece = { key, hash, gear: g, frame, worn: null, placed: JSON.stringify(place), shown }
    w.pieces.set(g.id, piece)
    const fitting = w.rider && this.fitting === g.id
    // (skinning to the body is the slow part: say so, unless it is fitted ahead, hidden)
    const heavy = g.attach.kind !== 'bone' && !fitting && shown
    if (heavy) this.busy(1)
    const url = this.urlOf(c, g)!
    const weights = (g.painted ?? 0) > 0 ? asset(c, `garments/${g.id}/weights.json`) : null
    const edits = async (): Promise<GarmentEdit[]> => {
      if (weights === null) return []
      const res = await fetch(weights)
      return res.ok ? await res.json() as GarmentEdit[] : []
    }
    const done = mark('gear.wear', g.name)
    const derived = g.attach.kind === 'skin' ? derivedStore(c.id, g.id) : undefined
    wear(view, g, { url, place, fitting, edits, frame: frame ?? undefined, derived })
      .then(worn => {
        done()
        if (w.pieces.get(g.id) !== piece) { if (worn !== null) takeOff(view, worn); return }
        piece.worn = worn
        if (worn === null) frame?.group.removeFromParent()
        // (shown or not as it is now: it may have been hidden or shown while it loaded)
        else for (const o of worn.objects) o.visible = piece.shown
        if (piece.shown && hidesBody(worn)) this.hideLater(w)
        if (g.role !== undefined) this.dress(w, c)
        this.worn++
        if (worn !== null && w.rider && this.fresh.delete(g.id)) void this.settle(c.id, g.id)
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
    if (p.shown && hidesBody(p.worn)) this.hideLater(w)
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

  /** The body hidden again under what is shown, once a frame however many pieces went on, off, shown or hidden in it
   * (a Randomize swaps the outfit, hair and beard together; pieces fitted while loading land one by one). */
  private hideLater (w: Wearer): void {
    if (this.hiding.has(w)) return
    this.hiding.add(w)
    const run = (): void => {
      this.hiding.delete(w)
      // (gone from the stage meanwhile)
      if (w !== this.rider && w !== this.horse) return
      const done = mark('gear.hideBodyUnder')
      hideBodyUnder(w.view, this.wornOf(w))
      done()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else queueMicrotask(run)
  }

  /** What is worn and shown. */
  private wornOf (w: Wearer): Worn[] {
    return [...w.pieces.values()].flatMap(p => (p.worn === null || !p.shown ? [] : [p.worn]))
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
    const node = app.step === 'gear' && this.picking === null && !paint.active && id !== null ? this.shownPiece(id)?.worn?.node ?? null : null
    if (this.placingOrigin !== null && this.placingOrigin !== id) this.placeOrigin(null)
    const marker = node !== null && this.placingOrigin === id ? this.ensureMarker() : null
    const target = marker ?? node
    if (target === null) {
      gizmo.detach(this.gizmoOn)
      this.gizmoOn = null
      return
    }
    if (gizmo.target === target) return
    this.gizmoOn = target
    if (marker !== null) {
      this.followMarker(true)
      gizmo.attach(marker, { mode: 'translate', space: 'world', onCommit: () => { void this.commitOrigin(id!, node!) } })
    } else {
      gizmo.attach(node!, { space: 'world', onCommit: () => { this.commitPlace(id!, node!) } })
    }
  }

  // ---- the origin's marker ---------------------------------------------------------------------------------------

  /** The marker (made once a stage: a dot and three short axes, drawn over everything), on the stage's scene. */
  private ensureMarker (): THREE.Object3D | null {
    const stage = viewer.stage
    if (stage === null) return null
    if (this.marker !== null && this.marker.parent === stage.scene) return this.marker
    this.dropMarker()
    const group = new THREE.Group()
    group.name = 'gear-origin'
    const top = (m: THREE.Material): THREE.Material => { m.depthTest = false; m.depthWrite = false; m.transparent = true; return m }
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), top(new THREE.MeshBasicMaterial({ color: 0xffd23f })))
    dot.scale.setScalar(0.012)
    dot.renderOrder = 1000
    group.add(dot)
    const o = new THREE.Vector3()
    const axes = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([o, new THREE.Vector3(1, 0, 0), o, new THREE.Vector3(0, 1, 0), o, new THREE.Vector3(0, 0, 1)]),
      top(new THREE.LineBasicMaterial({ vertexColors: true })))
    axes.geometry.setAttribute('color', new THREE.Float32BufferAttribute([1, 0.3, 0.3, 1, 0.3, 0.3, 0.3, 1, 0.3, 0.3, 1, 0.3, 0.3, 0.5, 1, 0.3, 0.5, 1], 3))
    axes.scale.setScalar(0.06)
    axes.renderOrder = 1000
    group.add(axes)
    group.visible = false
    stage.scene.add(group)
    this.marker = group
    return group
  }

  private dropMarker (): void {
    const m = this.marker
    if (m === null) return
    if (gizmo.target === m) gizmo.detach(m)
    m.removeFromParent()
    m.traverse(o => { const x = o as THREE.Mesh; if (x.geometry !== undefined) x.geometry.dispose(); if (x.material !== undefined) for (const mat of Array.isArray(x.material) ? x.material : [x.material]) mat.dispose() })
    this.marker = null
  }

  /** The marker on the selected piece's origin, turned as it is, sized to the body (shown in Gear only). While the
   * gizmo drags it (placing the origin) it stays where it is dragged, unless `snap`. */
  private followMarker (snap = false): void {
    const id = this.selected
    const node = app.step === 'gear' && id !== null && !paint.active ? this.shownPiece(id)?.worn?.node ?? null : null
    if (node === null) { if (this.marker !== null) this.marker.visible = false; return }
    const m = this.ensureMarker()
    if (m === null) return
    m.visible = true
    if (!snap && this.placingOrigin === id && gizmo.dragging && gizmo.target === m) return
    node.updateWorldMatrix(true, false)
    node.matrixWorld.decompose(m.position, m.quaternion, new THREE.Vector3())
    m.scale.setScalar(this.rider?.view.height ?? 1)
    m.updateMatrixWorld(true)
  }

  /** The marker let go: the origin where it was dragged (a point of the piece's frame now). */
  private async commitOrigin (id: string, node: THREE.Object3D): Promise<void> {
    const c = this.character
    const g = c === null ? undefined : gearById(c, id)
    const m = this.marker
    if (c === null || g === undefined || m === null) return
    node.updateWorldMatrix(true, false)
    const at = node.worldToLocal(m.getWorldPosition(new THREE.Vector3()))
    if (at.length() < 1e-7) return
    await this.setOrigin(c, g, at)
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
    // (worn again, unbound or bound: what it is worn from says whether it is being fitted)
    this.syncAll()
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
        if (added !== undefined) { this.fresh.add(added.id); this.select(added.id) }
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

  // ---- its origin, and into the hand ----------------------------------------------------------------------------

  /** Drag the selected piece's origin with the gizmo (its marker), not the piece; null: done. */
  placeOrigin (id: string | null): void {
    if (id === this.placingOrigin) return
    this.stopPicking()
    if (id !== null) {
      this.selected = id
      this.modeBefore ??= gizmo.mode
    } else if (this.modeBefore !== null) {
      // (after the effect puts the gizmo back on the piece: the mode it had)
      const mode = this.modeBefore
      this.modeBefore = null
      queueMicrotask(() => { gizmo.mode = mode })
    }
    this.placingOrigin = id
  }

  /** The piece's points as worn, in its own frame (its origin at zero), spread on its surface. Null when it isn't on. */
  private pointsOf (g: Gear): THREE.Vector3[] | null {
    const worn = this.shownPiece(g.id)?.worn
    if (worn == null || worn.meshes.length === 0) return null
    if (worn.node !== null) {
      // (a bone piece, a mechanism, a piece being fitted: its meshes under its node, whatever pose it is in)
      worn.node.updateWorldMatrix(true, true)
      const inv = worn.node.matrixWorld.clone().invert()
      return surfacePoints(worn.meshes, 3000, m => inv.clone().multiply(m.matrixWorld))
    }
    // (skin and spot gear bound to the body: their meshes are at rest, placed)
    const unplace = placementMatrix(g.attach.place).invert()
    return surfacePoints(worn.meshes, 3000, () => unplace)
  }

  /** A hand at rest with its grip (clipedit.ts handGrip) and the way its fingers point. */
  private handAt (side: Side): HandAt | null {
    const rest = this.rider?.view.rest ?? null
    const wrist = rest?.bones.get(`${side}Hand`)
    const grip = rest === null ? null : handGrip(rest, side)
    if (rest === null || wrist === undefined || grip === null) return null
    const knuckle = rest.bones.get(`${side}HandMiddle1`) ?? rest.bones.get(`${side}HandIndex1`)
    const fingers = knuckle === undefined ? new THREE.Vector3(0, -1, 0) : knuckle.worldPosition.clone().sub(wrist.worldPosition).normalize()
    return { position: wrist.worldPosition.clone(), quaternion: wrist.worldQuaternion.clone(), grip, fingers }
  }

  /** Where a hand holds the piece, in its frame: its carry hand's fist as its carry handle has it, else a grip
   * handle's, else the middle of its handle end (gearfit.ts shapeOf). */
  private gripOf (g: Gear, points: THREE.Vector3[]): THREE.Vector3 | null {
    const view = this.rider?.view ?? null
    const place = this.placeOf(g)
    const s = place.scale
    const carried = g.attach.kind === 'bone' ? handSide(g.attach.bone) : null
    const carry = carryHandle(g)
    const handles: Array<{ side: Side, h: Handle }> = []
    if (carried !== null && carry !== undefined) handles.push({ side: carried, h: carry })
    for (const h of g.handles) if (h.kind === 'grip' && h.place !== undefined) handles.push({ side: h.hand ?? (carried === 'Left' ? 'Right' : 'Left'), h })
    for (const { side, h } of handles) {
      const hand = this.handAt(side)
      const wrist = view === null ? null : restFrame(view, `${side}Hand`)
      const at = h.place ?? (h.kind === 'carry' && wrist !== null ? carrierGrip(placementMatrix(place), wrist) : null)
      if (hand === null || at === null) continue
      return new THREE.Vector3(...at.position).add(hand.grip.fist.clone().divideScalar(s).applyQuaternion(new THREE.Quaternion(...at.rotation).normalize()))
    }
    return shapeOf(points)?.grip ?? null
  }

  /** The point of the piece's frame now that `at` names. */
  originPoint (g: Gear, at: OriginAt): THREE.Vector3 | null {
    const points = this.pointsOf(g)
    if (points === null || points.length < 3) return null
    if (at === 'grip') return this.gripOf(g, points)
    return restPoints(points, placementMatrix(this.placeOf(g)))[at]
  }

  /**
   * The piece's origin moved to `at` (a point of its frame now, or one it names), nothing moving: one command (one
   * undo) carrying its placement, handles, pulls and every clip's track of it over. A clip it leads in has its keys
   * carried by baking it (where it rode at each key).
   */
  async setOrigin (c: Character, g: Gear, at: THREE.Vector3 | OriginAt | null): Promise<boolean> {
    if (g.attach.kind === 'bone' && g.attach.legacyFrame !== undefined) return false
    const point = at === null ? null : typeof at === 'string' ? this.originPoint(g, at) : at
    if (at !== null && point === null) { app.toast('error', `${g.name} isn't on stage to measure`); return false }
    const was = originOf(g)
    const origin: Vec3 | null = point === null ? null : [r6(was[0] + point.x), r6(was[1] + point.y), r6(was[2] + point.z)]
    const o: Vec3 = origin === null ? [-was[0], -was[1], -was[2]] : [origin[0] - was[0], origin[1] - was[1], origin[2] - was[2]]
    if (o.every(x => x === 0)) return true
    const lead = await this.leadKeys(c, g, o)
    const entry = await app.do(c.id, { type: 'gear.origin', id: g.id, origin, ...(Object.keys(lead).length > 0 ? { lead } : {}) }, 'gear.origin')
    return entry !== null
  }

  /** The keys of every clip `g` leads in, carried for its origin moved by `o` (geartracks.ts leadKeysMoved), by slot id. */
  private async leadKeys (c: Character, g: Gear, o: Vec3): Promise<Record<string, ClipKey[]>> {
    const out: Record<string, ClipKey[]> = {}
    for (const s of c.clips) {
      const keys = s.gear?.[g.id]?.keys
      if (s.ik?.lead?.includes(g.id) !== true || keys === undefined || keys.length === 0) continue
      const baked = await animator.bake(c, s, { skip: ['keys'] }).catch(() => null)
      const ctx = animator.bakeContext()
      if (baked === null || ctx === null) continue
      out[s.id] = leadKeysMoved(g, keys, o, baked.unkeyed, u => baked.time.toPlayed(u), ctx)
    }
    return out
  }

  /** Whether `g` rides a hand (what Fit to hand is for). */
  inHand (g: Gear): boolean {
    return g.attach.kind === 'bone' && g.attach.legacyFrame === undefined && handSide(g.attach.bone) !== null
  }

  /** Its shape, held at its origin when that is on its shaft (most pieces' origin is where they are held), else at
   * the middle of its handle end; and the hand it rides. */
  private heldShape (g: Gear, points: THREE.Vector3[]): { shape: Shape, hand: HandAt } | null {
    const side = g.attach.kind === 'bone' ? handSide(g.attach.bone) : null
    const hand = side === null ? null : this.handAt(side)
    if (hand === null) return null
    const near = fistAt(hand).applyMatrix4(placementMatrix(this.placeOf(g)).invert())
    const shape = shapeOf(points, near)
    if (shape === null) return null
    return { shape: onShaft(shape, new THREE.Vector3()) ? heldAt(shape, new THREE.Vector3()) : shape, hand }
  }

  /** A hand piece put into its fist: its grip in the fist, its long axis along the fist's grip line (one undo; a carry
   * handle the editor placed goes back to the placement's). */
  async fitToHand (c: Character, g: Gear): Promise<void> {
    const points = this.inHand(g) ? this.pointsOf(g) : null
    const held = points === null ? null : this.heldShape(g, points)
    if (held === null) { app.toast('error', `${g.name}: nothing to fit (it needs a hand with fingers, and to be on stage)`); return }
    const place = placementFromMatrix(fitMatrix(held.shape, held.hand, this.placeOf(g).scale))
    const carry = carryHandle(g)
    await app.do(c.id, [
      { type: 'gear.place', id: g.id, place },
      ...(carry?.place !== undefined ? [{ type: 'gear.handle.update' as const, gear: g.id, id: carry.id, patch: { place: null } }] : []),
    ], 'gear.fit')
  }

  /**
   * An upload just worn: an origin far off the piece (a piece modelled in place on a character, its origin at the
   * feet) moved onto it (a hand piece: its grip; else its middle), and a hand piece put into the fist unless it is in
   * it already (modelled there). One undo, offered in the toast.
   */
  private async settle (characterId: string, gearId: string): Promise<void> {
    const c = app.byId(characterId)
    const g = c === null ? undefined : gearById(c, gearId)
    const view = this.rider?.view
    const points = g === undefined ? null : this.pointsOf(g)
    if (c === null || g === undefined || view === undefined || points === null || points.length < 3) return
    const place = this.placeOf(g)
    const P = placementMatrix(place)
    const off = offBox(points, new THREE.Vector3()) * place.scale
    const held = this.inHand(g) ? this.heldShape(g, points) : null
    const already = held === null ? null : inFist(held.shape, P, held.hand, view.height)
    let at: THREE.Vector3 | null = null
    let where = ''
    if (off > OFF_PIECE * view.height) {
      at = already ?? held?.shape.grip ?? restPoints(points, P).middle
      where = held !== null ? 'its grip' : 'its middle'
    }
    const commands: Command[] = []
    const was = originOf(g)
    if (at !== null) commands.push({ type: 'gear.origin', id: g.id, origin: [r6(was[0] + at.x), r6(was[1] + at.y), r6(was[2] + at.z)] })
    if (held !== null && already === null) {
      // (the fit in its frame as the origin leaves it)
      const shift = at === null ? new THREE.Vector3() : new THREE.Vector3(r6(was[0] + at.x) - was[0], r6(was[1] + at.y) - was[1], r6(was[2] + at.z) - was[2])
      const shape = { ...held.shape, center: held.shape.center.clone().sub(shift), grip: held.shape.grip.clone().sub(shift) }
      commands.push({ type: 'gear.place', id: g.id, place: placementFromMatrix(fitMatrix(shape, held.hand, place.scale)) })
    }
    if (commands.length === 0) return
    const entry = await app.do(c.id, commands, 'gear.settle')
    if (entry === null) return
    const side = g.attach.kind === 'bone' ? handSide(g.attach.bone) : null
    const said = [
      ...(at !== null ? [`origin moved to ${where} (the file's was ${Math.round(off / view.height * 100)}% of the body's height off it)`] : []),
      ...(held !== null && already === null ? [`fitted into the ${side?.toLowerCase() ?? ''} hand`] : []),
      ...(held !== null && already !== null ? ['kept in the hand as it was modelled'] : []),
    ]
    app.toast('ok', `${g.name}: ${said.join('; ')}.`, 10000, { label: 'Undo', run: () => { void app.undo(c.id, entry.seq) } })
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
    const worn = this.shownPiece(g.id)?.worn
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
    const worn = this.shownPiece(g.id)?.worn
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
      const worn = this.shownPiece(g.id)?.worn
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
    const worn = this.shownPiece(gearId)?.worn
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

/** Whether a worn piece hides some of the body under it (what hideBodyUnder must hear about). */
const hidesBody = (worn: Worn | null): boolean => worn !== null && ((worn.hidden?.length ?? 0) > 0 || (worn.hidden === undefined && (worn.hides?.length ?? 0) > 0))

/** Where a skin piece's derived data (workers/derive.ts) is kept: its folder's derived/ (server/routes/derived.ts). */
function derivedStore (characterId: string, gearId: string): DerivedStore {
  const at = (name: string): string => `/api/characters/${encodeURIComponent(characterId)}/garments/${encodeURIComponent(gearId)}/derived/${name}`
  return {
    get: async (name) => {
      const res = await fetch(at(name))
      return res.ok ? await res.arrayBuffer() : null
    },
    put: async (name, data) => {
      const res = await fetch(at(name), { method: 'PUT', headers: { 'x-rigsmith': '1', 'content-type': 'application/octet-stream' }, body: data })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    },
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
const stopGear = gear.start()
// (a hot update of this module would otherwise leave the old one's hooks on the viewer: gear worn twice)
if (import.meta.hot !== undefined) import.meta.hot.dispose(() => { stopGear() })
