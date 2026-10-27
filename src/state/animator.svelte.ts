// Animation playback in the main viewport, and sprite previews for the library.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { AnimationEntry, Character, ClipKey, LibraryClip } from './api.ts'
import { app } from './app.svelte.ts'
import type { CharacterView } from '../engine/CharacterView.ts'
import { RetargetCache } from '../engine/clips.ts'
import { renamer } from '../engine/presets/skeletonMap.ts'
import { Player } from '../engine/Player.ts'
import { PreviewRenderer } from '../engine/PreviewRenderer.ts'
import { applyScripts, fistPose, retime, type GripScript } from '../engine/scripts.ts'
import { applyBoneKeys, applyLift, propTracks } from '../engine/keys.ts'
import { restUpOf } from '../engine/retarget.ts'
import { groundFit } from '../engine/ground.ts'
import { garmentMatrix } from '../engine/placement.ts'
import { fitRide, freezeClip } from '../engine/mount.ts'
import type { Stage } from '../engine/Stage.ts'

export interface NowPlaying {
  clipId: string
  url: string
  name: string
  /** A rig test (the Rig step's): it plays on there. */
  test?: boolean
  /** Index in the character's animation set, or null for a library preview. */
  entry: number | null
  /** A library clip made with props leading: each prop's path (by prop name), played with it. */
  propPaths?: Record<string, ClipKey[]>
  /** The animation editor's clip (an edit, not saved as itself): no slot can take it. */
  edited?: boolean
}

const MANNEQUIN = '/files/library/mannequin/ybot.glb'

/** The library clip a hand's fist is closed as when nothing says otherwise: of the library's held-object clips, the one
 * whose fingers wrap a shaft most evenly and closely, both hands (a scan of their fists round a spear's shaft). */
export const GRIP_CLIP = 'mixamo-Great_Sword_Crouching_6'
/** The fists to choose from (the best of that scan, and the old default): library clip id, name. */
export const FISTS: Array<[string, string]> = [['mixamo-Great_Sword_Crouching_6', 'Great sword'], ['mixamo-Golf_Post-Swing_2', 'Golf club'],
  ['mixamo-Holding_Turn_Right', 'Holding'], ['mixamo-Walk_With_Rifle_3', 'Rifle'], ['mixamo-2hand_Idle', '2hand idle']]

export function clipUrl (clipId: string): string {
  return `/files/library/clips/${clipId}.glb`
}

export function entryUrl (entry: AnimationEntry): string {
  return entry.url ?? clipUrl(entry.clipId)
}

class Animator {
  current = $state<NowPlaying | null>(null)
  playing = $state(true)
  time = $state(0)
  duration = $state(0)
  speed = $state(1)
  loop = $state(true)
  inPlace = $state(false)
  mirror = $state(false)
  loading = $state(false)
  error = $state<string | null>(null)
  previewSubject = $state<'character' | 'mannequin' | 'none'>('none')
  /** Bumped when previews are re-rendered for a different subject; cards re-request their sheet. */
  previewVersion = $state(0)

  private player: Player | null = null
  private cache: RetargetCache | null = null
  private view: CharacterView | null = null
  private offFrame: (() => void) | null = null
  private previews: PreviewRenderer | null = null
  private mannequin: Promise<THREE.Object3D | null> | null = null
  private token = 0
  private lastKey = ''
  /** A posable copy of the character, for scripts to measure clips on without moving the one on stage. */
  private posable: THREE.Object3D | null = null
  /** The lift the library clip playing was stood on the floor by (its hips raised by it: grounded). */
  lift = 0
  /** While a tweak is being dragged: the clip stops driving the bones (the gizmo does). */
  holding = false
  /** The entry playing, as it plays before its keys (on the timeline played): what a new key is measured against. */
  unkeyed: THREE.AnimationClip | null = null
  /** How the entry playing was cut by its blow timing (seconds of the clip before the cut, at its speed). */
  cut = $state<{ name: string, start: number, end: number, uncut: number, blow: number } | null>(null)
  private stageRef: Stage | null = null
  /** How many of the rider's own cycles the clip playing holds (a ridden loop fitted to the horse's gait): a key's
   * phase is within one. */
  cycles = $state(1)
  // The horse a mounted character rides (viewer.syncMount): its own player, retargeting and posable copy.
  private horseView: CharacterView | null = null
  private horsePlayer: Player | null = null
  private horseCache: RetargetCache | null = null
  private horsePosable: THREE.Object3D | null = null

