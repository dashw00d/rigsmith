// The viewport's 3D side (DESIGN.md §4.5): it puts the selected character's file on the stage (and the horse it
// rides, with the rider seated on it) and knows nothing about the areas. Each area subscribes instead: onLoad hooks
// set themselves up on the loaded view in a fixed order (gear 10, motion 20, skeleton/skin/look/hands 30, ship 40) and
// hand back their cleanup; onSync hooks hear every later change of the step or of the character; onMountLoad hooks
// do the same for the horse; overlays are registered by key and drawn by the Viewport. So the joint editor, the gear,
// the animator, the painter and the seat editor set up on whatever is loaded and tear down when it goes, in whatever
// order things happen.
import { untrack, type Component } from 'svelte'
import * as THREE from 'three'
import { CharacterView, type DisplayMode } from '../engine/CharacterView.ts'
import { riderScale, seatMatrix } from '../engine/mount.ts'
import { Stage } from '../engine/Stage.ts'
import { shownFile } from '../app/status.ts'
import type { Character } from './api.ts'
import { app, type Step } from './app.svelte.ts'
import { asset, assets } from './assets.svelte.ts'

export type { DisplayMode }

type Cleanup = void | (() => void)
/** Set up on a loaded view; the cleanup it returns runs when the view goes. Returning a promise makes the hooks after
 * it wait (gear's pieces are on the bones before the animator bakes their tracks). */
export type LoadHook = (view: CharacterView, c: Character) => Cleanup | Promise<Cleanup>
export type SyncHook = (view: CharacterView, c: Character, step: Step) => void
/** The horse on stage: its view, the group the rider's root sits in (the seat editor moves it), its character. */
export interface MountView { view: CharacterView, seat: THREE.Group, character: Character }
export type MountHook = (mount: MountView, rider: Character) => Cleanup | Promise<Cleanup>
/** Something drawn over the viewport (or, `dock: 'bottom'`, under it). `covers`: it hides the whole stage, which then
 * stops drawing; `blocksInput`: the canvas takes no pointer input while it shows. */
export interface Overlay {
  // (any component: each overlay's props are its own)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: Component<any>
  props?: Record<string, unknown>
  covers?: boolean
  blocksInput?: boolean
  dock?: 'bottom'
}
/** The game's heights (game units) of a rider and his horse, when their units say them (Ship registers the getter). */
export interface Heights { rider: number | null, horse: number | null }
export type HeightsGetter = (rider: Character, horse: Character) => Heights | Promise<Heights>

interface Want { c: Character | null, horse: Character | null, step: Step }
interface Loaded { view: CharacterView, c: Character, url: string, ready: boolean }
interface Mounted { url: string, bone: string, frame: THREE.Group, ready: boolean }

const NO_HEIGHTS: Heights = { rider: null, horse: null }

function report (what: string, error: unknown): void {
  console.error(`viewer: ${what} failed`, error)
}

class Viewer {
  /** The stage (null until the Viewport mounts). */
  stage = $state.raw<Stage | null>(null)
  /** The character's view on stage (null: none loaded). */
  character = $state.raw<CharacterView | null>(null)
  /** The id of the character on stage (the selection may have moved on while the next one loads). */
  shownId = $state<string | null>(null)
  /** The horse the character on stage rides, seated (null: it doesn't, or the horse isn't loaded). */
  mount = $state.raw<MountView | null>(null)
  mode = $state<DisplayMode>('shaded')
  /** Bone lines drawn over the model. */
  skeleton = $state(false)
  /** A model (or its horse) is loading, or the areas are still setting up on it. */
  loading = $state(false)
  /** Why the model (or its horse) didn't load or can't be shown; null when all is well. */
  loadError = $state<string | null>(null)
  /** Overlays by key, in the order they were first set. */
  overlays = $state.raw<Array<[string, Overlay]>>([])

