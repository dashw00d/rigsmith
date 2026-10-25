// Animation playback in the main viewport, and sprite previews for the library.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { AnimationEntry, LibraryClip } from './api.ts'
import { app } from './app.svelte.ts'
import type { CharacterView } from '../engine/CharacterView.ts'
import { RetargetCache } from '../engine/clips.ts'
import { renamer } from '../engine/presets/skeletonMap.ts'
import { Player } from '../engine/Player.ts'
import { PreviewRenderer } from '../engine/PreviewRenderer.ts'
import { applyScripts, retime } from '../engine/scripts.ts'
import type { Stage } from '../engine/Stage.ts'

export interface NowPlaying {
  clipId: string
  url: string
  name: string
  /** Index in the character's animation set, or null for a library preview. */
  entry: number | null
}

const MANNEQUIN = '/files/library/mannequin/ybot.glb'

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

  attach (view: CharacterView, stage: Stage): void {
    this.detach()
    if (view.rest === null) return
    view.setRename(renamer(app.selected?.boneMap))
    this.view = view
    this.player = new Player(view.root)
    this.player.setSpeed(this.speed)
    this.player.setLoop(this.loop)
    this.player.setPlaying(this.playing)
    this.cache = new RetargetCache(view.rest)
    this.posable = null
    this.offFrame = stage.onFrame(dt => {
      if (this.player === null || this.player.clip === null) return
      this.player.update(dt)
      this.time = this.player.time
    })
    this.usePreviewSubject()
  }

  detach (): void {
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

  /** Play a library clip or an entry from the character's set (an entry with the character's scripts on it). */
  async play (target: NowPlaying, options: { inPlace?: boolean, speed?: number, loop?: boolean } = {}): Promise<void> {
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
      const clip = entry !== undefined && entry.clipId === target.clipId && (app.selected?.scripts ?? []).some(s => s.enabled)
        ? await this.scripted(entry)
        : await this.cache.get(target.url, { inPlace: this.inPlace, mirror: this.mirror })
      if (token !== this.token || this.player === null) return
      this.player.play(clip)
      this.duration = clip.duration
    } catch (error) {
      if (token === this.token) this.error = (error as Error).message
    } finally {
      if (token === this.token) this.loading = false
    }
  }

  playEntry (entry: AnimationEntry, index: number): void {
    void this.play({ clipId: entry.clipId, url: entryUrl(entry), name: entry.name, entry: index }, { inPlace: entry.inPlace, speed: entry.speed, loop: entry.loop })
  }

  /** An entry as the game export makes it: at its speed, the scripts applied (with the clips a pace needs), then
   * played back at its speed again so the speed control keeps its meaning. */
  private async scripted (entry: AnimationEntry): Promise<THREE.AnimationClip> {
    const cache = this.cache!
    const character = app.selected!
    const scripts = character.scripts ?? []
    this.posable ??= cloneSkinned(this.view!.root)
    const build = async (e: AnimationEntry): Promise<THREE.AnimationClip> =>
      retime(await cache.get(entryUrl(e), { inPlace: e.inPlace, mirror: this.mirror }), e.speed)
    const clips = new Map([[entry.name, await build(entry)]])
    for (const s of scripts) {
      if (s.enabled && s.kind === 'pace' && s.clip === entry.name) {
        const like = character.animations.find(a => a.name === s.like)
        if (like !== undefined) clips.set(like.name, await build(like))
      }
    }
    const { clips: out } = await applyScripts(this.posable, clips, scripts, async id => await cache.get(clipUrl(id), { inPlace: true }))
    return retime(out.get(entry.name)!, 1 / entry.speed)
  }

  playLibrary (clip: LibraryClip): void {
    void this.play({ clipId: clip.id, url: clip.url, name: clip.name, entry: null }, { inPlace: this.inPlace })
  }

  /** The character's bone map changed: rebuild the retargeting skeleton and previews. */
  rebind (): void {
    if (this.view === null || this.player === null) return
    this.view.setRename(renamer(app.selected?.boneMap))
    this.cache = new RetargetCache(this.view.rest!)
    this.usePreviewSubject()
    void this.refresh()
  }

  async refresh (): Promise<void> {
    if (this.current !== null) await this.play(this.current)
  }

  stop (): void {
    this.token++
    this.player?.stop()
    this.current = null
    this.duration = 0
    this.time = 0
  }

  setPlaying (playing: boolean): void { this.playing = playing; this.player?.setPlaying(playing) }
  setSpeed (speed: number): void { this.speed = speed; this.player?.setSpeed(speed) }
  setLoop (loop: boolean): void { this.loop = loop; this.player?.setLoop(loop) }
  seek (time: number): void { this.player?.seek(time); this.time = time }

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