  attach (view: CharacterView, stage: Stage): void {
    this.detach()
    if (view.rest === null) return
    view.setRename(renamer(app.selected?.boneMap))
    this.view = view
    this.stageRef = stage
    this.player = new Player(view.root)
    this.player.setSpeed(this.speed)
    this.player.setLoop(this.loop)
    this.player.setPlaying(this.playing)
    this.cache = new RetargetCache(view.rest)
    this.posable = null
    this.offFrame = stage.onFrame(dt => {
      if (this.player === null || this.player.clip === null || this.holding) return
      this.player.update(dt)
      if (this.horsePlayer?.clip != null) this.horsePlayer.update(dt)
      this.time = this.player.time
    })
    this.usePreviewSubject()
  }

  /** The horse the character rides now (or none). */
  attachMount (view: CharacterView | null): void {
    this.horsePlayer?.dispose()
    this.horsePlayer = null
    this.horseCache = null
    this.horsePosable = null
    this.horseView = view
    if (view === null || view.rest === null) return
    this.horsePlayer = new Player(view.root)
    this.horsePlayer.setSpeed(this.speed)
    this.horsePlayer.setLoop(this.loop)
    this.horsePlayer.setPlaying(this.playing)
    this.horseCache = new RetargetCache(view.rest)
  }

  /** The horse on stage (the character rides it). */
  get horse (): CharacterView | null { return this.horseView }

  /** The local pose of `bones` at the first frame of a library clip on this character (a seat's legs), and the Hips'
   * local position there. */
  /** The mount playing under this character, when it rides one. */
  private riding (): { character: Character, view: CharacterView, cache: RetargetCache, posable: THREE.Object3D } | null {
    const m = app.selected?.mount
    const horse = m === undefined ? undefined : app.characters.find(c => c.id === m.character)
    if (m === undefined || horse === undefined || this.horseView === null || this.horseCache === null) return null
    this.horsePosable ??= cloneSkinned(this.horseView.root)
    return { character: horse, view: this.horseView, cache: this.horseCache, posable: this.horsePosable }
  }

  detach (): void {
    this.attachMount(null)
    this.offFrame?.()
    this.offFrame = null
    this.player?.dispose()
    this.player = null
    this.cache = null
    this.view = null
    this.posable = null
    this.current = null
    this.duration = 0
    this.time = 0
    this.usePreviewSubject()
  }

  get ready (): boolean { return this.player !== null }
  get character (): CharacterView | null { return this.view }
  /** The clip playing (as built: speed, scripts, ground, keys). */
  get clip (): THREE.AnimationClip | null { return this.player?.clip ?? null }
  get stage (): Stage | null { return this.stageRef }
  /** A posable copy of the character (for measuring clips off stage); `fresh`: copied again (props added since). */
  posableCopy (fresh = false): THREE.Object3D | null {
    if (this.view === null) return null
    if (fresh) this.posable = null
    this.posable ??= cloneSkinned(this.view.root)
    return this.posable
  }

