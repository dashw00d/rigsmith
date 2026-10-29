// Playback in the viewport (DESIGN.md §4.6): a slot as the game plays it (src/engine/bake.ts bakeSlot, the bake the unit
// export runs too), a library clip previewed on the character (an ephemeral slot stood on the floor by its feet), a
// rig test, or a clip another area shows (a hand pose). It sets itself up on the viewer's character as it loads
// (viewer.onLoad, after the gear, whose nodes the bake gives tracks), plays a rider's horse under him (its slot of the
// same name, else its Idle: bakeRide), replays what plays when the character it is baked from changes (a pose edit is
// a command like any other: the slot is baked again, the pose dragged held on stage until it plays), and stops when the
// step has no use for it. The timeline is docked under the viewport while anything plays; its loop region and its
// preview into Idle (the clip, then the character's Idle blended in as the game blends) are the player's. Also the
// library cards' sprite previews.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { untrack } from 'svelte'
import type { Character, ClipRef, HandPose, LibraryClip, Slot } from './api.ts'
import type { Rom } from '../engine/limits.ts'
import { app, type Step } from './app.svelte.ts'
import { viewer, type MountView } from './viewer.svelte.ts'
import { gizmo } from './gizmo.svelte.ts'
import { stableJson } from '../model/entities.ts'
import { gearKeysFromPaths, gearTracksOf, slotById } from '../model/select.ts'
import { slotsUnder } from '../model/pieces.ts'
import { forgetComposites } from '../engine/pieces.ts'
import type { CharacterView } from '../engine/CharacterView.ts'
import { forgetClip, RetargetCache, type ClipSource } from '../engine/clips.ts'
import { bakeRide, bakeSlot, boneRest, type BakeContext, type BakedSlot, type BakeSkip, type PullPlan } from '../engine/bake.ts'
import { freezeClip } from '../engine/mount.ts'
import { Player } from '../engine/Player.ts'
import { PreviewRenderer } from '../engine/PreviewRenderer.ts'
import { renamer } from '../engine/presets/skeletonMap.ts'
import { tickPulls } from '../engine/pulls.ts'
import type { Stage } from '../engine/Stage.ts'
import { clipRefOf, defaultInPlace, FPS, phaseIn } from '../app/motion/rules.ts'
import Timeline from '../app/motion/Timeline.svelte'

const MANNEQUIN = '/files/library/mannequin/ybot.glb'

/** Seconds the game blends one clip into the next (Emberhold's AnimationPlayer blend): the preview into Idle's. */
export const BLEND = 0.2
/** How long the preview into Idle plays the Idle before the clip again. */
const IDLE_FOR = 1.2

/** The joints' ranges by rig ('human', a creature template), fetched once a page: the bake's build keeps to them
 * (BakeContext.rom), as the export's does (tools/lib/node3d.ts nodeRom reads the same files). */
const roms = new Map<string, Promise<Rom | null>>()
function romOf (rig: string): Promise<Rom | null> {
  let p = roms.get(rig)
  if (p === undefined) {
    p = fetch(`/templates/rom/${rig}.json`).then(async r => (r.ok ? await r.json() as Rom : null)).catch(() => null)
    roms.set(rig, p)
    void p.then(v => { if (v === null) roms.delete(rig) })
  }
  return p
}

/** What plays: one of the character's slots, a library clip previewed, a rig test, or a clip shown by another area. */
export type PlayKind = 'slot' | 'library' | 'test' | 'clip'

export class NowPlaying {
  readonly kind: PlayKind
  readonly characterId: string
  /** The slot (kind 'slot'). */
  readonly slotId: string | null
  /** A library preview's clip. */
  readonly library: LibraryClip | null
  /** A preview's or a test's clip. */
  readonly ref: ClipRef | null
  label = $state('')
  /** As baked (null while it bakes, and for another area's clip). */
  baked = $state.raw<BakedSlot | null>(null)
  /** The pulls held (baked.pulls, or what another area's clip holds). */
  pulls = $state.raw<PullPlan[] | null>(null)
  /** A ridden loop holds this many of the slot's own cycles (fitted to the horse's gait). */
  cycles = $state(1)
  /** Where it is: the phase of the slot's own clip (within one ridden cycle) and the time in the clip playing. */
  phase = $state(0)
  time = $state(0)
  /** A library preview's in place (the timeline's preview toggle; a slot has its own, saved). */
  inPlace = $state(false)
  /** The slot's saved loop when it was last baked: the preview's loop follows it when it changes. */
  savedLoop: boolean | null = null

