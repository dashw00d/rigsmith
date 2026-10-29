// The one place each derived fact about a character is computed: its effective skeleton, what state it is in, which
// gear a hand carries, its size. Pure and synchronous; the server, the app and the tools all ask here.
import { hierarchyOf } from './skeletons.ts'
import type { Character, ClipEvent, ClipKey, Gear, GearTrack, Handle, Job, Joints, Side, Slot } from './types.ts'

export { hierarchyOf }

/** The fist a hand closes to when nothing says otherwise (HandPoseRef 'default'): the most closed moment of this
 * library clip. */
export const DEFAULT_FIST = 'mixamo-Great_Sword_Crouching_6'

const SIDES: Side[] = ['Left', 'Right']

/** The effective skeleton: the generator's joints with the user's placements on top, only the joints the skeleton
 * has. At the full finger level a hand without a Middle1 drops its Index chain: it was the middle of a mitten (one
 * and two fingers), never an index finger, so the rig job and the finger trace place a real one. */
export function jointsOf (c: Pick<Character, 'skeleton'>): Joints {
  const all: Joints = { ...c.skeleton.detected, ...c.skeleton.overrides }
  const out: Joints = {}
  for (const [joint] of hierarchyOf(c)) {
    const p = all[joint]
    if (p !== undefined) out[joint] = [p[0], p[1], p[2]]
  }
  if (c.skeleton.template === 'human' && c.skeleton.fingerLevel === 'full') {
    for (const side of SIDES) {
      if (out[`${side}HandMiddle1`] !== undefined) continue
      for (let i = 1; i <= 4; i++) delete out[`${side}HandIndex${i}`]
    }
  }
  return out
}

export type Phase = 'importing' | 'error' | 'animation-only' | 'needs-conversion' | 'needs-rig' | 'rigging' | 'rigged'
export type Tone = 'muted' | 'busy' | 'ok' | 'warn' | 'error'

/** Where a character stands, for every place that shows it (list, top bar, steps, viewer). `job`: its queued or
 * running job, if any, whose message then stands in the label. The rig counts only while it was built for the
 * skeleton the character has now (an undone template switch or finger level needs no file changes to be right). */
export function phaseOf (c: Pick<Character, 'status' | 'error' | 'source' | 'skeleton' | 'skin'>, job?: Job | null): { phase: Phase, label: string, tone: Tone } {
  const active = job !== undefined && job !== null && (job.status === 'queued' || job.status === 'running') ? job : null
  const busy = (phase: Phase, label: string): { phase: Phase, label: string, tone: Tone } =>
    ({ phase, label: active === null ? label : active.status === 'queued' ? 'Queued' : active.message || active.label, tone: 'busy' })
  if (c.status === 'importing' || active?.kind === 'inspect' || active?.kind === 'reimport') return busy('importing', 'Importing')
  if (c.status === 'rigging' || active?.kind === 'rig') return busy('rigging', 'Rigging')
  const settled = ((): { phase: Phase, label: string, tone: Tone } => {
    if (c.status === 'error') return { phase: 'error', label: c.error?.split('\n')[0].trim() || 'Failed', tone: 'error' }
    if (c.source.kind === 'animation') return { phase: 'animation-only', label: 'Animation only', tone: 'muted' }
    if (c.source.kind === 'rigged' && c.skeleton.converted !== true) return { phase: 'needs-conversion', label: 'Needs converting', tone: 'warn' }
    if (c.status !== 'rigged') return { phase: 'needs-rig', label: 'Needs rig', tone: 'warn' }
    if (!sameKeys(c.skin.rigJoints, hierarchyOf(c))) return { phase: 'needs-rig', label: 'Needs rig again', tone: 'warn' }
    return { phase: 'rigged', label: 'Rigged', tone: 'ok' }
  })()
  return active === null ? settled : busy(settled.phase, settled.label)
}

function sameKeys (joints: Joints | undefined, hierarchy: Array<[string, string | null]>): boolean {
  if (joints === undefined) return false
  const names = Object.keys(joints)
  if (names.length !== hierarchy.length) return false
  const want = new Set(hierarchy.map(([j]) => j))
  return names.every(j => want.has(j))
}

export const slotById = (c: Pick<Character, 'clips'>, id: string): Slot | undefined => c.clips.find(s => s.id === id)
export const slotByName = (c: Pick<Character, 'clips'>, name: string): Slot | undefined => c.clips.find(s => s.name === name)
export const gearById = (c: Pick<Character, 'gear'>, id: string): Gear | undefined => c.gear.find(g => g.id === id)