  /** Play a library clip or an entry from the character's set (an entry with the character's scripts on it). */
  async play (target: NowPlaying, options: { inPlace?: boolean, speed?: number, loop?: boolean, keepTime?: boolean } = {}): Promise<void> {
    if (this.player === null || this.cache === null) return
    const token = ++this.token
    this.current = target
    this.loading = true
    this.error = null
    if (options.inPlace !== undefined) this.inPlace = options.inPlace
    if (options.speed !== undefined) this.setSpeed(options.speed)
    if (options.loop !== undefined) this.setLoop(options.loop)
    try {
      const entry = target.entry !== null ? app.selected?.animations[target.entry] : undefined
      // (an entry plays as the game gets it: its speed, scripts, ground and keys, seated on its horse if it rides one,
      // the horse's clip of the same name under it; a library preview as it comes, props at rest, the horse idling)
      let clip: THREE.AnimationClip
      let horse: THREE.AnimationClip | null = null
      const ride = this.riding()
      this.cycles = 1
      if (entry !== undefined && entry.clipId === target.clipId) {
        const me = app.selected!
        const built = await this.bake(me, this.view!, this.cache, this.posableCopy()!, entry, true)
        let rider = built.clip
        let unkeyed = built.unkeyed
        if (ride !== null) {
          const rest = restOf(this.view!)
          rider = freezeClip(rider, me.mount!, rest)
          unkeyed = freezeClip(unkeyed, me.mount!, rest)
          const he = ride.character.animations.find(a => a.name === entry.name) ?? ride.character.animations.find(a => a.name === 'Idle')
          if (he !== undefined) {
            const hb = (await this.bake(ride.character, ride.view, ride.cache, ride.posable, he, false)).clip
            const attack = (me.scripts ?? []).some(x => x.enabled && x.kind === 'blow' && x.clip === entry.name)
            const fit = fitRide(rider, hb, entry.loop, attack)
            this.cycles = Array.isArray(fit.report.cycles) ? (fit.report.cycles as number[])[0] : 1
            unkeyed = fitRide(unkeyed, hb, entry.loop, attack).rider
            rider = fit.rider
            horse = retime(fit.horse, 1 / entry.speed)
          }
        }
        this.unkeyed = retime(unkeyed, 1 / entry.speed)
        clip = retime(rider, 1 / entry.speed)
      } else {
        // (a clip made with a prop leading plays its path: the prop where the editor had it)
        clip = this.withProps(await this.cache.get(target.url, { inPlace: this.inPlace, mirror: this.mirror }), target.propPaths, this.loop)
        // (a library clip or a rig test stands on the floor: its flat feet set it, src/engine/ground.ts)
        clip = this.grounded(clip)
        this.unkeyed = null
        const idle = ride?.character.animations.find(a => a.name === 'Idle')
        if (ride !== null && idle !== undefined) horse = (await this.bake(ride.character, ride.view, ride.cache, ride.posable, idle, false)).clip
      }
      if (token !== this.token || this.player === null) return
      if (this.player.clip?.name === 'Rest, fists closed') this.player.stop()   // (no closed fingers left over)
      this.player.play(clip, options.keepTime === true)
      if (this.horsePlayer !== null) {
        if (horse !== null) this.horsePlayer.play(horse, options.keepTime === true)
        else this.horsePlayer.stop()
      }
      this.duration = clip.duration
    } catch (error) {
      if (token === this.token) this.error = (error as Error).message
    } finally {
      if (token === this.token) this.loading = false
    }
  }

  /** Show a clip built elsewhere (the animation editor's), paused at `time`. */
  showClip (clip: THREE.AnimationClip, now: NowPlaying, time: number): void {
    if (this.player === null) return
    this.token++
    this.current = now
    this.holding = false
    this.player.play(clip)
    this.duration = clip.duration
    this.setPlaying(false)
    this.seek(Math.min(Math.max(time, 0), clip.duration))
  }

  playEntry (entry: AnimationEntry, index: number, keepTime = false): void {
    void this.play({ clipId: entry.clipId, url: entryUrl(entry), name: entry.name, entry: index }, { inPlace: entry.inPlace, speed: entry.speed, loop: entry.loop, keepTime })
  }

  /** An entry of `c` as the game export makes it, at its speed (the timeline the export bakes): its scripts (with the
   * clips a pace needs), its ground, its bone keys, its props. `record`: the character on stage (its cut kept for the
   * blow's frame). Returns the clip and the same before its keys (what a new key is measured against). */
  private async bake (c: Character, view: CharacterView, cache: RetargetCache, posable: THREE.Object3D, entry: AnimationEntry, record: boolean): Promise<{ clip: THREE.AnimationClip, unkeyed: THREE.AnimationClip }> {
    const scripts = c.scripts ?? []
    const build = async (e: AnimationEntry): Promise<THREE.AnimationClip> =>
      retime(await cache.get(entryUrl(e), { inPlace: e.inPlace, mirror: this.mirror }), e.speed)
    const clips = new Map([[entry.name, await build(entry)]])
    for (const s of scripts) {
      if (s.enabled && s.kind === 'pace' && s.clip === entry.name) {
        const like = c.animations.find(a => a.name === s.like)
        if (like !== undefined) clips.set(like.name, await build(like))
      }
    }
    const { clips: out, report } = await applyScripts(posable, clips, scripts, async id => await cache.get(clipUrl(id), { inPlace: true }))
    if (record) {
      const blow = Object.values(report).find(r => (r as { kind?: string, clip?: string }).kind === 'blow' && (r as { clip?: string }).clip === entry.name) as { kept: [number, number], uncut: number, blow: number } | undefined
      this.cut = blow === undefined ? null : { name: entry.name, start: blow.kept[0], end: blow.kept[1], uncut: blow.uncut, blow: blow.blow }
    }
    const rest = view.rest!
    const hips = rest.bones.get('Hips') ?? rest.bones.get('hips')
    let clip = out.get(entry.name)!
    if (hips !== undefined) clip = applyLift(clip, hips.name, entry.lift ?? 0, hips.localPosition, restUpOf(rest, hips.name))
    const unkeyed = clip
    clip = applyBoneKeys(clip, entry.keys?.bones, entry.loop, restOf(view))
    return { clip: this.withProps(clip, entry.keys?.props, entry.loop, c, view), unkeyed }
  }