  private loadHooks: Array<{ fn: LoadHook, order: number }> = []
  private syncHooks = new Set<SyncHook>()
  private mountHooks = new Set<MountHook>()
  private unmountHooks = new Set<(mount: MountView) => void>()
  private loaded: Loaded | null = null
  private mounted: Mounted | null = null
  /** While a clip is edited: the horse's own place before the rider was stood in his own space (setEditingRider). */
  private standing: THREE.Matrix4 | null = null
  // (what each hook gave back for the view, and the horse, on stage now)
  private hookCleanups = new Map<LoadHook, () => void>()
  private mountCleanups = new Map<MountHook, () => void>()
  private want: Want = { c: null, horse: null, step: 'import' }
  private synced: { c: Character, step: Step } | null = null
  private running = false
  private again = false
  private forceReload = false
  // (a file that failed to load isn't tried again on every change of the character; reload() does)
  private failedUrl: string | null = null
  private framedId: string | null = null
  private seatProblem = false
  private heights: HeightsGetter | null = null
  private heightCache = new Map<string, Promise<Heights>>()
  private stopEffects: (() => void) | null = null

  // ---- the stage ------------------------------------------------------------------------------------------------

  /** Make the stage in `container` and follow the selection and the step from now on. Returns the teardown. */
  attach (container: HTMLElement): () => void {
    const stage = new Stage(container)
    this.stage = stage
    stage.covered = untrack(() => this.overlays).some(([, o]) => o.covers === true)
    this.stopEffects = $effect.root(() => {
      $effect(() => {
        const c = app.selected
        const horseId = c?.mount?.character
        // (the horse's own changes count too: a re-rig or a resize of it seats the rider again)
        const horse = horseId === undefined ? null : app.byId(horseId)
        const step = app.step
        // (their files: a file changed on disk loads again, a document change that left the files alone doesn't)
        if (c !== null) void assets.manifestOf(c.id)
        if (horse !== null) void assets.manifestOf(horse.id)
        // (the game's heights may have changed with its units)
        void app.gameBeat
        untrack(() => { this.request({ c, horse, step }) })
      })
    })
    return () => {
      this.stopEffects?.()
      this.stopEffects = null
      this.unload()
      stage.dispose()
      this.stage = null
      this.framedId = null
    }
  }

  // ---- what areas hook into -------------------------------------------------------------------------------------

  /** Run `fn` on every view loaded from now on (at once on the one on stage), lower `order` first. Returns its
   * removal, which also runs its cleanup for the view on stage. */
  onLoad (fn: LoadHook, order = 30): () => void {
    this.loadHooks.push({ fn, order })
    this.loadHooks.sort((a, b) => a.order - b.order)
    // (a view still setting up runs it in its turn)
    const now = this.loaded
    if (now?.ready === true) void this.runLoadHook(fn, now)
    return () => {
      this.loadHooks = this.loadHooks.filter(h => h.fn !== fn)
      this.dropCleanup(this.hookCleanups, fn)
    }
  }

  /** Run `fn` once a view is set up, and whenever the step or the character on stage changes after (a new version,
   * or this page's own change before the server confirms it). At once if a view is set up now. */
  onSync (fn: SyncHook): () => void {
    this.syncHooks.add(fn)
    const now = this.loaded
    if (now?.ready === true) {
      try { fn(now.view, now.c, this.want.step) } catch (error) { report('a sync hook', error) }
    }
    return () => { this.syncHooks.delete(fn) }
  }

  /** Run `fn` on every horse seated from now on (at once on the one seated now). Its cleanup runs when the horse
   * goes. */
  onMountLoad (fn: MountHook): () => void {
    this.mountHooks.add(fn)
    const mount = this.mount
    if (mount !== null && this.mounted?.ready === true && this.loaded !== null) void this.runMountHook(fn, mount, this.loaded.c)
    return () => {
      this.mountHooks.delete(fn)
      this.dropCleanup(this.mountCleanups, fn)
    }
  }