  constructor (o: { kind: PlayKind, characterId: string, label: string, slotId?: string | null, library?: LibraryClip | null, ref?: ClipRef | null }) {
    this.kind = o.kind
    this.characterId = o.characterId
    this.slotId = o.slotId ?? null
    this.library = o.library ?? null
    this.ref = o.ref ?? null
    this.label = o.label
  }
}

/** The steps a playing clip stays on in: gear, motion and ship; the skeleton and skin steps keep a rig test playing. */
function keeps (step: Step, now: NowPlaying): boolean {
  if (step === 'gear' || step === 'motion' || step === 'ship') return true
  return (step === 'skeleton' || step === 'skin') && now.kind === 'test'
}

interface Horse { mount: MountView, player: Player, cache: RetargetCache, posable: THREE.Object3D | null }

class Animator {
  playing = $state.raw<NowPlaying | null>(null)
  /** The clip runs (false: paused on a frame). */
  running = $state(true)
  /** The time in the clip playing, and its length (seconds of the clip as it plays: its speed is in it). */
  time = $state(0)
  duration = $state(0)
  loading = $state(false)
  error = $state<string | null>(null)
  // Preview only: what the timeline's toggles change never changes what is saved or what the game gets.
  speed = $state(1)
  loop = $state(true)
  mirror = $state(false)
  previewSubject = $state<'character' | 'mannequin' | 'none'>('none')
  /** Bumped when previews are rendered for another subject; cards ask for their sheet again. */
  previewVersion = $state(0)

  /** While a joint or a piece is dragged, and until the slot baked with its keys plays, the clip doesn't drive the
   * bones (the drag's pose stays on stage). */
  holding = false
  /** A loop region of the timeline (phases of one cycle of what plays): playing, it runs round inside it. */
  region = $state.raw<[number, number] | null>(null)
  /** The preview into Idle: a clip that plays once is followed by the character's Idle, blended in over BLEND seconds
   * as the game does, and then plays again. */
  intoIdle = $state(false)
  /** Playing the Idle after the clip (the preview into Idle). */
  inIdle = $state(false)

  private shown: CharacterView | null = null
  private stageRef: Stage | null = null
  private characterId: string | null = null
  private player: Player | null = null
  private cache: RetargetCache | null = null
  private posable: THREE.Object3D | null = null
  private posableKey = ''
  private horse: Horse | null = null
  private offs: Array<() => void> = []
  private ticks = new Set<(phase: number, time: number) => void>()
  private token = 0
  // (what the clip playing was baked from, to replay it when that changes; and the bone map the view was read with)
  private signature = ''
  private boneMap = ''
  private installed: Array<() => void> = []
  private previews: PreviewRenderer | null = null
  private mannequin: Promise<THREE.Object3D | null> | null = null
  private lastKey = ''
  private closing = false
  /** The Idle the preview into Idle blends to (baked once a slot set: by the Idle slot's bake inputs). */
  private idle: { key: string, clip: THREE.AnimationClip } | null = null
  private idleAction: THREE.AnimationAction | null = null
  private idleTime = 0

  /** Hook into the viewer (once, at start). */
  install (): void {
    if (this.installed.length > 0) return
    this.installed = [
      viewer.onLoad((view, c) => { this.attach(view, c); return () => { this.detach() } }, 20),
      viewer.onSync((_view, c, step) => { untrack(() => { this.sync(c, step) }) }),
    ]
  }

  uninstall (): void {
    this.closing = true
    try {
      for (const off of this.installed.splice(0)) off()
    } finally {
      this.closing = false
    }
  }

  // ---- what is loaded ------------------------------------------------------------------------------------------

