// Motion's rules as plain functions (no Svelte state, no stage): which of a character's clips are the game's slots and
// which are trials, what a library card's round button does, frames and phases (one numbering: frames of the clip as
// it plays, 30 a second), hand pose and hold windows, keys, the ground lift in the units it is shown in, the blow.
import type { Character, ClipKey, ClipRef, HandPoseRef, Slot, Window } from '../../model/types.ts'
import { slotToV2 } from '../../model/migrate.ts'
import type { V2Adjustment, V2AdjustmentKind } from '../../model/v2.ts'
import { clipUrl } from '../../engine/clips.ts'
import { KEY_FPS } from '../../engine/keys.ts'

/** A row of the adjustments stack: a setting the slot keeps (ground, a hand pose, a handle hold), or its blow fit, its
 * pace or its keys shown as one (ids FIT, PACE, KEYS), in the shape the stack has always shown (src/model/migrate.ts
 * slotToV2), until the track timeline replaces the stack (docs/motion-plan.md §9 B). Its times are source time. */
export type Row = V2Adjustment
export type RowKind = V2AdjustmentKind
export const FIT = 'fit'
export const PACE = 'pace'
export const KEYS = 'keys'

/** The slot's rows; always a keys row (keying starts there). */
export function rowsOf (slot: Slot): Row[] {
  const rows = slotToV2(slot, { rowIds: true }).adjustments
  return rows.some(a => a.kind === 'keys') ? rows : [...rows, { id: KEYS, kind: 'keys', enabled: true }]
}

/** Frames a second, everywhere a frame is shown (the timeline, key lists, the blow, windows). */
export const FPS = KEY_FPS

/** The one list of speeds offered: a slot's saved speed and the timeline's preview speed. */
export const SPEEDS: readonly number[] = [0.25, 0.5, 0.6, 0.75, 0.8, 1, 1.25, 1.5, 2]

export function speedOptions (current: number): number[] {
  return [...new Set([...SPEEDS, current])].sort((a, b) => a - b)
}

// ---- clips and slots ---------------------------------------------------------------------------------------------

/** A library clip as a slot refers to it: its url only when it isn't the converted clip's own file (a bundled clip, a
 * creature's). */
export function clipRefOf (clip: { id: string, url?: string }): ClipRef {
  return clip.url === undefined || clip.url === clipUrl(clip.id) ? { id: clip.id } : { id: clip.id, url: clip.url }
}

/** In place for a new slot of this clip: its own flag, and every walk or run (the game moves the unit itself). */
export function defaultInPlace (clip: { inPlace: boolean, category?: string }): boolean {
  return clip.inPlace || clip.category === 'locomotion'
}

/** A trial: a slot whose name the game doesn't play (kept here to compare). */
export const isTrial = (s: Pick<Slot, 'name'>, gameNames: readonly string[]): boolean => !gameNames.includes(s.name)

/** What a slot is armed to receive: a slot by id, or a game clip name with no slot yet. */
export interface Target { slotId: string | null, name: string }

/** The slot an armed target fills now: by its id while it is there, else by its name (null: a new slot). */
export function resolveTarget (c: Pick<Character, 'clips'>, t: Target): { slot: Slot | null, name: string } {
  const slot = (t.slotId === null ? undefined : c.clips.find(s => s.id === t.slotId)) ?? c.clips.find(s => s.name === t.name)
  return { slot: slot ?? null, name: slot?.name ?? t.name }
}

/** A free name for a new trial: the clip's, else its longer description, else the name numbered. Game clip names
 * count as taken, so a trial never becomes a slot by its name. */
