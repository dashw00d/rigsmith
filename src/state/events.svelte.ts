// The Events track's state (docs/motion-plan.md §9 C1): what an event can play (the game's sounds from its mix table,
// the files dropped on the character's events), the live preview (as the playhead crosses an event while the slot plays,
// its sound, levelled and pitched as the game plays it; scrubbing, a short blip; either way its name flashed over the
// character), each name's preview muted or not (here only: the game gets every event), and the edits the lane and the
// inspector make, each one command batch (src/app/motion/events/edit.ts works them out).
import type { CharacterSound, GameSound, GameSounds } from '../../server/routes/sounds.ts'
import type { TimelineView } from '../app/motion/lanes.ts'
import { crossed, measuredHit, playedEvents, type PlayedEvent } from '../app/motion/events/edit.ts'
import EventFlash from '../app/motion/events/EventFlash.svelte'
import { addEvent } from '../app/motion/events/edit.ts'
import { FEET, footsteps, HOOVES, newSteps } from '../app/motion/events/footsteps.ts'
import { boneNames, defaultsFor } from '../app/motion/events/vocabulary.ts'
import type { Command } from '../model/command-types.ts'
import { heightOf } from '../model/select.ts'
import type { Character, ClipEvent } from '../model/types.ts'
import { animator } from './animator.svelte.ts'
import { ApiError, call } from './api.ts'
import { app } from './app.svelte.ts'
import { viewer } from './viewer.svelte.ts'

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const FLASH_MS = 700
/** A scrub further than this (a share of the clip) is a jump: no blips for what it skipped. */
const JUMP = 0.25

export interface Flash { key: number, name: string }

/** The events of these names are what "Add footsteps" lays, for the feet the skeleton has. */
export function feetOf (c: Pick<Character, 'skeleton'>): typeof FEET {
  const bones = boneNames(c)
  if (bones.includes('LeftFoot') || bones.includes('RightFoot')) return FEET
  if (bones.some(b => HOOVES.some(h => h.bones.includes(b)))) return HOOVES
  return []
}

class EventsState {
  /** The game's sounds (null till asked for, or while they load). */
  game = $state.raw<GameSounds | null>(null)
  gameError = $state<string | null>(null)
  /** Each character's dropped files, by character id. */
  own = $state.raw<Record<string, CharacterSound[]>>({})
  /** The names flashed over the character just now (EventFlash shows them). */
  flashes = $state.raw<Flash[]>([])
  /** Per character, the names whose preview is muted. */
  private muted_ = $state.raw<Record<string, string[]>>({})
  private flashKey = 0
  private audio: AudioContext | null = null
  private buffers = new Map<string, Promise<AudioBuffer | null>>()
  private loadingGame: Promise<void> | null = null

  // ---- what an event can play ------------------------------------------------------------------------------------

  /** The game's sounds, read once (again with `fresh`). */
  async loadGame (fresh = false): Promise<void> {
    if (!fresh && (this.game !== null || this.loadingGame !== null)) return await (this.loadingGame ?? Promise.resolve())
    this.loadingGame = (async () => {
      try {
        this.game = await call<GameSounds>('GET', '/api/game/sounds')
        this.gameError = null
      } catch (error) {
        this.gameError = message(error)
      } finally {
        this.loadingGame = null
      }
    })()
    await this.loadingGame
  }

  gameSound (sound: string | undefined): GameSound | undefined {
    return sound?.startsWith('mix:') === true ? this.game?.sounds.find(s => s.id === sound.slice(4)) : undefined
  }