  /** Hear a horse go (before the rider gets off it). */
  onMountUnload (fn: (mount: MountView) => void): () => void {
    this.unmountHooks.add(fn)
    return () => { this.unmountHooks.delete(fn) }
  }

  /** Where the rider's and the horse's game heights come from (Ship's units; asked again when the game's units
   * change); null: their own sizes and the mount's scale. Returns its removal. */
  setHeights (fn: HeightsGetter | null): () => void {
    this.heights = fn
    this.heightCache.clear()
    void this.reseat()
    return () => {
      if (this.heights !== fn) return
      this.heights = null
      this.heightCache.clear()
      void this.reseat()
    }
  }

  /** Draw `o` over the viewport under `key` (null takes it off). Setting a key again replaces it in place. */
  setOverlay (key: string, o: Overlay | null): void {
    const list = untrack(() => this.overlays)
    const at = list.findIndex(([k]) => k === key)
    if (o === null && at < 0) return
    const next: Array<[string, Overlay]> = o === null ? list.filter(([k]) => k !== key) : at >= 0 ? list.with(at, [key, o]) : [...list, [key, o]]
    this.overlays = next
    // (from the list just made: reading the state back would make an effect that sets an overlay depend on them all)
    const stage = untrack(() => this.stage)
    if (stage !== null) stage.covered = next.some(([, x]) => x.covers === true)
  }

  // ---- display ------------------------------------------------------------------------------------------------

  setMode (mode: DisplayMode): void {
    this.mode = mode
    untrack(() => {
      this.character?.setMode(mode)
      this.mount?.view.setMode(mode)
    })
  }

  setSkeleton (visible: boolean): void {
    this.skeleton = visible
    untrack(() => { if (this.stage !== null) this.character?.showSkeleton(this.stage, visible) })
  }

  /** Frame the character (and the horse it sits on). */
  focus (): void {
    const stage = untrack(() => this.stage)
    const view = untrack(() => this.character)
    if (stage === null || view === null) return
    stage.frame(this.mounted === null ? view.box : new THREE.Box3().setFromObject(stage.content))
  }

  /** Load the character's file again (after it failed to). */
  reload (): void {
    this.forceReload = true
    this.failedUrl = null
    this.request(this.want)
  }

  // ---- loading ------------------------------------------------------------------------------------------------

  /** The newest wish wins; one sync runs at a time (a model that finishes loading after the selection moved on is
   * dropped). */
  private request (want: Want): void {
    this.want = want
    if (this.running) { this.again = true; return }
    this.running = true
    void (async () => {
      try {
        do {
          this.again = false
          try { await this.sync(this.want) } catch (error) { report('a sync', error) }
        } while (this.again)
      } finally {
        this.running = false
      }
    })()
  }

  private stale (want: Want): boolean { return this.want !== want || this.again }

  private async sync (want: Want): Promise<void> {
    const stage = this.stage
    if (stage === null) return
    const c = want.c
    // (its files' hashes first, so the model loads once, by what it holds)
    if (c !== null && !assets.ready(c.id)) {
      await assets.load(c.id)
      if (this.stale(want)) return
    }
    const url = c === null ? null : asset(c, shownFile(c))
    if (url !== (this.loaded?.url ?? null) || this.forceReload) {
      if (url !== null && url === this.failedUrl && !this.forceReload && this.loaded === null) return
      this.forceReload = false
      this.unload()
      if (c === null || url === null) {
        // (nothing to show: none selected, still importing, or an animation file)
        this.loading = false
        this.loadError = null
        this.failedUrl = null
        return
      }
      if (!await this.load(stage, c, url, want)) return
    }
    const now = this.loaded
    if (now === null || c === null) return
    now.c = c
    await this.syncMount(stage, now, want)
    if (this.stale(want) || this.loaded !== now) return
    // (a load overtaken by a newer copy of the same character left it on: this sync finished what it started)
    this.loading = false
    if (this.synced?.c !== c || this.synced.step !== want.step) {
      this.synced = { c, step: want.step }
      for (const fn of [...this.syncHooks]) {
        try { fn(now.view, c, want.step) } catch (error) { report('a sync hook', error) }
      }
    }
  }