/** By name, else by its bone-safe form (unique among a character's gear), so 'Gear Axe' finds 'Gear_Axe'. */
export function gearByName (c: Pick<Character, 'gear'>, name: string): Gear | undefined {
  const safe = safeName(name)
  return c.gear.find(g => g.name === name) ?? c.gear.find(g => safeName(g.name) === safe)
}

export const carryHandle = (g: Gear): Handle | undefined => g.handles.find(h => h.kind === 'carry')

/** The hand a bone is, if it is one. */
export function handSide (bone: string): Side | null {
  return bone === 'LeftHand' ? 'Left' : bone === 'RightHand' ? 'Right' : null
}

/** The gear a hand carries: the first ready, shown piece on that hand bone with a carry handle. */
export function carriedBy (c: Pick<Character, 'gear'>, side: Side): Gear | undefined {
  return c.gear.find(g => g.status === 'ready' && g.hidden !== true && g.attach.kind === 'bone' && g.attach.bone === `${side}Hand` &&
    carryHandle(g) !== undefined)
}

/** Its height as measured (at import, kept by every resize): the one size of the character itself. */
export const heightOf = (c: Pick<Character, 'source'>): number => c.source.stats?.height ?? 1

/** A copy of a set of slots with fresh ids for the slots and what they hold by id (adjustments, events, markers,
 * holds), a pace following a slot of the set following its copy (for clips.replace). JSON-copied, so live (proxied) app
 * state can be passed. */
export function freshSet (slots: Slot[], newId: () => string): Slot[] {
  const copy = JSON.parse(JSON.stringify(slots)) as Slot[]
  const ids = new Map(copy.map(s => [s.id, newId()]))
  for (const s of copy) {
    s.id = ids.get(s.id)!
    for (const a of s.adjustments) a.id = newId()
    for (const e of s.events ?? []) e.id = newId()
    for (const m of s.time?.markers ?? []) m.id = newId()
    for (const h of s.time?.holds ?? []) h.id = newId()
    if (s.time?.pace !== undefined) s.time.pace.like = ids.get(s.time.pace.like) ?? s.time.pace.like
  }
  return copy
}

/** A library clip's gear paths (keyed by gear name, shared across characters) keyed by this character's gear ids;
 * names it has no gear for are left out. */
export function gearKeysFromPaths (c: Pick<Character, 'gear'>, paths: Record<string, ClipKey[]>): Record<string, ClipKey[]> {
  const out: Record<string, ClipKey[]> = {}
  for (const [name, keys] of Object.entries(paths)) {
    const g = gearByName(c, name)
    if (g !== undefined) out[g.id] = keys
  }
  return out
}

/** Keys on gear (gear id -> keys) as a slot's gear tracks. */
export function gearTracksOf (keys: Record<string, ClipKey[]>): Record<string, GearTrack> {
  return Object.fromEntries(Object.entries(keys).filter(([, ks]) => ks.length > 0).map(([id, ks]) => [id, { keys: ks }]))
}

/** A slot's keys on gear (gear id -> keys), every piece that has some. */
export function gearKeysOf (slot: Pick<Slot, 'gear'>): Record<string, ClipKey[]> {
  return Object.fromEntries(Object.entries(slot.gear ?? {}).filter(([, t]) => (t.keys?.length ?? 0) > 0).map(([id, t]) => [id, t.keys!]))
}

/** Whether a slot plays a track: 'bones' (a bone's keys: `name` the bone), 'gear' (a piece's keys: `name` its id), or
 * 'events'. */
export function isMuted (slot: Pick<Slot, 'muted'>, track: 'bones' | 'gear' | 'events', name?: string): boolean {
  const m = slot.muted
  if (m === undefined || m.length === 0) return false
  if (m.includes(track)) return true
  return name !== undefined && m.includes(`${track === 'bones' ? 'bone' : 'gear'}:${name}`)
}

/** A slot's events (none: []). */
export const eventsOf = (slot: Pick<Slot, 'events'>): ClipEvent[] => slot.events ?? []

/** The slot's blow, picked by hand: its point `hit` event (none: the blow fit measures it). */
export const hitOf = (slot: Pick<Slot, 'events'>): ClipEvent | undefined => slot.events?.find(e => e.name === 'hit' && e.to === undefined)

/** Whether anything is keyed in the slot (bones or gear). */
export function hasKeys (slot: Pick<Slot, 'bones' | 'gear'>): boolean {
  return Object.values(slot.bones ?? {}).some(k => k.length > 0) || Object.values(slot.gear ?? {}).some(t => (t.keys?.length ?? 0) > 0)
}

/** A name as a bone or node may carry it: every run of other characters than letters, digits and _ becomes one _. */
export const safeName = (name: string): string => name.replace(/[^\w]+/g, '_')