export function trialName (c: Pick<Character, 'clips'>, gameNames: readonly string[], clip: { name: string, description?: string }): string {
  const taken = (n: string): boolean => gameNames.includes(n) || c.clips.some(s => s.name === n)
  const base = clip.name.trim() || 'Clip'
  if (!taken(base)) return base
  const description = clip.description?.trim()
  if (description !== undefined && description !== '' && !taken(description)) return description
  for (let i = 2; ; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`
}

/** Why a slot can't take this name, or null. */
export function nameProblem (c: Pick<Character, 'clips'>, slotId: string, name: string): string | null {
  const n = name.trim()
  if (n === '') return 'Give it a name'
  return c.clips.some(s => s.id !== slotId && s.name === n) ? `Another clip is named ${n}` : null
}

/** Which of the character's clips play a library clip. */
export function usesOf (c: Pick<Character, 'clips'>, clipId: string, gameNames: readonly string[]): { slots: Slot[], trials: Slot[] } {
  const using = c.clips.filter(s => s.clip.id === clipId)
  return { slots: using.filter(s => !isTrial(s, gameNames)), trials: using.filter(s => isTrial(s, gameNames)) }
}

/** What a library card's round button does: an armed slot is filled; trials of the clip are taken out (a slot's
 * clip never is, from a card); otherwise the clip is added as a trial. */
export type CardAction = { kind: 'fill', target: Target } | { kind: 'remove', trials: Slot[] } | { kind: 'add' }

export function cardAction (c: Pick<Character, 'clips'>, clipId: string, gameNames: readonly string[], armed: Target | null): CardAction {
  if (armed !== null) return { kind: 'fill', target: armed }
  const { trials } = usesOf(c, clipId, gameNames)
  return trials.length > 0 ? { kind: 'remove', trials } : { kind: 'add' }
}

/** `ids` with `moved` put just before `before` (null: at the end). */
export function moveBefore (ids: readonly string[], moved: string, before: string | null): string[] {
  if (moved === before || !ids.includes(moved)) return [...ids]
  const rest = ids.filter(i => i !== moved)
  const at = before === null ? -1 : rest.indexOf(before)
  if (at < 0) return [...rest, moved]
  return [...rest.slice(0, at), moved, ...rest.slice(at)]
}

/** A clip's name without its library prefix, as a label. */
export const clipLabel = (ref: ClipRef): string => ref.id.replace(/^(mixamo|custom|human|horse)-/, '').replace(/[_-]+/g, ' ')

// ---- frames and phases ---------------------------------------------------------------------------------------------

/** Frames of a clip as it plays (`cycles`: a ridden loop holds several of the slot's own cycles; a phase is within one). */
export function framesOf (duration: number, cycles = 1): number {
  return Math.max(1, Math.round(duration / Math.max(1, cycles) * FPS))
}

export const frameOf = (u: number, frames: number): number => Math.round(Math.min(1, Math.max(0, u)) * frames)

/** A phase on the nearest frame. */
export const snapPhase = (u: number, frames: number): number => frameOf(u, frames) / frames

/** The phase of the slot's own clip at `at` of the clip playing (which holds `cycles` of it): a loop's wraps round, a
 * one-shot's end is its end. */
export function phaseIn (at: number, cycles: number, loop: boolean): number {
  const x = Math.min(1, Math.max(0, at)) * Math.max(1, cycles)
  if (!loop && cycles <= 1) return Math.min(1, x)
  return x >= Math.max(1, cycles) ? 1 : x % 1
}

/** Which of a ridden loop's cycles `at` (of the clip playing) is in. */
export function cycleAt (at: number, cycles: number): number {
  const n = Math.max(1, Math.round(cycles))
  return Math.min(n - 1, Math.max(0, Math.floor(Math.min(1, Math.max(0, at)) * n)))
}

/** The time in the clip playing of phase `u` of the slot's own clip, in cycle `cycle` of `cycles`. */
export function timeAt (u: number, cycle: number, cycles: number, duration: number): number {
  const n = Math.max(1, Math.round(cycles))
  return Math.min(duration, Math.max(0, (Math.min(n - 1, Math.max(0, cycle)) + Math.min(1, Math.max(0, u))) / n * duration))
}

/** Windows of one cycle laid over every cycle of the clip playing (phases of all of it), for the timeline. */
export function overCycles (windows: readonly Window[], cycles: number): Window[] {
  const n = Math.max(1, Math.round(cycles))
  return Array.from({ length: n }, (_, k) => windows.map(([a, b]): Window => [(a + k) / n, (b + k) / n])).flat()
}

/** Phases of one cycle laid over every cycle of the clip playing. */
export function phasesOverCycles (us: readonly number[], cycles: number): number[] {
  const n = Math.max(1, Math.round(cycles))
  return Array.from({ length: n }, (_, k) => us.map(u => (u + k) / n)).flat()
}

// ---- windows -------------------------------------------------------------------------------------------------------

const WHOLE: Window = [0, 1]
const MIN_WINDOW = 0.02

/** Room for a new hand pose beside the hand's other ones: undefined when there are none (the whole clip), the widest
 * gap left, or null when none is wide enough. */
export function freeWindows (taken: readonly Window[]): Window[] | undefined | null {
  if (taken.length === 0) return undefined
  const sorted = [...taken].sort((a, b) => a[0] - b[0])
  let best: Window | null = null
  let at = 0
  for (const [a, b] of [...sorted, [1, 1] as Window]) {
    if (a - at > (best === null ? 0.05 : best[1] - best[0])) best = [round3(at), round3(a)]
    at = Math.max(at, b)
  }
  return best === null ? null : [best]
}

/** One window's start (edge 0) or end (edge 1) moved to `u`; null when that leaves it empty or overlapping another. */
export function moveEdge (windows: readonly Window[], i: number, edge: 0 | 1, u: number): Window[] | null {
  const w = windows[i]
  if (w === undefined) return null
  const next: Window = edge === 0 ? [round3(u), w[1]] : [w[0], round3(u)]
  if (!(next[0] >= 0 && next[1] <= 1 && next[1] - next[0] >= MIN_WINDOW - 1e-9)) return null
  const out = windows.map((x, k) => (k === i ? next : x))
  return overlapping(out) ? null : sortWindows(out)
}

/** A new window starting at `u` (as long as the gap after it allows, at most a fifth of the clip); null: no room. */
export function addWindow (windows: readonly Window[], u: number): Window[] | null {
  const from = round3(Math.min(1 - MIN_WINDOW, Math.max(0, u)))
  if (windows.some(([a, b]) => from >= a && from < b)) return null
  const next = Math.min(1, ...windows.filter(([a]) => a > from).map(([a]) => a))
  const to = round3(Math.min(next, from + 0.2))
  if (to - from < MIN_WINDOW - 1e-9) return null
  return sortWindows([...windows, [from, to]])
}

export function sortWindows (windows: readonly Window[]): Window[] {
  return [...windows].sort((a, b) => a[0] - b[0]).map(([a, b]): Window => [a, b])
}

export function overlapping (windows: readonly Window[]): boolean {
  const s = sortWindows(windows)
  return s.some((w, i) => i > 0 && w[0] < s[i - 1][1])
}

// The one way a window is shown, in every step (Motion, Gear's holds, the Hands panel): "frames 12–30" when the clip's
// frames are known (it plays), else as parts of the clip, "40–75%".

/** One window: "frames 12–30", else "40–75%"; [0, 1] is "the whole clip". */
export function windowText (w: Window, frames: number | null = null): string {
  if (w[0] <= 0 && w[1] >= 1) return 'the whole clip'
  return frames === null ? `${Math.round(w[0] * 100)}–${Math.round(w[1] * 100)}%` : `frames ${frameOf(w[0], frames)}–${frameOf(w[1], frames)}`
}

/** Windows, comma separated: unset is "the whole clip", none is "never". */
export function windowsText (windows: readonly Window[] | undefined, frames: number | null = null): string {
  if (windows === undefined) return 'the whole clip'
  if (windows.length === 0) return 'never'
  return windows.map(w => windowText(w, frames)).join(', ')
}

/** Windows a hand's other hand poses in the slot take (they may not overlap a new one; source time). */
export function handWindows (slot: Pick<Slot, 'adjustments'>, hand: string, except?: string): Window[] {
  return slot.adjustments.flatMap(a => (a.kind === 'handPose' && a.hand === hand && a.id !== except ? a.windows ?? [WHOLE] : []))
}

// ---- keys ----------------------------------------------------------------------------------------------------------

type KeysAdjustment = Extract<Row, { kind: 'keys' }>

/** A key target: 'bone:<name>' or 'gear:<gear id>'. */
export function targetOf (target: string): { kind: 'bones' | 'gear', name: string } | null {
  if (target.startsWith('bone:')) return { kind: 'bones', name: target.slice(5) }
  if (target.startsWith('gear:')) return { kind: 'gear', name: target.slice(5) }
  return null
}

/** A target's keys on the slot (source time, eases kept). */
export function keysOf (slot: Pick<Slot, 'bones' | 'gear'> | undefined, target: string): ClipKey[] {
  const t = targetOf(target)
  if (t === null || slot === undefined) return []
  return t.kind === 'bones' ? slot.bones?.[t.name] ?? [] : slot.gear?.[t.name]?.keys ?? []
}

/** `keys` with `key` in it (replacing one on the same frame), in order. */
export function withKey (keys: readonly ClipKey[], key: ClipKey): ClipKey[] {
  return [...keys.filter(k => Math.abs(k.u - key.u) > 1e-4), key].sort((a, b) => a.u - b.u)
}

/** The keys adjustment's bones and gear with `target`'s keys set to `keys` (left out when none); null when nothing is
 * keyed any more. */
export function keysWith (a: KeysAdjustment | undefined, target: string, keys: ClipKey[]): { bones?: Record<string, ClipKey[]>, gear?: Record<string, ClipKey[]> } | null {
  const t = targetOf(target)
  const bones = { ...a?.bones }
  const gear = { ...a?.gear }
  if (t !== null) {
    const table = t.kind === 'bones' ? bones : gear
    if (keys.length > 0) table[t.name] = keys
    else delete table[t.name]
  }
  const out: { bones?: Record<string, ClipKey[]>, gear?: Record<string, ClipKey[]> } = {}
  if (Object.keys(bones).length > 0) out.bones = bones
  if (Object.keys(gear).length > 0) out.gear = gear
  return out.bones === undefined && out.gear === undefined ? null : out
}

/** A key in words: "no change", "12°", "12° + move". */
export function keyText (k: ClipKey): string {
  const deg = Math.round(2 * Math.acos(Math.min(1, Math.abs(k.q[3]))) * 180 / Math.PI)
  const moves = k.p !== undefined && Math.hypot(...k.p) > 1e-6
  if (deg === 0 && !moves) return 'no change'
  return `${deg}°${moves ? ' + move' : ''}`
}

// ---- the ground ----------------------------------------------------------------------------------------------------

/** cm in the game per character unit (the unit's game height over the character's own), or null without a unit. */
export function cmPerUnit (gameHeight: number | null | undefined, height: number): number | null {
  return gameHeight === null || gameHeight === undefined || !(height > 0) ? null : gameHeight / height * 100
}

/** A lift (character units) as shown: cm in the game, else % of the character's height. */
export function liftShown (lift: number, perCm: number | null, height: number): number {
  return perCm !== null ? Math.round(lift * perCm * 10) / 10 : Math.round(lift / (height || 1) * 1000) / 10
}

export function liftFromShown (shown: number, perCm: number | null, height: number): number {
  return round4(perCm !== null ? shown / perCm : shown / 100 * (height || 1))
}

// ---- the blow ------------------------------------------------------------------------------------------------------

/** How a blow timing cut its clip (bake.ts BakedSlot.cut): seconds of the clip at its speed, before the cut. */
export interface Cut { start: number, end: number, uncut: number, blow: number }

/** A blow can't be on the clip's first or last frame (it would cut the attack down to nothing). */
export const BLOW_EDGE = 1 / FPS

/** The blow at `t` seconds into the clip as it plays, as a phase of the uncut clip; null on its first or last frame
 * or past its end. Without a cut (the timing switched off) the clip plays uncut. */
export function blowUAt (cut: Cut | undefined, duration: number, t: number): number | null {
  const c = cut ?? { start: 0, end: duration, uncut: duration, blow: 0 }
  const x = c.start + t
  if (!(c.uncut > 0) || x < BLOW_EDGE - 1e-9 || x > c.uncut - BLOW_EDGE + 1e-9) return null
  return round4(x / c.uncut)
}

/** The frame of the clip as it plays that its blow lands on. */
export const blowFrame = (cut: Cut): number => Math.round((cut.blow - cut.start) * FPS)

/** Where the blow lands, as a phase of the cut clip (what a pace after it doesn't move). */
export function blowPhase (cut: Cut): number {
  const span = cut.end - cut.start
  return span > 0 ? Math.min(1, Math.max(0, (cut.blow - cut.start) / span)) : 0
}

/** The blow's phase of the uncut clip from the phase playing: `cut` is how the clip was cut (none: it plays uncut,
 * `duration` long). Null on its first or last frame, or past its end (a held end). */
export function blowUAtPhase (cut: Cut | undefined, phase: number, duration: number): number | null {
  if (cut === undefined) return blowUAt(undefined, duration, phase * duration)
  return blowUAt(cut, cut.end - cut.start, phase * (cut.end - cut.start))
}

/** What a blow later than where it must land costs (its start cut, or its end held), or null. */
export function lateness (a: { at: number, blowU?: number, late?: 'cut' | 'hold', window?: number }, cut: Cut | undefined): string | null {
  if (a.window !== undefined || cut === undefined) return null
  const u = a.blowU ?? (cut.uncut > 0 ? cut.blow / cut.uncut : 0)
  if (u <= a.at) return null
  return a.late === 'hold'
    ? `The blow comes at ${Math.round(u * 100)}%: the last pose is held ${Math.max(0, cut.end - cut.uncut).toFixed(2)} s`
    : `The blow comes at ${Math.round(u * 100)}%: the first ${cut.start.toFixed(2)} s are cut`
}

// ---- holds ---------------------------------------------------------------------------------------------------------

/** When a pull is held, from the pulling bone's distance to the strand through the clip (evenly sampled, first to
 * last frame): from when it first comes within `reach`, until the release (a phase, when after that) or until it
 * goes `drawn` away. Null when it never comes near. */
export function holdFromDistances (dist: readonly number[], reach: number, drawn: number, release: number | null): Window | null {
  const n = dist.length - 1
  if (n < 1) return null
  const start = dist.findIndex(d => d <= reach)
  if (start < 0) return null
  let end = start
  if (release !== null && release * n > start) end = Math.min(n, Math.round(release * n))
  else while (end + 1 <= n && dist[end + 1] <= drawn) end++
  if (end <= start) end = Math.min(n, start + 1)
  if (end <= start) return null
  return [round3(start / n), round3(end / n)]
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4

// ---- the adjustments stack -------------------------------------------------------------------------------------------

/** The kinds in the order the bake applies them (src/engine/bake.ts): the stack lists them so. */
export const KIND_ORDER: readonly RowKind[] = ['blowTiming', 'pace', 'handPose', 'handleHold', 'ground', 'keys']

export const KIND_LABEL: Record<RowKind, string> = {
  blowTiming: 'Blow timing', pace: 'Pace', handPose: 'Hand pose', handleHold: 'Handle hold', ground: 'Ground', keys: 'Keys',
}

export const KIND_HINT: Record<RowKind, string> = {
  blowTiming: 'Cut an attack so its blow lands where the game times hits',
  pace: 'Retime it so its planted foot covers ground as fast as another clip\'s',
  handPose: 'Pose a hand in this clip (all of it, or in windows)',
  handleHold: 'Hold a pull handle (a bowstring) in windows of this clip',
  ground: 'Raise or lower the whole body so its feet meet the floor',
  keys: 'Keyed turns on bones, and moves and turns of gear',
}

/** The slot's rows in the bake's order (same kind: as listed). */
export function inBakeOrder (adjustments: readonly Row[]): Row[] {
  return [...adjustments].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
}

/** One of these at most per slot (the commands refuse a second). */
export const ONE_PER_SLOT: readonly RowKind[] = ['ground', 'blowTiming', 'pace', 'keys']

/** The kinds a slot can take one more of: those it has none of yet (for one-per-slot kinds), a pace when there is
 * another clip to follow, a hold while a pull handle is left unheld. */
export function addableKinds (slot: Slot, o: { otherSlots: number, pulls: number }): RowKind[] {
  const rows = rowsOf(slot)
  const holds = rows.filter(a => a.kind === 'handleHold').length
  return KIND_ORDER.filter(k => {
    if (ONE_PER_SLOT.includes(k) && rows.some(a => a.kind === k)) return false
    if (k === 'pace') return o.otherSlots > 0
    if (k === 'handleHold') return holds < o.pulls
    return true
  })
}

/** An adjustment in a few words, for the stack's header line. `frames`: of the clip as it plays (null: not playing). */
export function adjustmentText (c: Pick<Character, 'clips' | 'gear'>, a: Row, o: { frames: number | null, lift?: (lift: number) => string, pose?: (ref: HandPoseRef) => string }): string {
  switch (a.kind) {
    case 'ground': return o.lift?.(a.lift) ?? `lift ${Math.round(a.lift * 1000) / 1000}`
    case 'blowTiming': return `lands at ${Math.round(a.at * 100)}%${a.window !== undefined ? `, ${a.window} s round it` : ''}${a.blowU !== undefined ? ', blow set by hand' : ''}`
    case 'pace': return `like ${c.clips.find(s => s.id === a.like)?.name ?? 'a clip that is gone'}`
    case 'handPose': {
      const gear = a.gear === undefined ? '' : ` (letting go of ${c.gear.find(g => g.id === a.gear)?.name ?? 'gear'})`
      return `${a.hand} hand ${o.pose?.(a.pose) ?? 'posed'}, ${windowsText(a.windows, o.frames)}${gear}`
    }
    case 'handleHold': {
      const g = c.gear.find(x => x.id === a.gear)
      const h = g?.handles.find(x => x.id === a.handle)
      return `${g?.name ?? 'gear'} · ${h?.name ?? 'handle'}, ${windowsText(a.windows, o.frames)}`
    }
    case 'keys': {
      const bones = Object.values(a.bones ?? {}).filter(k => k.length > 0).length
      const gear = Object.values(a.gear ?? {}).filter(k => k.length > 0).length
      if (bones + gear === 0) return 'nothing keyed yet'
      return [bones > 0 ? `${bones} bone${bones === 1 ? '' : 's'}` : '', gear > 0 ? `${gear} gear` : ''].filter(Boolean).join(', ')
    }
  }
}