  /** The character's view on stage (null: none, or it has no skeleton). */
  get view (): CharacterView | null { return this.shown }
  /** The same (the name older callers use). */
  get character (): CharacterView | null { return this.shown }
  get stage (): Stage | null { return this.stageRef }
  /** The clips, retargeted onto the character on stage (shared: the bake, hand poses and fists all ask it). */
  get clipSource (): ClipSource | null { return this.cache }
  /** The clip on the player now. */
  get clip (): THREE.AnimationClip | null { return this.player?.clip ?? null }
  /** The ground lift of what plays (its ground adjustment, plus a preview's fit to the floor). */
  get lift (): number { return this.playing?.baked?.lift ?? 0 }
  get ready (): boolean { return this.player !== null }

  private attach (view: CharacterView, c: Character): void {
    this.detach()
    const stage = viewer.stage
    if (view.rest === null || stage === null) {
      this.usePreviewSubject()
      return
    }
    this.shown = view
    this.stageRef = stage
    this.characterId = c.id
    this.boneMap = stableJson(c.skeleton.boneMap ?? null)
    view.setRename(renamer(c.skeleton.boneMap))
    this.player = new Player(view.root)
    this.player.setSpeed(this.speed)
    this.player.setLoop(this.loop)
    this.player.setPlaying(this.running)
    this.cache = new RetargetCache(view.rest!)
    this.offs = [
      stage.onFrame(dt => { this.frame(dt) }),
      viewer.onMountLoad(mount => { this.useHorse(mount); return () => { this.dropHorse() } }),
    ]
    this.usePreviewSubject()
  }

  private detach (): void {
    this.token++
    for (const off of this.offs.splice(0)) off()
    this.dropHorse(false)
    this.player?.dispose()
    this.player = null
    this.cache = null
    this.shown = null
    this.stageRef = null
    this.characterId = null
    this.posable = null
    this.holding = false
    this.setNow(null)
    this.duration = 0
    this.time = 0
    this.setLoading(false)
    tickPulls(null, 0)
    this.usePreviewSubject()
  }

  /** The step or the character changed: stop when the step has no use for what plays; replay it where it was when what
   * it is baked from changed (a slot's adjustments, its gear, its hands). */
  private sync (c: Character, step: Step): void {
    if (c.id !== this.characterId || this.shown === null) return
    const now = untrack(() => this.playing)
    if (now !== null && !keeps(step, now)) { this.halt(); return }
    if (stableJson(c.skeleton.boneMap ?? null) !== this.boneMap) { this.rebind(); return }
    if (now === null || now.kind === 'clip' || now.baked === null) return
    if (now.kind === 'slot' && slotById(c, now.slotId ?? '') === undefined) { this.halt(); return }
    if (this.inputs(now, c) !== this.signature) void this.run(now, true)
  }

  /** What a bake of `now` depends on in the character, as one string. */
  private inputs (now: NowPlaying, c: Character): string {
    const slot = now.kind === 'slot' ? slotById(c, now.slotId ?? '') : undefined
    // (what its bake reads of the other slots: the one it paces like, those it plays as pieces, theirs in turn)
    const under = slot === undefined ? [] : slotsUnder(c, slot)
    return stableJson({ slot, under, gear: c.gear, hands: c.hands, mount: c.mount, shared: app.settings?.handPoses ?? null })
  }

  // ---- what plays --------------------------------------------------------------------------------------------------

  /** Play one of the character's slots as the game plays it. `keepTime`: from where the slot playing is now. */
  async playSlot (character: Character, slotId: string, o: { keepTime?: boolean } = {}): Promise<boolean> {
    const slot = slotById(character, slotId)
    if (slot === undefined || character.id !== this.characterId) return false
    const was = untrack(() => this.playing)
    const again = o.keepTime === true && was?.kind === 'slot' && was.slotId === slotId
    if (!again) { this.resetPreview(slot.loop); this.region = null }
    const now = again ? was : new NowPlaying({ kind: 'slot', characterId: character.id, slotId, label: slot.name })
    if (!again) now.savedLoop = slot.loop
    return await this.run(now, again)
  }