  /** The view loaded, put on stage and handed to the hooks in order. False when it failed or was overtaken. */
  private async load (stage: Stage, c: Character, url: string, want: Want): Promise<boolean> {
    this.loading = true
    this.loadError = null
    let view: CharacterView
    try {
      view = await CharacterView.load(url)
    } catch (error) {
      if (!this.stale(want)) {
        this.failedUrl = url
        this.loadError = `${c.name}'s model didn't load: ${(error as Error).message}`
        this.loading = false
      }
      return false
    }
    if (this.stale(want) || this.stage !== stage) { view.dispose(); return false }
    this.failedUrl = null
    view.addTo(stage)
    // (the same character's file again (a new rig, a resize) keeps the camera where the user put it)
    if (this.framedId !== c.id) stage.frame(view.box, true)
    this.framedId = c.id
    view.setMode(this.mode)
    view.showSkeleton(stage, this.skeleton)
    const loaded: Loaded = { view, c, url, ready: false }
    this.loaded = loaded
    this.character = view
    this.shownId = c.id
    this.synced = null
    // (lowest order first; a hook registered meanwhile takes its turn too)
    const ran = new Set<LoadHook>()
    for (let next = this.loadHooks.find(h => !ran.has(h.fn)); next !== undefined; next = this.loadHooks.find(h => !ran.has(h.fn))) {
      ran.add(next.fn)
      await this.runLoadHook(next.fn, loaded)
      if (this.loaded !== loaded) return false
    }
    loaded.ready = true
    if (!this.stale(want)) this.loading = false
    return true
  }

  private async runLoadHook (fn: LoadHook, loaded: Loaded): Promise<void> {
    try {
      const cleanup = await fn(loaded.view, loaded.c)
      if (typeof cleanup !== 'function') return
      // (the view went, or the hook was removed, while it set up: undone at once)
      if (this.loaded !== loaded || !this.loadHooks.some(h => h.fn === fn)) { this.safely(cleanup); return }
      this.hookCleanups.set(fn, cleanup)
    } catch (error) {
      report('a load hook', error)
    }
  }

  /** Everything off the stage: the horse (its hooks, then the rider back on the ground), then the view's hooks (last
   * set up, first undone), then the view itself. */
  private unload (): void {
    this.unseat()
    const loaded = this.loaded
    if (loaded === null) return
    this.loaded = null
    this.synced = null
    for (const { fn } of [...this.loadHooks].reverse()) this.dropCleanup(this.hookCleanups, fn)
    // (and any whose hook was removed without its cleanup running)
    for (const fn of [...this.hookCleanups.keys()]) this.dropCleanup(this.hookCleanups, fn)
    loaded.view.dispose(this.stage ?? undefined)
    this.character = null
    this.shownId = null
    this.loading = false
  }

  private dropCleanup<K> (map: Map<K, () => void>, key: K): void {
    const cleanup = map.get(key)
    if (cleanup === undefined) return
    map.delete(key)
    this.safely(cleanup)
  }

  private safely (fn: () => void): void {
    try { fn() } catch (error) { report('a cleanup', error) }
  }

  // ---- the horse ----------------------------------------------------------------------------------------------

