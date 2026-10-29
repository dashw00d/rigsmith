// The Events track's words (docs/motion-plan.md §2.4): the built-in names the game reads (hit, release, swing, draw,
// step.L, step.R) and the character's own, one vocabulary per character, so a name typed in one clip is the name the
// others use ("Step.l" is step.L; "whoosh" typed again is the whoosh already there). A new event of a name the
// character has used before takes that one's sound, bone, volume and pitch; a built-in its own defaults (a release from
// the bow hand, a step from its foot). Pure.
import { hierarchyOf } from '../../../model/skeletons.ts'
import { EVENT_NAMES, MAX_U, type Character, type ClipEvent, type Slot } from '../../../model/types.ts'

export type BuiltInName = typeof EVENT_NAMES[number]

/** What the game does with each built-in, in the words the menu shows. `span`: added as a span (a draw lasts). */
export const BUILT_INS: Record<BuiltInName, { label: string, hint: string, span: boolean }> = {
  hit: { label: 'Hit', hint: 'The blow lands: the fit lands it at its share of the clip, the game deals the damage there', span: false },
  release: { label: 'Release', hint: 'Something leaves the hand: the arrow or javelin flies from its bone', span: false },
  swing: { label: 'Swing', hint: 'A weapon swung through the air (a whoosh)', span: false },
  draw: { label: 'Draw', hint: 'A bow drawn, a blade pulled: from its start to its end', span: true },
  'step.L': { label: 'Left foot down', hint: 'The left foot lands (a footstep)', span: false },
  'step.R': { label: 'Right foot down', hint: 'The right foot lands (a footstep)', span: false },
}

/** The names an event may have: a letter, then letters, digits, '.', '_' or '-' (32 at most; the command's rule). */
export const NAME = /^[A-Za-z][\w.-]{0,31}$/

export const isBuiltIn = (name: string): name is BuiltInName => (EVENT_NAMES as readonly string[]).includes(name)

/** A name as the menu and the lane show it. */
export const labelOf = (name: string): string => (isBuiltIn(name) ? BUILT_INS[name].label : name)

export interface Word { name: string, builtIn: boolean, uses: number }

/** The character's vocabulary: every built-in (in the game's order), then the names of its own it has used in any
 * slot, the most used first. */
export function vocabulary (c: Pick<Character, 'clips'>): Word[] {
  const uses = new Map<string, number>()
  for (const s of c.clips) for (const e of s.events ?? []) uses.set(e.name, (uses.get(e.name) ?? 0) + 1)
  const own = [...uses.entries()].filter(([n]) => !isBuiltIn(n)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return [
    ...EVENT_NAMES.map(name => ({ name, builtIn: true, uses: uses.get(name) ?? 0 })),
    ...own.map(([name, n]) => ({ name, builtIn: false, uses: n })),
  ]
}

/** What is wrong with a typed name (null: nothing). */
export function nameProblem (typed: string): string | null {
  const t = typed.trim()
  if (t === '') return 'Name it'
  if (t.length > 32) return 'At most 32 characters'
  if (!/^[A-Za-z]/.test(t)) return 'Start with a letter'
  if (!NAME.test(t)) return "Letters, digits, '.', '_' or '-' only"
  return null
}

/** A typed name as the character spells it: a built-in or a name it uses already, matched without case; else the
 * name as typed (trimmed). Null when it isn't a name. */
export function canonical (c: Pick<Character, 'clips'>, typed: string): string | null {
  const t = typed.trim()
  if (nameProblem(t) !== null) return null
  const known = vocabulary(c).find(w => w.name.toLowerCase() === t.toLowerCase())
  return known?.name ?? t
}

/** The joints of the character's skeleton, by name. */
export const boneNames = (c: Pick<Character, 'skeleton'>): string[] => hierarchyOf(c).map(([j]) => j)

/** The bow hand: the bone a piece with a pull handle (a bow) rides; else the hand the slot's blow is timed by; else the
 * right hand. An arrow released leaves from there. */
export function releaseBone (c: Pick<Character, 'gear' | 'skeleton'>, slot: Pick<Slot, 'time'>): string {
  const bow = c.gear.find(g => g.attach.kind === 'bone' && g.handles.some(h => h.kind === 'pull'))
  if (bow?.attach.kind === 'bone') return bow.attach.bone
  return slot.time?.fit?.hand ?? 'RightHand'
}

/** What a new event of `name` starts with: the last one of that name the character has (its sound, bone, volume and
 * pitch), else a built-in's own (a release from the bow hand; a step from its foot, when the skeleton has it). */
export function defaultsFor (c: Pick<Character, 'clips' | 'gear' | 'skeleton'>, slot: Pick<Slot, 'id' | 'time'>, name: string): Partial<Pick<ClipEvent, 'sound' | 'bone' | 'volume' | 'pitch'>> {
  const same = [...c.clips.filter(s => s.id === slot.id), ...c.clips.filter(s => s.id !== slot.id)]
    .flatMap(s => (s.events ?? []).filter(e => e.name === name))
  const like = same.find(e => e.sound !== undefined || e.bone !== undefined) ?? same[0]
  if (like !== undefined) {
    return {
      ...(like.sound !== undefined ? { sound: like.sound } : {}), ...(like.bone !== undefined ? { bone: like.bone } : {}),
      ...(like.volume !== undefined ? { volume: like.volume } : {}), ...(like.pitch !== undefined ? { pitch: like.pitch } : {}),
    }
  }
  const joints = boneNames(c)
  if (name === 'release') return { bone: releaseBone(c, slot) }
  if (name === 'step.L' && joints.includes('LeftFoot')) return { bone: 'LeftFoot' }
  if (name === 'step.R' && joints.includes('RightFoot')) return { bone: 'RightFoot' }
  return {}
}

/** The lane's rows: the names the slot's events have (the hit always, while the fit measures one), the built-ins in
 * the game's order first, then its own by name. */
export function rowsOf (events: Pick<ClipEvent, 'name'>[], measuredHit: boolean): string[] {
  const names = new Set(events.map(e => e.name))
  if (measuredHit) names.add('hit')
  const builtIn = EVENT_NAMES.filter(n => names.has(n))
  const own = [...names].filter(n => !isBuiltIn(n)).sort((a, b) => a.localeCompare(b))
  return [...builtIn, ...own]
}

/** A new event id, not one of the slot's. */
export function newEventId (slot: Pick<Slot, 'events'>, random: () => number = Math.random): string {
  const taken = new Set((slot.events ?? []).map(e => e.id))
  for (;;) {
    const id = Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0')
    if (!taken.has(id)) return id
  }
}

/** A source phase kept where the commands take it. */
export const clampU = (u: number): number => Math.min(MAX_U, Math.max(0, u))