  /** Preview a library clip on the character (stood on the floor by its feet; its gear paths played). */
  async playLibrary (clip: LibraryClip): Promise<boolean> {
    const id = this.characterId
    if (id === null) return false
    this.resetPreview(clip.loop)
    this.region = null
    const now = new NowPlaying({ kind: 'library', characterId: id, label: clip.name, library: clip, ref: clipRefOf(clip) })
    now.inPlace = defaultInPlace(clip)
    return await this.run(now, false)
  }

  /** A test of the rig (static/templates/tests.json): a library clip that works its joints hard, in place, looped. */
  async playTest (test: { id: string, name: string, url?: string }): Promise<boolean> {
    const id = this.characterId
    if (id === null) return false
    this.resetPreview(true)
    this.region = null
    const now = new NowPlaying({ kind: 'test', characterId: id, label: test.name, ref: test.url === undefined ? { id: test.id } : { id: test.id, url: test.url } })
    now.inPlace = true
    return await this.run(now, false)
  }

  /** Show a clip made elsewhere (a hand pose's frame), paused at `time`. Not baked here: what it holds of pulls comes
   * with it. */
  showClip (clip: THREE.AnimationClip, o: { label: string, pulls?: PullPlan[] | null, time?: number }): void {
    const id = this.characterId
    if (this.player === null || id === null) return
    this.token++
    this.holding = false
    this.setLoading(false)
    const was = untrack(() => this.playing)
    const same = was !== null && was.kind === 'clip'
    const now = same ? was : new NowPlaying({ kind: 'clip', characterId: id, label: o.label })
    now.label = o.label
    now.baked = null
    now.cycles = 1
    now.pulls = o.pulls ?? null
    this.setNow(now)
    this.player.play(clip)
    this.duration = clip.duration
    this.setPlaying(false)
    this.seek(Math.min(Math.max(o.time ?? 0, 0), clip.duration))
  }

  /** Bake again what plays (the character changed under it), from where it is. */
  async refresh (keepTime = true): Promise<boolean> {
    const now = untrack(() => this.playing)
    if (now === null || now.kind === 'clip') return false
    return await this.run(now, keepTime)
  }

  /** Stop playing (the character back at rest; a rider seated). */
  async stop (): Promise<boolean> {
    this.halt()
    return true
  }

  /** A slot of `c` baked as it plays here (the context of the character on stage), without playing it: what the ground
   * fit, the blow and the holds are measured on. Null when `c` isn't the character on stage. */
  async bake (c: Character, slot: Slot, o: { skip?: BakeSkip, autoGround?: boolean } = {}): Promise<BakedSlot | null> {
    const ctx = c.id === this.characterId ? this.bakeContext() : null
    return ctx === null ? null : await bakeSlot(c, slot, ctx, o)
  }

  /** A clip's length (seconds at speed 1, as it plays on the character on stage): what a piece of it can last. */
  async clipSeconds (ref: ClipRef, inPlace: boolean): Promise<number | null> {
    if (this.cache === null) return null
    return (await this.cache.get(ref, { inPlace, fps: FPS })).duration
  }

  /** A posable copy of the character, at rest, with its gear nodes (copied again when its gear changed, or `fresh`):
   * clips are measured on it without moving the one on stage. */
  posableCopy (fresh = false): THREE.Object3D | null {
    const view = this.shown
    if (view === null) return null
    const nodes: string[] = []
    view.root.traverse(o => { if (o.name.endsWith('_place')) nodes.push(o.name) })
    const key = nodes.sort().join('|')
    if (fresh || this.posable === null || key !== this.posableKey) {
      const copy = cloneSkinned(view.root)
      copy.position.set(0, 0, 0)
      copy.quaternion.identity()
      copy.scale.set(1, 1, 1)
      // (copied while a clip plays: its bones back at rest)
      for (const b of view.rest?.bones.values() ?? []) {
        const o = copy.getObjectByName(b.node.name)
        if (o === undefined) continue
        o.position.copy(b.localPosition)
        o.quaternion.copy(b.localQuaternion)
        o.scale.copy(b.localScale)
      }
      copy.updateMatrixWorld(true)
      this.posable = copy
      this.posableKey = key
    }
    return this.posable
  }