  /** Seat the rider on his horse (or take him off): the horse loaded beside him, his root in the seat on its bone. */
  private async syncMount (stage: Stage, rider: Loaded, want: Want): Promise<void> {
    const m = rider.c.mount
    const horse = m === undefined ? null : want.horse
    if (horse !== null && !assets.ready(horse.id)) {
      await assets.load(horse.id)
      if (this.stale(want)) return
    }
    const url = horse === null ? null : asset(horse, shownFile(horse))
    if (url !== (this.mounted?.url ?? null)) {
      this.unseat()
      if (m === undefined || horse === null || url === null) return
      if (url === this.failedUrl) return
      this.loading = true
      let view: CharacterView
      try {
        view = await CharacterView.load(url)
      } catch (error) {
        if (!this.stale(want)) {
          this.failedUrl = url
          this.loadError = `The horse ${horse.name} didn't load: ${(error as Error).message}`
          this.loading = false
        }
        return
      }
      if (this.stale(want) || this.loaded !== rider) { view.dispose(); return }
      stage.content.add(view.root)
      view.setMode(this.mode)
      stage.setSubjectSize(Math.max(view.height, rider.view.height))
      const frame = new THREE.Group()
      frame.name = 'mount_seat_frame'
      const seat = new THREE.Group()
      seat.name = 'mount_seat'
      frame.add(seat)
      const mounted: Mounted = { url, bone: '', frame, ready: false }
      const mount: MountView = { view, seat, character: horse }
      this.mounted = mounted
      this.mount = mount
      const seated = this.perch(m.bone, rider)
      await this.reseat()
      if (this.mounted !== mounted) return
      if (seated) stage.frame(new THREE.Box3().setFromObject(stage.content), true)
      for (const fn of [...this.mountHooks]) {
        await this.runMountHook(fn, mount, rider.c)
        if (this.mounted !== mounted) return
      }
      mounted.ready = true
      if (!this.stale(want)) this.loading = false
      return
    }
    const mounted = this.mounted
    const mount = this.mount
    if (m === undefined || mounted === null || mount === null) return
    // (the horse's latest copy: what it wears, its look)
    if (horse !== null && horse !== mount.character) this.mount = { ...mount, character: horse }
    if (mounted.bone !== m.bone) this.perch(m.bone, rider)
    await this.reseat()
  }

  /** The seat hung on the horse's `bone` (its rest frame undone, so the rider's placement is in that bone's rest
   * space), the rider's root in it. False (and said) when the horse has no such bone. */
  private perch (bone: string, rider: Loaded): boolean {
    const mount = this.mount
    const mounted = this.mounted
    if (mount === null || mounted === null) return false
    const node = mount.view.bones.get(bone)
    mounted.bone = bone
    if (node === undefined) {
      this.seatProblem = true
      this.loadError = `${mount.character.name} has no bone ${bone} to sit on`
      return false
    }
    if (this.seatProblem) { this.seatProblem = false; this.loadError = null }
    const rest = mount.view.rest?.bones.get(bone)
    const at = rest === undefined ? node.matrixWorld.clone() : new THREE.Matrix4().compose(rest.worldPosition, rest.worldQuaternion, new THREE.Vector3(1, 1, 1))
    mounted.frame.removeFromParent()
    mounted.frame.position.set(0, 0, 0)
    mounted.frame.quaternion.identity()
    mounted.frame.scale.set(1, 1, 1)
    mounted.frame.applyMatrix4(at.invert())
    node.add(mounted.frame)
    // (stood in his own space while a clip is edited: seated again when the editor closes)
    if (this.standing === null) mount.seat.add(rider.view.root)
    return true
  }