  async loadOwn (characterId: string): Promise<void> {
    try {
      const list = await call<CharacterSound[]>('GET', `/api/characters/${encodeURIComponent(characterId)}/sounds`)
      this.own = { ...this.own, [characterId]: list }
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) app.toast('error', `The character's sounds: ${message(error)}`)
    }
  }

  /** A file dropped on an event, kept with the character: what the event names it by ('file:sounds/<file>'), or null. */
  async drop (characterId: string, file: File): Promise<string | null> {
    if (!/\.(wav|ogg|mp3)$/i.test(file.name)) {
      app.toast('error', 'The game plays WAV, OGG or MP3 files')
      return null
    }
    try {
      const kept = await call<CharacterSound>('POST', `/api/characters/${encodeURIComponent(characterId)}/sounds?name=${encodeURIComponent(file.name)}`, file)
      await this.loadOwn(characterId)
      return kept.sound
    } catch (error) {
      app.toast('error', `${file.name}: ${message(error)}`)
      return null
    }
  }

  /** Where a sound's file is: one of a game sound's takes (any, as the game picks), or the character's own file. */
  url (characterId: string, sound: string | undefined): string | null {
    if (sound === undefined) return null
    if (sound.startsWith('file:sounds/')) return `/api/characters/${encodeURIComponent(characterId)}/sounds/${encodeURIComponent(sound.slice('file:sounds/'.length))}`
    const g = this.gameSound(sound)
    if (g === undefined || g.files.length === 0) return null
    const f = g.files[Math.floor(Math.random() * g.files.length)]
    return `/api/game/sounds/file/${f.split('/').map(encodeURIComponent).join('/')}`
  }

  /** A sound played as the game plays it: its mix level and pitch variation, then the event's volume and pitch. */
  async play (characterId: string, sound: string | undefined, o: { volume?: number, pitch?: number } = {}): Promise<void> {
    const url = this.url(characterId, sound)
    const ctx = this.context()
    if (url === null || ctx === null) return
    const buffer = await this.buffer(ctx, url)
    if (buffer === null) return
    const g = this.gameSound(sound)
    const vary = g !== undefined && g.pitch > 0 ? 1 + (Math.random() * 2 - 1) * g.pitch : 1
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = (o.pitch ?? 1) * vary
    const gain = ctx.createGain()
    // (its mix level counts down from the loudest sounds: a +5 dB blow plays a little louder than a 0 dB step)
    gain.gain.value = Math.min(4, (o.volume ?? 1) * Math.pow(10, Math.min(6, g?.db ?? 0) / 20) * 0.6)
    src.connect(gain).connect(ctx.destination)
    src.start()
  }

  /** A short blip (scrubbing over an event): higher for the hit, lower for steps. */
  blip (name: string): void {
    const ctx = this.context()
    if (ctx === null) return
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = name === 'hit' ? 1320 : name.startsWith('step') ? 520 : 880
    const t = ctx.currentTime
    gain.gain.setValueAtTime(0.12, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.06)
  }

  private context (): AudioContext | null {
    if (typeof AudioContext === 'undefined') return null
    this.audio ??= new AudioContext()
    if (this.audio.state === 'suspended') void this.audio.resume()
    return this.audio
  }

  private async buffer (ctx: AudioContext, url: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(url)
    if (p === undefined) {
      p = (async () => {
        try {
          const r = await fetch(url, { headers: { 'x-rigsmith': '1' } })
          if (!r.ok) return null
          return await ctx.decodeAudioData(await r.arrayBuffer())
        } catch {
          return null
        }
      })()
      this.buffers.set(url, p)
    }
    return await p
  }

  // ---- the preview -----------------------------------------------------------------------------------------------

  isMuted (characterId: string, name: string): boolean {
    return (this.muted_[characterId] ?? remembered(characterId)).includes(name)
  }

  setMuted (characterId: string, name: string, on: boolean): void {
    const was = this.muted_[characterId] ?? remembered(characterId)
    const next = on ? [...new Set([...was, name])] : was.filter(n => n !== name)
    this.muted_ = { ...this.muted_, [characterId]: next }
    try { localStorage.setItem(`rigsmith.events.muted.${characterId}`, JSON.stringify(next)) } catch { /* (not remembered) */ }
  }

  flash (name: string): void {
    const key = ++this.flashKey
    this.flashes = [...this.flashes.slice(-3), { key, name }]
    setTimeout(() => { this.flashes = this.flashes.filter(f => f.key !== key) }, FLASH_MS)
  }

  /** The events of the slot shown, as it plays now: the slot's and the blow the fit measured. */
  played (view: TimelineView): PlayedEvent[] {
    if ((view.slot.muted ?? []).includes('events')) return []
    return playedEvents(view.slot, view, measuredHit(view.baked?.cut))
  }

  /** Hear the slot `get` shows while it plays (the lane, while it is up): each event crossed played and flashed. The
   * flash overlay is up meanwhile. Returns the way to stop. */
  watch (get: () => TimelineView | null): () => void {
    let last: number | null = null
    viewer.setOverlay('event-flash', { component: EventFlash, props: {} })
    const off = animator.onTick(phase => {
      const view = get()
      const now = animator.playing
      if (view === null || now === null || now.kind !== 'slot' || now.slotId !== view.slot.id) { last = null; return }
      const from = last
      last = phase
      if (from === null || from === phase) return
      const running = animator.running
      const events = this.played(view)
      let hit: PlayedEvent[]
      if (running) hit = crossed(events, from, phase, animator.loop)
      else if (Math.abs(phase - from) > JUMP) hit = []
      else hit = phase > from ? events.filter(e => e.t > from && e.t <= phase) : events.filter(e => e.t >= phase && e.t < from)
      for (const e of hit) {
        if (this.isMuted(view.character.id, e.name)) continue
        this.flash(e.name)
        if (running) void this.play(view.character.id, e.sound, { volume: e.volume, pitch: e.pitch })
        else this.blip(e.name)
      }
    })
    if (this.game === null) void this.loadGame()
    return () => {
      off()
      viewer.setOverlay('event-flash', null)
    }
  }

  // ---- edits -----------------------------------------------------------------------------------------------------

  /** The selected events (their ids) of the view's selection. */
  selected (view: Pick<TimelineView, 'selection'>): string[] {
    return view.selection.filter(s => s.track === 'events').map(s => s.id)
  }

  async run (view: TimelineView, commands: Command[]): Promise<boolean> {
    if (commands.length === 0) return true
    return await app.do(view.character.id, commands) !== null
  }

  /** "Add footsteps": a step event where each foot comes down in the clip as it plays (none where one is already),
   * each with what a step of that name has elsewhere on the character. The number added, or null when it can't. */
  async addFootsteps (view: TimelineView): Promise<number | null> {
    const c = view.character
    const feet = feetOf(c)
    const root = animator.posableCopy()
    const clip = view.baked?.clip
    if (feet.length === 0 || root === null || clip === undefined) return null
    const steps = footsteps(root, clip, view.slot.loop, heightOf(c), feet)
    const fresh = newSteps(steps, this.played(view), 1.5 / Math.max(1, view.frames))
    const made: ClipEvent[] = []
    const commands: Command[] = []
    for (const s of fresh) {
      const slot = { ...view.slot, events: [...(view.slot.events ?? []), ...made] }
      const cmd = addEvent(slot, s.name, s.t, view, { defaults: { bone: s.bone, ...defaultsFor(c, view.slot, s.name) } })
      if (cmd.type === 'slot.event.add') made.push(cmd.event)
      commands.push(cmd)
    }
    if (commands.length === 0) return 0
    return await this.run(view, commands) ? commands.length : null
  }
}

function remembered (characterId: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(`rigsmith.events.muted.${characterId}`) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export const events = new EventsState()