  /** Hear every frame (and every seek): the phase of the slot's own clip and the time in the clip playing. */
  onTick (fn: (phase: number, time: number) => void): () => void {
    this.ticks.add(fn)
    return () => { this.ticks.delete(fn) }
  }

  // ---- transport (preview only) ----------------------------------------------------------------------------------

  setPlaying (on: boolean): void {
    this.running = on
    this.player?.setPlaying(on)
    this.horse?.player.setPlaying(on)
  }

  setSpeed (speed: number): void {
    this.speed = speed
    this.player?.setSpeed(speed)
    this.horse?.player.setSpeed(speed)
  }

  setLoop (loop: boolean): void {
    this.loop = loop
    this.player?.setLoop(loop)
    this.horse?.player.setLoop(loop)
  }

  /** Mirrored left for right (a preview: never saved, never exported). */
  setMirror (on: boolean): void {
    if (this.mirror === on) return
    this.mirror = on
    void this.refresh(true)
  }

  /** A library preview played in place or moving (a slot plays as its own saved setting says). */
  setInPlace (on: boolean): void {
    const now = untrack(() => this.playing)
    if (now?.kind !== 'library' || now.inPlace === on) return
    now.inPlace = on
    void this.refresh(true)
  }

  seek (time: number): void {
    this.endIdle()
    this.player?.seek(time)
    this.horse?.player.seek(time)
    this.track()
  }

  // ---- inside --------------------------------------------------------------------------------------------------------

  /** A new thing plays: the preview's speed and mirror back to normal, its loop its own. */
  private resetPreview (loop: boolean): void {
    this.setSpeed(1)
    this.mirror = false
    this.setLoop(loop)
  }

  private setNow (now: NowPlaying | null): void {
    const was = untrack(() => this.playing)
    this.playing = now
    if ((was === null) !== (now === null)) viewer.setOverlay('timeline', now === null ? null : { component: Timeline, props: {}, dock: 'bottom' })
  }

  private setLoading (on: boolean): void {
    this.loading = on
    app.setBusy('animator', on ? 'Retargeting animation' : null)
  }

  private halt (): void {
    this.token++
    this.holding = false
    this.player?.stop()
    this.horse?.player.stop()
    this.setNow(null)
    this.duration = 0
    this.time = 0
    this.setLoading(false)
    this.seat()
    this.endIdle()
    this.region = null
    tickPulls(null, 0)
  }

  /** Bake `now` and play it (`keepTime`: from the phase playing). */
  private async run (now: NowPlaying, keepTime: boolean): Promise<boolean> {
    if (this.player === null) return false
    const token = ++this.token
    this.setNow(now)
    this.setLoading(true)
    this.error = null
    try {
      const built = await this.build(now)
      if (token !== this.token || this.player === null) return false
      this.endIdle()
      this.player.play(built.clip, keepTime)
      // (a pose dragged was held on stage until this bake of its keys plays)
      this.holding = false
      const horse = this.horse
      if (horse !== null) {
        if (built.horse === null) horse.player.stop()
        else horse.player.play(built.horse, keepTime)
      }
      now.baked = built.baked
      now.pulls = built.baked.pulls
      now.cycles = built.cycles
      if (built.loop !== null && now.savedLoop !== built.loop) { now.savedLoop = built.loop; this.setLoop(built.loop) }
      this.duration = built.clip.duration
      this.signature = built.signature
      this.track()
      // (changed while it baked: the sync then saw nothing to compare with)
      const c = app.byId(now.characterId)
      if (c !== null && this.inputs(now, c) !== built.signature) queueMicrotask(() => { if (token === this.token) void this.run(now, true) })
      return true
    } catch (error) {
      if (token !== this.token) return false
      const message = error instanceof Error ? error.message : String(error)
      this.error = message
      app.toast('error', `${now.label} didn't play: ${message}`)
      this.holding = false
      this.halt()
      return false
    } finally {
      if (token === this.token) this.setLoading(false)
    }
  }