  /** `clip` with a track for every prop on stage (its placement, then its keys if it has any), so a prop keyed in one
   * clip is back in place in the next. */
  private withProps (clip: THREE.AnimationClip, props: Record<string, Array<{ u: number, q: [number, number, number, number], p?: [number, number, number] }>> | undefined, loop: boolean,
    c: Character | null = app.selected, view: CharacterView | null = this.view): THREE.AnimationClip {
    if (c === null || view === null) return clip
    const tracks = [...clip.tracks]
    for (const g of c.garments ?? []) {
      if (g.mode !== 'rigid') continue
      const node = `${g.name.replace(/[^\w]+/g, '_')}_place`
      if (view.root.getObjectByName(node) === undefined) continue    // (hidden: not on stage)
      const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion(); const scale = new THREE.Vector3()
      garmentMatrix(g).decompose(position, quaternion, scale)
      tracks.push(...propTracks(node, clip.duration, props?.[g.name], loop, { position, quaternion }, g.scale))
    }
    return new THREE.AnimationClip(clip.name, clip.duration, tracks)
  }

  /** A hand's fingers closed round a shaft (local turns): as the character's Hold fist script for that hand closes
   * them, else as 2hand Idle does. */
  async fistOf (side: 'Left' | 'Right', clipId?: string): Promise<Record<string, [number, number, number, number]>> {
    const root = this.posableCopy()
    if (root === null || this.cache === null) return {}
    const grip = (app.selected?.scripts ?? []).find((x): x is GripScript => x.enabled && x.kind === 'grip' && x.side === side)
    const clip = await this.cache.get(clipUrl(clipId ?? grip?.clip ?? GRIP_CLIP), { inPlace: true })
    return Object.fromEntries([...fistPose(root, clip, side).pose].map(([n, q]) => [n, q.toArray() as [number, number, number, number]]))
  }