  /** While a clip is edited the rider stands in his own space, as the editor's working
   * copy does, so its goals, keys and gizmo are all in one frame (seated, everything the gizmo moved landed off by the
   * seat, which the horse's animation moves: a dragged spear keyed a seat's height up, the hand flung after it; the
   * designer, 2026-10-28). The horse is shown under him where it was. Off: back in the saddle. */
  setEditingRider (on: boolean): void {
    const stage = this.stage; const rider = this.loaded?.view; const mount = untrack(() => this.mount)
    if (stage === null || rider === undefined || mount === null) { if (!on) this.standing = null; return }
    const horse = mount.view.root
    if (on) {
      if (this.standing !== null || rider.root.parent !== mount.seat) return
      stage.content.updateMatrixWorld(true)
      const seated = stage.content.matrixWorld.clone().invert().multiply(rider.root.matrixWorld)
      horse.updateMatrix()
      this.standing = horse.matrix.clone()
      seated.invert().multiply(this.standing).decompose(horse.position, horse.quaternion, horse.scale)
      stage.content.add(rider.root)
      rider.root.position.set(0, 0, 0); rider.root.quaternion.identity(); rider.root.scale.set(1, 1, 1)
      stage.content.updateMatrixWorld(true)
      return
    }
    if (this.standing === null) return
    this.standing.decompose(horse.position, horse.quaternion, horse.scale)
    this.standing = null
    mount.seat.add(rider.root)
    rider.root.position.set(0, 0, 0); rider.root.quaternion.identity(); rider.root.scale.set(1, 1, 1)
    stage.content.updateMatrixWorld(true)
  }

  /** The seat placed: the rider's placement, at his size against the horse (the game's heights when Ship has them). */
  private async reseat (): Promise<void> {
    const loaded = this.loaded
    const mounted = this.mounted
    const mount = untrack(() => this.mount)
    const m = loaded?.c.mount
    if (loaded === null || mounted === null || mount === null || m === undefined) return
    const h = await this.heightsOf(loaded.c, mount.character)
    if (this.loaded !== loaded || this.mounted !== mounted) return
    const k = riderScale(m, { game: h.rider, own: loaded.view.height }, { game: h.horse, own: mount.view.height })
    seatMatrix(m, k).decompose(mount.seat.position, mount.seat.quaternion, mount.seat.scale)
  }

  private async heightsOf (rider: Character, horse: Character): Promise<Heights> {
    const get = this.heights
    if (get === null) return NO_HEIGHTS
    const key = `${rider.id}|${horse.id}|${untrack(() => app.gameBeat)}`
    let pending = this.heightCache.get(key)
    if (pending === undefined) {
      pending = Promise.resolve().then(async () => await get(rider, horse)).catch((error: unknown) => { report('the heights getter', error); return NO_HEIGHTS })
      this.heightCache.set(key, pending)
    }
    return await pending
  }

  private async runMountHook (fn: MountHook, mount: MountView, rider: Character): Promise<void> {
    const mounted = this.mounted
    try {
      const cleanup = await fn(mount, rider)
      if (typeof cleanup !== 'function') return
      if (this.mounted !== mounted || !this.mountHooks.has(fn)) { this.safely(cleanup); return }
      this.mountCleanups.set(fn, cleanup)
    } catch (error) {
      report('a mount hook', error)
    }
  }

  /** The horse off stage: its hooks undone, the rider back on the ground where he was. */
  private unseat (): void {
    const mount = untrack(() => this.mount)
    const mounted = this.mounted
    if (mounted === null) return
    this.mount = null
    this.mounted = null
    this.standing = null
    if (mount !== null) {
      for (const fn of [...this.unmountHooks]) {
        try { fn(mount) } catch (error) { report('a mount unload hook', error) }
      }
    }
    for (const fn of [...this.mountCleanups.keys()]) this.dropCleanup(this.mountCleanups, fn)
    const rider = this.loaded?.view
    const stage = this.stage
    if (rider !== undefined && stage !== null && rider.root.parent !== stage.content) {
      stage.content.add(rider.root)
      rider.root.position.set(0, 0, 0)
      rider.root.quaternion.identity()
      rider.root.scale.set(1, 1, 1)
      stage.setSubjectSize(rider.height)
    }
    mounted.frame.removeFromParent()
    if (this.seatProblem) { this.seatProblem = false; this.loadError = null }
    mount?.view.dispose(stage ?? undefined)
  }
}

export const viewer = new Viewer()