  private async build (now: NowPlaying): Promise<{ clip: THREE.AnimationClip, baked: BakedSlot, horse: THREE.AnimationClip | null, cycles: number, signature: string, loop: boolean | null }> {
    const c = app.byId(now.characterId)
    const ctx = this.bakeContext()
    if (c === null || ctx === null) throw new Error('The character is not on stage')
    const signature = this.inputs(now, c)
    const ride = this.riding(c)
    let slot: Slot
    let o: { skip?: BakeSkip, autoGround?: boolean } = {}
    if (now.kind === 'slot') {
      slot = slotById(c, now.slotId ?? '') ?? fail('That clip is gone')
      if (now.label !== slot.name) now.label = slot.name
    } else if (now.kind === 'library' && now.library !== null && now.ref !== null) {
      // (a library clip plays as a slot just made of it would: its gear paths, stood on the floor by its feet)
      const gear = gearKeysFromPaths(c, now.library.propPaths ?? {})
      slot = {
        id: 'preview', name: now.label, clip: now.ref, speed: 1, loop: now.library.loop, inPlace: now.inPlace,
        adjustments: [], gear: gearTracksOf(gear),
      }
      o = { autoGround: ride === null }
    } else if (now.kind === 'test' && now.ref !== null) {
      slot = { id: 'test', name: now.label, clip: now.ref, speed: 1, loop: true, inPlace: true, adjustments: [] }
      o = { skip: 'all', autoGround: ride === null }
    } else {
      return fail('Nothing to bake')
    }
    const baked = await bakeSlot(c, slot, ctx, { ...o, mirror: this.mirror })
    const loop = now.kind === 'slot' ? slot.loop : null
    if (ride === null || c.mount === undefined) return { clip: baked.clip, baked, horse: null, cycles: 1, signature, loop }
    const attack = now.kind === 'slot' && slot.time?.fit?.enabled === true
    const r = await bakeRide(baked, { c: ride.c, ctx: ride.ctx, slotName: now.kind === 'slot' ? slot.name : 'Idle' }, c.mount,
      { loop: slot.loop, attack, rest: ctx.rest, mirror: this.mirror })
    return { clip: r.rider.clip, baked: r.rider, horse: r.horse, cycles: r.cycles, signature, loop }
  }

  /** What the character on stage bakes with (the export's own is the same: the joints' ranges, the shared poses). */
  bakeContext (): BakeContext | null {
    const view = this.shown
    const posable = this.posableCopy()
    if (view === null || view.rest === null || posable === null || this.cache === null) return null
    return { rest: view.rest, posable, clips: this.cache, fps: FPS, sharedPoses: this.sharedPoses(), rom: romOf }
  }

  private sharedPoses (): HandPose[] {
    return $state.snapshot(app.settings?.handPoses ?? []) as HandPose[]
  }

  /** The horse `c` rides, on stage under him, ready to bake. */
  private riding (c: Character): { c: Character, ctx: BakeContext } | null {
    const horse = this.horse
    const m = c.mount
    if (horse === null || m === undefined || horse.mount.character.id !== m.character || horse.mount.view.rest === null) return null
    horse.posable ??= cloneSkinned(horse.mount.view.root)
    return {
      c: app.byId(m.character) ?? horse.mount.character,
      ctx: { rest: horse.mount.view.rest, posable: horse.posable, clips: horse.cache, fps: FPS, sharedPoses: this.sharedPoses(), rom: romOf },
    }
  }

  private useHorse (mount: MountView): void {
    this.dropHorse(false)
    if (mount.view.rest === null) return
    const player = new Player(mount.view.root)
    player.setSpeed(this.speed)
    player.setLoop(this.loop)
    player.setPlaying(this.running)
    this.horse = { mount, player, cache: new RetargetCache(mount.view.rest), posable: null }
    this.afterHorse()
  }

  private dropHorse (replay = true): void {
    const horse = this.horse
    if (horse === null) return
    this.horse = null
    horse.player.dispose()
    if (replay) this.afterHorse()
  }

  /** On or off his horse: what plays is baked again (seated, or not), or at rest he sits (or stands). */
  private afterHorse (): void {
    // (after the viewer is done: a rider being unloaded altogether needs nothing)
    queueMicrotask(() => {
      if (this.player === null) return
      const now = untrack(() => this.playing)
      if (now !== null && now.kind !== 'clip') void this.run(now, true)
      else if (now === null) { this.player.stop(); this.seat() }
    })
  }