  /** The rest pose with the hands closed as the character's Hold fist scripts close them (both hands round a shaft, as
   * in 2hand Idle, if it has none): to fit what a hand holds. */
  async playFists (): Promise<void> {
    if (this.player === null || this.cache === null || this.view === null) return
    const token = ++this.token
    const cache = this.cache
    this.current = { clipId: 'fists', url: '', name: 'Rest, fists closed', entry: null }
    this.loading = true
    this.error = null
    try {
      const grips = (app.selected?.scripts ?? []).filter((x): x is GripScript => x.enabled && x.kind === 'grip')
      const hands = grips.length > 0 ? grips.map(g => ({ side: g.side, clip: g.clip })) : (['Left', 'Right'] as const).map(side => ({ side, clip: GRIP_CLIP }))
      this.posable ??= cloneSkinned(this.view.root)
      const tracks: THREE.KeyframeTrack[] = []
      for (const h of hands) {
        const { pose } = fistPose(this.posable, await cache.get(clipUrl(h.clip), { inPlace: true }), h.side)
        for (const [n, q] of pose) tracks.push(new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, [0, 1], [...q.toArray(), ...q.toArray()]))
      }
      if (token !== this.token || this.player === null) return
      this.player.stop()
      this.horsePlayer?.stop()
      const m = app.selected?.mount
      const fists = new THREE.AnimationClip('Rest, fists closed', 1, tracks)
      this.player.play(m !== undefined && this.horseView !== null ? freezeClip(fists, m, restOf(this.view)) : fists)
      this.duration = 1
    } catch (error) {
      if (token === this.token) this.error = (error as Error).message
    } finally {
      if (token === this.token) this.loading = false
    }
  }

  /** Each of the selected character's entries (`names`, else all) stood on the floor by its flat feet: the lift each
   * would take (src/engine/ground.ts), measured on the entry as it plays now (its scripts, its lift, its keys). */
  async groundEntries (names?: string[]): Promise<Map<number, number>> {
    const c = app.selected; const view = this.view; const cache = this.cache; const root = this.posableCopy()
    const out = new Map<number, number>()
    if (c === null || view === null || cache === null || root === null) return out
    let body: THREE.SkinnedMesh | undefined
    root.traverse(o => { if (body === undefined && (o as THREE.SkinnedMesh).isSkinnedMesh) body = o as THREE.SkinnedMesh })
    if (body === undefined) return out
    for (const [i, entry] of c.animations.entries()) {
      if (names !== undefined && !names.includes(entry.name)) continue
      const { clip } = await this.bake(c, view, cache, root, entry, false)
      out.set(i, (entry.lift ?? 0) + groundFit(root, body, clip, view.height).lift)
    }
    return out
  }

  /** `clip` raised or lowered so its flat feet stand on the floor (its lowest point where it never plants one). */
  private grounded (clip: THREE.AnimationClip): THREE.AnimationClip {
    const view = this.view; const root = this.posableCopy()
    if (view === null || root === null || view.rest === null) return clip
    let body: THREE.SkinnedMesh | undefined
    root.traverse(o => { if (body === undefined && (o as THREE.SkinnedMesh).isSkinnedMesh) body = o as THREE.SkinnedMesh })
    const hips = view.rest.bones.get('Hips') ?? view.rest.bones.get('hips')
    if (body === undefined || hips === undefined) return clip
    const fit = groundFit(root, body, clip, view.height)
    this.lift = fit.lift
    return applyLift(clip, hips.node.name, fit.lift, hips.localPosition, restUpOf(view.rest, hips.name))
  }

  /** A test of the rig (static/templates/tests.json): a library clip that works its joints hard, in place, looped. */
  playTest (test: { id: string, name: string, url?: string }): void {
    void this.play({ clipId: test.id, url: test.url ?? clipUrl(test.id), name: test.name, entry: null, test: true }, { inPlace: true, loop: true })
  }

  playLibrary (clip: LibraryClip): void {
    void this.play({ clipId: clip.id, url: clip.url, name: clip.name, entry: null, propPaths: clip.propPaths }, { inPlace: this.inPlace })
  }

  /** The character's bone map changed: rebuild the retargeting skeleton and previews. */
  rebind (): void {
    if (this.view === null || this.player === null) return
    this.view.setRename(renamer(app.selected?.boneMap))
    this.cache = new RetargetCache(this.view.rest!)
    this.usePreviewSubject()
    void this.refresh()
  }

  /** While the animation editor is open: what plays is its clip, built again on a refresh (not the clip it edits). */
  editing: (() => void) | null = null

  async refresh (keepTime = false): Promise<void> {
    if (this.current === null) return
    if (this.editing !== null) { this.editing(); return }
    if (this.current.clipId === 'fists') { await this.playFists(); return }
    await this.play(this.current, { keepTime })
  }

  stop (): void {
    this.token++
    this.player?.stop()
    this.horsePlayer?.stop()
    // (a rider at rest still sits: his frozen bones at their seated pose)
    const m = app.selected?.mount
    if (m !== undefined && this.horseView !== null && this.view !== null && this.player !== null) {
      this.player.play(freezeClip(new THREE.AnimationClip('Rest, seated', 1, []), m, restOf(this.view)))
    }
    this.current = null
    this.duration = 0
    this.time = 0
  }

  setPlaying (playing: boolean): void { this.playing = playing; this.player?.setPlaying(playing); this.horsePlayer?.setPlaying(playing) }
  setSpeed (speed: number): void { this.speed = speed; this.player?.setSpeed(speed); this.horsePlayer?.setSpeed(speed) }
  setLoop (loop: boolean): void { this.loop = loop; this.player?.setLoop(loop); this.horsePlayer?.setLoop(loop) }
  seek (time: number): void { this.player?.seek(time); this.horsePlayer?.seek(time); this.time = time }

  // ---- library previews ---------------------------------------------------------------------------

  private usePreviewSubject (): void {
    const renderer = this.previews
    if (renderer === null) return
    const character = app.selected
    if (this.view !== null && character !== null) {
      const key = `${character.id}:${character.revision ?? 0}:${JSON.stringify(character.boneMap ?? {})}`
      renderer.setCharacter(key, this.view.root, this.view.rename)
      if (this.previewSubject !== 'character' || this.lastKey !== key) this.previewVersion++
      this.lastKey = key
      this.previewSubject = 'character'
      return
    }
    void this.loadMannequin().then(root => {
      if (root !== null && this.view === null) {
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

  async sprite (url: string): Promise<string | null> {
    if (this.previews === null) {
      this.previews = new PreviewRenderer()
      this.usePreviewSubject()
      if (this.view === null) await this.loadMannequin()
    }
    return await this.previews.sheet(url)
  }

  cancelSprites (): void { this.previews?.cancelPending() }
}

export const animator = new Animator()

/** A character's bones at rest (local), for clips' keys and frozen bones the clip doesn't move. */
export function restOf (view: CharacterView): (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null {
  return bone => {
    const b = view.rest?.bones.get(bone)
    return b === undefined ? null : { q: b.localQuaternion.clone(), p: b.localPosition.clone() }
  }
}