  /** A rider at rest still sits: his held bones in their seated pose. */
  private seat (): void {
    const c = this.characterId === null ? null : app.byId(this.characterId)
    const view = this.shown
    if (this.horse === null || c?.mount === undefined || view?.rest == null || this.player === null) return
    this.player.play(freezeClip(new THREE.AnimationClip('Rest, seated', 1, []), c.mount, boneRest(view.rest)))
  }

  private frame (dt: number): void {
    if (this.player === null) return
    // (while a gizmo drags a bone or a piece the clip doesn't drive it: paused, it would still set the frame's pose)
    if (!this.holding && !gizmo.dragging && this.player.clip !== null) {
      if (this.idleAction !== null) this.tickIdle(dt)
      else {
        const was = this.player.time
        this.player.update(dt)
        if (this.horse?.player.clip != null) this.horse.player.update(dt)
        this.keepInRegion(was)
        this.maybeIdle()
      }
    }
    this.track()
  }

  /** Playing with a loop region: past its end (or wrapped round past it), back to its start. */
  private keepInRegion (was: number): void {
    const r = this.region; const now = untrack(() => this.playing)
    if (r === null || now === null || !this.running || this.duration <= 0) return
    const cycles = Math.max(1, now.cycles)
    const own = this.duration / cycles
    const cycle = Math.floor(Math.min(was, this.duration - 1e-9) / own)
    const t = this.player!.time
    const end = (cycle + r[1]) * own
    const ended = !this.loop && t >= this.duration - 1e-4
    if (t > end + 1e-6 || t < was - 1e-6 || t < (cycle + r[0]) * own - 1e-6 || ended) {
      this.seek((cycle + r[0]) * own)
      this.player!.setPlaying(true)
    }
  }

  // ---- the preview into Idle -----------------------------------------------------------------------------------------

  /** Turn the preview into Idle on or off (the character's Idle baked for it once). */
  setIntoIdle (on: boolean): void {
    this.intoIdle = on
    if (!on) this.endIdle()
    else void this.idleClip()
  }

  /** The character's Idle as it plays (baked once for what it is made of), or null: it has none (or is the clip). */
  private async idleClip (): Promise<THREE.AnimationClip | null> {
    const now = untrack(() => this.playing)
    const c = now === null ? null : app.byId(now.characterId)
    const idle = c?.clips.find(s => s.name === 'Idle')
    const ctx = this.bakeContext()
    if (c === null || idle === undefined || ctx === null || now?.slotId === idle.id) return null
    const key = this.inputs(new NowPlaying({ kind: 'slot', characterId: c.id, slotId: idle.id, label: 'Idle' }), c)
    if (this.idle?.key === key) return this.idle.clip
    const clip = (await bakeSlot(c, idle, ctx)).clip
    this.idle = { key, clip }
    return clip
  }

  /** The clip played once has ended: the Idle blended in over BLEND seconds (as the game does). */
  private maybeIdle (): void {
    const now = untrack(() => this.playing)
    if (!this.intoIdle || !this.running || this.loop || now === null || now.kind === 'clip' || this.horse !== null || this.region !== null) return
    if (this.player === null || this.player.time < this.duration - 1e-4) return
    const idle = this.idle?.clip
    if (idle === undefined) { void this.idleClip(); return }
    const main = this.player.mixer.existingAction(this.player.clip!)
    if (main === null) return
    const action = this.player.mixer.clipAction(idle)
    action.reset(); action.setLoop(THREE.LoopRepeat, Infinity); action.timeScale = this.speed; action.play()
    main.crossFadeTo(action, BLEND, false)
    this.idleAction = action
    this.idleTime = 0
    this.inIdle = true
  }

  private tickIdle (dt: number): void {
    if (!this.running || this.player === null) return
    this.player.update(dt)
    this.idleTime += dt * this.speed
    if (this.idleTime >= IDLE_FOR) { this.endIdle(); this.seek(0) }
  }

  /** The Idle after the clip stopped: the clip alone again. */
  private endIdle (): void {
    const a = this.idleAction
    if (a === null) return
    this.idleAction = null
    this.inIdle = false
    a.stop()
    const main = this.player?.clip == null ? null : this.player.mixer.existingAction(this.player.clip)
    if (main !== null && main !== undefined) { main.stopFading(); main.setEffectiveWeight(1); main.enabled = true; main.paused = !this.running; main.play() }
  }

  /** The time and phase where the player is, mirrored into the state; the pulls drawn there; the tick hooks told. */
  private track (): void {
    // (also run from a seek, which an effect may make: nothing read here is its dependency)
    untrack(() => { this.trackNow() })
  }

  private trackNow (): void {
    if (this.player === null) return
    const now = this.playing
    const t = this.player.time
    if (this.time !== t) this.time = t
    const at = this.duration > 0 ? t / this.duration : 0
    const phase = now === null ? 0 : phaseIn(at, now.cycles, this.loop)
    if (now !== null) {
      if (now.time !== t) now.time = t
      if (now.phase !== phase) now.phase = phase
    }
    // (a pull's windows are phases of the whole clip playing, a ridden loop's cycles and all)
    tickPulls(now?.pulls ?? null, at)
    for (const fn of this.ticks) fn(phase, t)
  }

  /** The character's bone map changed: the retargeting skeleton and the previews made again. */
  rebind (): void {
    const view = this.shown
    const c = this.characterId === null ? null : app.byId(this.characterId)
    if (view === null || c === null) return
    this.boneMap = stableJson(c.skeleton.boneMap ?? null)
    view.setRename(renamer(c.skeleton.boneMap))
    if (view.rest !== null) this.cache = new RetargetCache(view.rest)
    this.posable = null
    this.lastKey = ''
    this.usePreviewSubject()
    const now = untrack(() => this.playing)
    if (now !== null && now.kind !== 'clip') void this.run(now, true)
  }

  /** A clip file written again (an edit saved over it): loaded and retargeted afresh next time it plays. */
  forgetClip (url: string): void {
    forgetClip(url)
    // (a slot built from pieces of it composes them again)
    forgetComposites()
    this.cache?.forget(url)
    this.horse?.cache.forget(url)
  }

  // ---- library previews --------------------------------------------------------------------------------------------

  private usePreviewSubject (): void {
    const renderer = this.previews
    if (renderer === null) return
    const c = this.characterId === null ? null : app.byId(this.characterId)
    if (this.shown !== null && c !== null) {
      const key = `${c.id}:${c.revision}:${stableJson(c.skeleton.boneMap ?? null)}`
      renderer.setCharacter(key, this.shown.root, this.shown.rename)
      if (this.previewSubject !== 'character' || this.lastKey !== key) this.previewVersion++
      this.lastKey = key
      this.previewSubject = 'character'
      return
    }
    void this.loadMannequin().then(root => {
      if (root !== null && this.shown === null) {
        renderer.setCharacter('mannequin', root)
        if (this.previewSubject !== 'mannequin') this.previewVersion++
        this.lastKey = 'mannequin'
        this.previewSubject = 'mannequin'
      } else if (root === null) {
        this.previewSubject = 'none'
      }
    })
  }

  private async loadMannequin (): Promise<THREE.Object3D | null> {
    this.mannequin ??= new GLTFLoader().loadAsync(MANNEQUIN).then(g => g.scene, () => null)
    return await this.mannequin
  }

  /** A library clip's sprite sheet on the character (or the mannequin), as an object URL; null when it was dropped. */
  async sprite (url: string): Promise<string | null> {
    if (this.previews === null) {
      this.previews = new PreviewRenderer()
      this.usePreviewSubject()
      if (this.shown === null) await this.loadMannequin()
    }
    return await this.previews.sheet(url)
  }

  cancelSprites (): void { this.previews?.cancelPending() }
}

function fail (message: string): never {
  throw new Error(message)
}

export const animator = new Animator()

// (hooked in once every module has loaded: the viewer's own imports may come back round to this one)
queueMicrotask(() => { animator.install() })
if (import.meta.hot !== undefined) import.meta.hot.dispose(() => { animator.uninstall() })
