// slot.* and clips.*: the character's set of clips (slots: the game's clip names and trials), each its source clip, its
// time map and its tracks (docs/motion-plan.md §2, §4). Every time a command carries is source time. Rules kept here:
// slot names unique; one ground per slot; one hold per (gear, handle); a hand's hand pose windows never overlap; within a
// track keys are sorted and no two share a moment; a slot's event ids are unique and it has at most one point `hit`;
// retime markers run forward in both times, holds sit at distinct moments; every reference (a paced-like slot, gear, a
// handle, a bone keyed) resolves.
import type { Command, KeyTrack } from '../command-types.ts'
import { carryHandle, gearById, gearByName, slotById, slotByName } from '../select.ts'
import type {
  Adjustment, AdjustmentKind, BlowFit, Character, ClipEvent, ClipKey, Gear, GearTrack, Handle, RetimeMarker, Slot, SlotIk, SlotTime, TimeHold, Window,
} from '../types.ts'
import {
  bad, bool, clipKeys, clipRef, conflict, handPoseRef, id, joint, list, missing, name, names, note, num, obj, oneOf, opt, overlaps,
  pct, placement, plural, r3, record, refText, reorder, same, side, sourceU, str, unknown, windows, windowsText, type Obj,
} from './common.ts'

export type ClipsCommand = Extract<Command, { type: `slot.${string}` | `clips.${string}` }>

const KINDS: AdjustmentKind[] = ['ground', 'handPose', 'handleHold']
/** Schema 2's kinds that are a slot's time and tracks now. */
const MOVED: Record<string, string> = { blowTiming: 'slot.time (fit)', pace: 'slot.time (pace)', keys: 'slot.keys.set' }
/** What each kind holds besides id, kind, enabled and note. */
const FIELDS: Record<AdjustmentKind, string[]> = { ground: ['lift'], handPose: ['hand', 'pose', 'windows', 'gear'], handleHold: ['gear', 'handle', 'windows'] }
const ONE_PER_SLOT: AdjustmentKind[] = ['ground']
const KIND_TEXT: Record<AdjustmentKind, string> = { ground: 'ground', handPose: 'hand pose', handleHold: 'handle hold' }
const WHOLE: Window[] = [[0, 1]]
/** An event's name: a letter, then letters, digits, '.', '_' or '-'. */
const EVENT_NAME = /^[A-Za-z][\w.-]{0,31}$/
const SOUND = /^(mix|file):\S.*$/
const MUTED = /^(bones|gear|events|bone:.+|gear:[\w-]+)$/

// ---- what a command carries, checked ---------------------------------------------------------------------------------

/** An adjustment as given; its references are checked against the character by refs(). */
function adjustment (v: unknown, what: string): Adjustment {
  const a = obj(v, what)
  const f = (k: string): string => `${what}.${k}`
  if (typeof a.kind === 'string' && MOVED[a.kind] !== undefined) bad(`${f('kind')} ${a.kind} is the slot's ${MOVED[a.kind]} now`)
  const kind = oneOf(a.kind, KINDS, f('kind'))
  const text = note(a.note, f('note'))
  const base = { id: id(a.id, f('id')), enabled: a.enabled === undefined ? true : bool(a.enabled, f('enabled')), ...(text !== undefined ? { note: text } : {}) }
  switch (kind) {
    case 'ground': return { ...base, kind, lift: num(a.lift, f('lift')) }
    case 'handPose': {
      const w = opt(a.windows, x => windows(x, f('windows')))
      if (w !== undefined && w.length === 0) bad(`${f('windows')} can't be empty (leave them out for the whole clip)`)
      const gear = opt(a.gear, x => id(x, f('gear')))
      return {
        ...base, kind, hand: side(a.hand, f('hand')), pose: handPoseRef(a.pose, f('pose')),
        ...(w !== undefined ? { windows: w } : {}), ...(gear !== undefined ? { gear } : {}),
      }
    }
    case 'handleHold': return { ...base, kind, gear: id(a.gear, f('gear')), handle: id(a.handle, f('handle')), windows: windows(a.windows, f('windows')) }
  }
}

function fitOf (v: unknown, what: string): BlowFit {
  const f = obj(v, what)
  const late = opt(f.late, x => oneOf(x, ['cut', 'hold'] as const, `${what}.late`))
  const window = opt(f.window, x => num(x, `${what}.window`, { above: 0 }))
  const hand = opt(f.hand, x => str(x, `${what}.hand`))
  return {
    enabled: f.enabled === undefined ? true : bool(f.enabled, `${what}.enabled`), at: num(f.at, `${what}.at`, { min: 0, max: 1 }),
    ...(late !== undefined ? { late } : {}), ...(window !== undefined ? { window } : {}), ...(hand !== undefined ? { hand } : {}),
  }
}

function paceOf (v: unknown, what: string): { enabled: boolean, like: string } {
  const p = obj(v, what)
  return { enabled: p.enabled === undefined ? true : bool(p.enabled, `${what}.enabled`), like: id(p.like, `${what}.like`) }
}

function markersOf (v: unknown, what: string): RetimeMarker[] {
  const ms = list(v, what, (m, at) => {
    const o = obj(m, at)
    return { id: id(o.id, `${at}.id`), u: num(o.u, `${at}.u`, { above: 0, max: 1 }), to: num(o.to, `${at}.to`, { above: 0, max: 1 }) }
  }).sort((a, b) => a.u - b.u)
  for (const [i, m] of ms.entries()) {
    if (m.u >= 1 || m.to >= 1) bad(`${what}: a marker sits inside the clip (0..1, not at its ends)`)
    if (i > 0 && !(m.u > ms[i - 1].u && m.to > ms[i - 1].to)) bad(`${what}: markers must run forward in both times`)
  }
  if (new Set(ms.map(m => m.id)).size !== ms.length) bad(`${what}: marker ids repeat`)
  return ms
}

function holdsOf (v: unknown, what: string): TimeHold[] {
  const hs = list(v, what, (h, at) => {
    const o = obj(h, at)
    return { id: id(o.id, `${at}.id`), u: num(o.u, `${at}.u`, { min: 0, max: 1 }), seconds: num(o.seconds, `${at}.seconds`, { above: 0 }) }
  }).sort((a, b) => a.u - b.u)
  for (let i = 1; i < hs.length; i++) if (hs[i].u - hs[i - 1].u < 1e-6) bad(`${what}: two holds at the same moment`)
  if (new Set(hs.map(h => h.id)).size !== hs.length) bad(`${what}: hold ids repeat`)
  return hs
}

function timeOf (v: unknown, what: string): SlotTime | undefined {
  const t = obj(v, what)
  for (const k of Object.keys(t)) if (!['fit', 'pace', 'markers', 'holds'].includes(k)) bad(`${what} has no ${k}`)
  const out: SlotTime = {}
  const fit = opt(t.fit, x => fitOf(x, `${what}.fit`)); if (fit !== undefined) out.fit = fit
  const pace = opt(t.pace, x => paceOf(x, `${what}.pace`)); if (pace !== undefined) out.pace = pace
  const markers = opt(t.markers, x => markersOf(x, `${what}.markers`)); if (markers !== undefined && markers.length > 0) out.markers = markers
  const holds = opt(t.holds, x => holdsOf(x, `${what}.holds`)); if (holds !== undefined && holds.length > 0) out.holds = holds
  return Object.keys(out).length > 0 ? out : undefined
}

function eventOf (v: unknown, what: string): ClipEvent {
  const e = obj(v, what)
  const n = str(e.name, `${what}.name`)
  if (!EVENT_NAME.test(n)) bad(`${what}.name must start with a letter, then letters, digits, '.', '_' or '-' (32 at most)`)
  const u = sourceU(e.u, `${what}.u`)
  const to = opt(e.to, x => sourceU(x, `${what}.to`))
  if (to !== undefined && !(to > u)) bad(`${what}: a span must end after it starts`)
  const sound = opt(e.sound, x => str(x, `${what}.sound`))
  if (sound !== undefined && !SOUND.test(sound)) bad(`${what}.sound must be 'mix:<id>' or 'file:<path>'`)
  const bone = opt(e.bone, x => str(x, `${what}.bone`))
  const volume = opt(e.volume, x => num(x, `${what}.volume`, { above: 0, max: 4 }))
  const pitch = opt(e.pitch, x => num(x, `${what}.pitch`, { min: 0.25, max: 4 }))
  return {
    id: id(e.id, `${what}.id`), name: n, u, ...(to !== undefined ? { to } : {}), ...(sound !== undefined ? { sound } : {}), ...(bone !== undefined ? { bone } : {}),
    ...(volume !== undefined ? { volume } : {}), ...(pitch !== undefined ? { pitch } : {}),
  }
}

function eventsOf (v: unknown, what: string): ClipEvent[] {
  const es = list(v, what, eventOf).sort((a, b) => a.u - b.u)
  checkEvents(es, what)
  return es
}

function checkEvents (es: ClipEvent[], what: string): void {
  if (new Set(es.map(e => e.id)).size !== es.length) bad(`${what}: event ids repeat`)
  if (es.filter(e => e.name === 'hit' && e.to === undefined).length > 1) conflict(`${what}: one hit only (the blow the fit lands)`)
  if (es.some(e => e.name === 'hit' && e.to !== undefined)) bad(`${what}: the hit is a moment, not a span`)
}

/** Segments from `u` on: sorted, at distinct moments. */
function segments<T extends { u: number }> (v: unknown, what: string, each: (o: Obj, at: string) => Omit<T, 'u'>): T[] {
  const out = list(v, what, (x, at) => {
    const o = obj(x, at)
    return { u: sourceU(o.u, `${at}.u`), ...each(o, at) } as T
  }).sort((a, b) => a.u - b.u)
  for (let i = 1; i < out.length; i++) if (out[i].u - out[i - 1].u < 1e-6) bad(`${what}: two changes at the same moment`)
  return out
}

const heldByOf = (v: unknown, what: string): NonNullable<GearTrack['heldBy']> =>
  segments(v, what, (o, at) => {
    for (const k of Object.keys(o)) if (!['u', 'bone', 'place', 'handle', 'placed'].includes(k)) bad(`${at} has no ${k}`)
    const place = opt(o.place, x => placement(x, `${at}.place`))
    const handle = opt(o.handle, x => id(x, `${at}.handle`))
    const placed = opt(o.placed, x => bool(x, `${at}.placed`))
    if ([place !== undefined, handle !== undefined, placed === true].filter(Boolean).length > 1) bad(`${at}: one of place, handle or placed`)
    return { bone: str(o.bone, `${at}.bone`), ...(place !== undefined ? { place } : {}), ...(handle !== undefined ? { handle } : {}), ...(placed === true ? { placed: true as const } : {}) }
  })

/** A piece's holders checked against it: a handle one of its carry or grip handles, on the hand it is for; placed on
 * its Gear attach bone. */
function checkHolders (g: Gear, held: NonNullable<GearTrack['heldBy']>): void {
  for (const x of held) {
    if (x.placed === true && (g.attach.kind !== 'bone' || g.attach.bone !== x.bone)) bad(`${g.name} is placed on ${g.attach.kind === 'bone' ? g.attach.bone : 'no bone'}, not ${x.bone}`)
    if (x.handle === undefined) continue
    const h = g.handles.find(y => y.id === x.handle) ?? missing(`${g.name} has no handle ${x.handle}`)
    if (h.kind === 'pull') bad(`${g.name}'s ${h.name} is a pull: a hand holds it by a carry or grip handle`)
    const bone = h.kind === 'carry' ? (g.attach.kind === 'bone' ? g.attach.bone : undefined) : h.hand !== undefined ? `${h.hand}Hand` : undefined
    if (bone !== undefined ? bone !== x.bone : !/^(Left|Right)Hand$/.test(x.bone)) bad(`${g.name}'s ${h.name} is held by ${bone ?? 'a hand'}, not ${x.bone}`)
  }
}
const shownOf = (v: unknown, what: string): NonNullable<GearTrack['shown']> => segments(v, what, (o, at) => ({ shown: bool(o.shown, `${at}.shown`) }))

function gearTrackOf (v: unknown, what: string): GearTrack {
  const t = obj(v, what)
  for (const k of Object.keys(t)) if (!['keys', 'heldBy', 'shown'].includes(k)) bad(`${what} has no ${k}`)
  const keys = opt(t.keys, x => clipKeys(x, `${what}.keys`))
  const heldBy = opt(t.heldBy, x => heldByOf(x, `${what}.heldBy`))
  const shown = opt(t.shown, x => shownOf(x, `${what}.shown`))
  return { ...(keys !== undefined && keys.length > 0 ? { keys } : {}), ...(heldBy !== undefined && heldBy.length > 0 ? { heldBy } : {}), ...(shown !== undefined && shown.length > 0 ? { shown } : {}) }
}

const empty = (t: GearTrack): boolean => t.keys === undefined && t.heldBy === undefined && t.shown === undefined

function mutedOf (v: unknown, what: string): string[] {
  const m = [...new Set(list(v, what, (x, at) => str(x, at)))]
  for (const x of m) if (!MUTED.test(x)) bad(`${what}: ${x} isn't a track ('bones', 'gear', 'events', 'bone:<name>', 'gear:<id>')`)
  return m
}

function bonesOf (v: unknown, what: string): Record<string, ClipKey[]> {
  return Object.fromEntries(Object.entries(record(v, what, clipKeys)).filter(([, k]) => k.length > 0))
}

function gearTracksOf (v: unknown, what: string): Record<string, GearTrack> {
  return Object.fromEntries(Object.entries(record(v, what, gearTrackOf)).filter(([, t]) => !empty(t)))
}

function ikHandsOf (v: unknown, what: string): SlotIk['hands'] {
  const hands = list(v, what, (x, at) => {
    const o = obj(x, at)
    for (const k of Object.keys(o)) if (!['hand', 'gear', 'handle', 'windows'].includes(k)) bad(`${at} has no ${k}`)
    const w = opt(o.windows, y => windows(y, `${at}.windows`))
    if (w !== undefined && w.length === 0) bad(`${at}.windows can't be empty (leave them out for the whole clip)`)
    if (w !== undefined && w.some((a, i) => i > 0 && overlaps(w[i - 1], a))) bad(`${at}.windows overlap`)
    return { hand: side(o.hand, `${at}.hand`), gear: id(o.gear, `${at}.gear`), handle: id(o.handle, `${at}.handle`), ...(w !== undefined ? { windows: w } : {}) }
  })
  if (new Set(hands.map(h => h.hand)).size !== hands.length) bad(`${what}: one entry a hand`)
  return hands
}

function ikLeadOf (v: unknown, what: string): string[] {
  const lead = list(v, what, (x, at) => id(x, at))
  if (new Set(lead).size !== lead.length) bad(`${what}: a piece is named twice`)
  return lead
}

function ikOf (v: unknown, what: string): SlotIk | undefined {
  const o = obj(v, what)
  for (const k of Object.keys(o)) if (!['hands', 'lead', 'floor'].includes(k)) bad(`${what} has no ${k}`)
  const out: SlotIk = { hands: ikHandsOf(o.hands ?? [], `${what}.hands`) }
  const lead = opt(o.lead, x => ikLeadOf(x, `${what}.lead`)); if (lead !== undefined && lead.length > 0) out.lead = lead
  const floor = opt(o.floor, x => bool(x, `${what}.floor`)); if (floor !== undefined) out.floor = floor
  return out.hands.length === 0 && out.lead === undefined ? undefined : out
}

function slotOf (v: unknown, what: string): Slot {
  const s = obj(v, what)
  const text = note(s.note, `${what}.note`)
  const adjustments = list(s.adjustments ?? [], `${what}.adjustments`, adjustment)
  if (new Set(adjustments.map(a => a.id)).size !== adjustments.length) bad(`${what}: adjustment ids repeat`)
  const out: Slot = {
    id: id(s.id, `${what}.id`), name: name(s.name, `${what}.name`), clip: clipRef(s.clip, `${what}.clip`),
    speed: num(s.speed, `${what}.speed`, { above: 0 }), loop: bool(s.loop, `${what}.loop`), inPlace: bool(s.inPlace, `${what}.inPlace`),
    ...(text !== undefined ? { note: text } : {}), adjustments,
  }
  setup(out, s, what)
  return out
}

/** The time and tracks given in `s` laid on `out` (what slot.add, slot.fill and clips.replace share). */
function setup (out: Slot, s: Obj, what: string): void {
  const time = opt(s.time, x => timeOf(x, `${what}.time`)); if (time !== undefined) out.time = time
  const bones = opt(s.bones, x => bonesOf(x, `${what}.bones`)); if (bones !== undefined && Object.keys(bones).length > 0) out.bones = bones
  const gear = opt(s.gear, x => gearTracksOf(x, `${what}.gear`)); if (gear !== undefined && Object.keys(gear).length > 0) out.gear = gear
  const events = opt(s.events, x => eventsOf(x, `${what}.events`)); if (events !== undefined && events.length > 0) out.events = events
  const muted = opt(s.muted, x => mutedOf(x, `${what}.muted`)); if (muted !== undefined && muted.length > 0) out.muted = muted
  const ik = opt(s.ik, x => ikOf(x, `${what}.ik`)); if (ik !== undefined) out.ik = ik
}

// ---- the character's rules -------------------------------------------------------------------------------------------

/** An adjustment's references resolve: the gear and handle it names. */
function refs (c: Character, a: Adjustment): void {
  switch (a.kind) {
    case 'handPose': {
      if (a.gear === undefined) return
      const g = gearById(c, a.gear) ?? missing(`No gear ${a.gear}`)
      const carry = carryHandle(g) ?? bad(`${g.name} isn't carried by a hand`)
      if (carry.hand !== a.hand) bad(`${g.name} is carried by the ${carry.hand ?? 'other'} hand`)
      return
    }
    case 'handleHold': {
      const g = gearById(c, a.gear) ?? missing(`No gear ${a.gear}`)
      const h = g.handles.find(x => x.id === a.handle) ?? missing(`${g.name} has no handle ${a.handle}`)
      if (h.kind !== 'pull') bad(`Only a pull is held in a clip; ${h.name} is a ${h.kind} handle`)
    }
  }
}

/** The slot's time and tracks resolve: the slot it paces like (one of `slotIds`, not its own), the gear it tracks. */
function slotRefs (c: Character, slot: Slot, slotIds: Set<string>): void {
  const pace = slot.time?.pace
  if (pace !== undefined) {
    if (pace.like === slot.id) bad(`clip ${slot.name} can't pace like itself`)
    if (!slotIds.has(pace.like)) missing(`No clip ${pace.like} to pace like`)
  }
  for (const gid of Object.keys(slot.gear ?? {})) if (gearById(c, gid) === undefined) missing(`No gear ${gid}`)
  if (slot.ik !== undefined) ikRefs(c, slot.ik)
}

/** A build's references resolve: bone gear, a handle on it a hand can hold (not a pull). */
function ikRefs (c: Character, ik: SlotIk): void {
  const boneGear = (gid: string): Gear => {
    const g = gearById(c, gid) ?? missing(`No gear ${gid}`)
    if (g.attach.kind !== 'bone') bad(`${g.name} isn't on a bone: no hand holds it in a clip`)
    return g
  }
  for (const h of ik.hands) {
    const g = boneGear(h.gear)
    const handle = g.handles.find(x => x.id === h.handle) ?? missing(`${g.name} has no handle ${h.handle}`)
    if (handle.kind === 'pull') bad(`${handle.name} is a pull: a pull is held by a handle hold, not a hand on it`)
  }
  for (const gid of ik.lead ?? []) boneGear(gid)
}

/** A build in words. */
function ikText (c: Character, ik: Pick<SlotIk, 'hands' | 'lead'>): string[] {
  const gearName = (gid: string): string => gearById(c, gid)?.name ?? gid
  return [
    ...ik.hands.map(h => {
      const g = gearById(c, h.gear)
      return `${h.hand} hand on ${gearName(h.gear)} · ${g?.handles.find(x => x.id === h.handle)?.name ?? h.handle}${h.windows !== undefined ? ` in ${windowsText(h.windows)}` : ''}`
    }),
    ...(ik.lead ?? []).map(gid => `${gearName(gid)} leads`),
  ]
}

/** The slot's rules hold with `a` among `others` (one of the same id is the one it replaces). */
function fits (slot: Slot, a: Adjustment, others: Adjustment[]): void {
  const rest = others.filter(o => o.id !== a.id)
  if (ONE_PER_SLOT.includes(a.kind) && rest.some(o => o.kind === a.kind)) conflict(`clip ${slot.name} has its ${KIND_TEXT[a.kind]} already; change that one`)
  if (a.kind === 'handleHold' && rest.some(o => o.kind === 'handleHold' && o.gear === a.gear && o.handle === a.handle)) {
    conflict(`clip ${slot.name} holds that handle already; change that hold`)
  }
  if (a.kind === 'handPose') {
    const mine = a.windows ?? WHOLE
    if (mine.some((w, i) => mine.some((x, j) => i < j && overlaps(w, x)))) bad("A hand pose's windows overlap")
    const theirs = rest.flatMap(o => (o.kind === 'handPose' && o.hand === a.hand ? o.windows ?? WHOLE : []))
    if (mine.some(w => theirs.some(x => overlaps(w, x)))) conflict(`In clip ${slot.name} the ${a.hand} hand is posed then already`)
  }
}

function adjText (c: Character, a: Adjustment): string {
  const gearName = (gid: string): string => gearById(c, gid)?.name ?? gid
  switch (a.kind) {
    case 'ground': return `ground lift ${r3(a.lift)}`
    case 'handPose': return `${a.hand} hand ${refText(c, a.pose)} in ${windowsText(a.windows)}${a.gear !== undefined ? ` (letting go of ${gearName(a.gear)})` : ''}`
    case 'handleHold': {
      const g = gearById(c, a.gear)
      return `hold of ${g?.name ?? a.gear} · ${g?.handles.find(h => h.id === a.handle)?.name ?? a.handle} in ${windowsText(a.windows)}`
    }
  }
}

const fitText = (f: BlowFit): string => `blow at ${pct(f.at)}${f.window !== undefined ? ` (${r3(f.window)} s round it)` : ''}${f.late === 'hold' ? ', a late one held' : ''}${f.enabled ? '' : ' (off)'}`
const eventText = (e: ClipEvent): string => `${e.name} at ${pct(e.u)}${e.to !== undefined ? `-${pct(e.to)}` : ''}${e.sound !== undefined ? ` (${e.sound})` : ''}`

/** Added under the slot's rules. */
function add (c: Character, slot: Slot, a: Adjustment): string[] {
  if (slot.adjustments.some(o => o.id === a.id)) conflict(`clip ${slot.name} has an adjustment ${a.id} already`)
  fits(slot, a, slot.adjustments)
  slot.adjustments.push(a)
  return [`clip ${slot.name}: ${adjText(c, a)} added`]
}

/** The slot's adjustments set to these, checked and merged by the rules. */
function settle (c: Character, slot: Slot, given: Adjustment[]): string[] {
  slot.adjustments = []
  return given.flatMap(a => { refs(c, a); return add(c, slot, a) })
}

/** Tracks given laid onto the slot's (bones and gear merged per track; events added under the rules). */
function lay (c: Character, s: Slot, given: Slot): string[] {
  const out: string[] = []
  if (given.time !== undefined) s.time = { ...s.time, ...given.time }
  if (given.bones !== undefined) { s.bones = { ...s.bones, ...given.bones }; out.push(`clip ${s.name}: keys on ${names(Object.keys(given.bones))}`) }
  if (given.gear !== undefined) {
    s.gear = { ...s.gear, ...given.gear }
    out.push(`clip ${s.name}: tracks of ${names(Object.keys(given.gear).map(g => gearById(c, g)?.name ?? g))}`)
  }
  if (given.events !== undefined) {
    const all = [...(s.events ?? []), ...given.events].sort((a, b) => a.u - b.u)
    checkEvents(all, `clip ${s.name}`)
    s.events = all
    out.push(`clip ${s.name}: ${names(given.events.map(eventText))}`)
  }
  if (given.muted !== undefined) s.muted = [...new Set([...(s.muted ?? []), ...given.muted])]
  if (given.ik !== undefined) { s.ik = given.ik; out.push(`clip ${s.name}: ${names(ikText(c, given.ik))}`) }
  return out
}

/** What the slot holds besides its clip and settings goes (made for the clip it had). */
function clearSetup (c: Character, s: Slot): string[] {
  const gone = [
    ...s.adjustments.map(a => adjText(c, a)),
    ...(s.time?.fit !== undefined ? [fitText(s.time.fit)] : []), ...(s.time?.pace !== undefined ? ['pace'] : []),
    ...(s.time?.markers !== undefined ? [plural(s.time.markers.length, 'retime marker')] : []),
    ...(s.time?.holds !== undefined ? [plural(s.time.holds.length, 'hold')] : []),
    ...(s.bones !== undefined || s.gear !== undefined ? ['keys and gear tracks'] : []),
    ...(s.events !== undefined ? [plural(s.events.length, 'event')] : []),
    ...(s.ik !== undefined ? ['hands on gear'] : []),
  ]
  s.adjustments = []
  delete s.time; delete s.bones; delete s.gear; delete s.events; delete s.muted; delete s.ik
  return gone.length > 0 ? [`clip ${s.name}: ${names(gone)} dropped (made for the clip it had)`] : []
}

const slotIdsOf = (c: Character): Set<string> => new Set(c.clips.map(s => s.id))

export function reduceClips (c: Character, cmd: ClipsCommand): string[] {
  const find = (slotId: string): Slot => slotById(c, slotId) ?? missing(`No clip slot ${slotId}`)
  switch (cmd.type) {
    case 'slot.add': {
      const s = slotOf(cmd.slot, 'slot')
      if (slotById(c, s.id) !== undefined) conflict(`A clip slot ${s.id} exists already`)
      if (slotByName(c, s.name) !== undefined) conflict(`A clip named ${s.name} exists already`)
      const index = cmd.index === undefined ? c.clips.length : num(cmd.index, 'index', { min: 0, max: c.clips.length })
      if (!Number.isInteger(index)) bad('index must be a whole number')
      c.clips.splice(index, 0, s)
      settle(c, s, s.adjustments)
      slotRefs(c, s, slotIdsOf(c))
      return [`clip ${s.name}: added (${s.clip.id})`]
    }
    case 'slot.update': {
      const s = find(cmd.id)
      const p = obj(cmd.patch, 'patch')
      for (const k of Object.keys(p)) if (!['name', 'speed', 'loop', 'inPlace', 'note', 'muted'].includes(k)) bad(`patch can't change ${k}`)
      const out: string[] = []
      if (p.name !== undefined) {
        const next = name(p.name, 'name')
        if (next !== s.name) {
          if (slotByName(c, next) !== undefined) conflict(`A clip named ${next} exists already`)
          out.push(`clip ${s.name}: renamed ${next}`)
          s.name = next
        }
      }
      if (p.speed !== undefined) {
        const speed = num(p.speed, 'speed', { above: 0 })
        if (speed !== s.speed) { out.push(`clip ${s.name}: speed ${s.speed} -> ${speed}`); s.speed = speed }
      }
      if (p.loop !== undefined) {
        const loop = bool(p.loop, 'loop')
        if (loop !== s.loop) { s.loop = loop; out.push(`clip ${s.name}: ${loop ? 'loops' : 'plays once'}`) }
      }
      if (p.inPlace !== undefined) {
        const inPlace = bool(p.inPlace, 'inPlace')
        if (inPlace !== s.inPlace) { s.inPlace = inPlace; out.push(`clip ${s.name}: ${inPlace ? 'in place' : 'moves over the ground'}`) }
      }
      if (p.note !== undefined) out.push(...setNote(s, p.note))
      if (p.muted !== undefined) {
        const next = p.muted === null ? [] : mutedOf(p.muted, 'muted')
        if (!same(next, s.muted ?? [])) {
          if (next.length > 0) s.muted = next
          else delete s.muted
          out.push(`clip ${s.name}: ${next.length > 0 ? `${names(next)} switched off` : 'every track on'}`)
        }
      }
      return out
    }
    case 'slot.fill': {
      const clip = clipRef(cmd.clip, 'clip')
      const speed = cmd.speed === undefined ? 1 : num(cmd.speed, 'speed', { above: 0 })
      const loop = opt(cmd.loop, x => bool(x, 'loop'))
      const inPlace = opt(cmd.inPlace, x => bool(x, 'inPlace'))
      const keep = opt(cmd.keepAdjustments, x => bool(x, 'keepAdjustments')) === true
      const added = list(cmd.adjustments ?? [], 'adjustments', adjustment)
      const given: Slot = { id: 'given', name: 'given', clip, speed, loop: false, inPlace: false, adjustments: [] }
      setup(given, cmd as unknown as Obj, 'fill')
      const out: string[] = []
      let s: Slot
      if (cmd.id !== undefined) {
        if (cmd.name !== undefined || cmd.newId !== undefined) bad('Fill a slot by its id, or a new one by name and newId')
        s = find(cmd.id)
        if (!same(s.clip, clip)) out.push(`clip ${s.name}: ${s.clip.id} -> ${clip.id}`)
        if (speed !== s.speed) out.push(`clip ${s.name}: speed ${s.speed} -> ${speed}`)
        if (loop !== undefined && loop !== s.loop) out.push(`clip ${s.name}: ${loop ? 'loops' : 'plays once'}`)
        if (inPlace !== undefined && inPlace !== s.inPlace) out.push(`clip ${s.name}: ${inPlace ? 'in place' : 'moves over the ground'}`)
        s.clip = clip
        s.speed = speed
        s.loop = loop ?? s.loop
        s.inPlace = inPlace ?? s.inPlace
      } else {
        const slotName = name(cmd.name, 'name')
        const slotId = id(cmd.newId, 'newId')
        if (slotByName(c, slotName) !== undefined) conflict(`A clip named ${slotName} exists already; fill it by its id`)
        if (slotById(c, slotId) !== undefined) conflict(`A clip slot ${slotId} exists already`)
        s = { id: slotId, name: slotName, clip, speed, loop: loop ?? false, inPlace: inPlace ?? false, adjustments: [] }
        c.clips.push(s)
        out.push(`clip ${slotName}: added (${clip.id})`)
      }
      if (cmd.note !== undefined) out.push(...setNote(s, cmd.note))
      if (!keep) out.push(...clearSetup(c, s))
      for (const a of added) { refs(c, a); out.push(...add(c, s, a)) }
      out.push(...lay(c, s, given))
      slotRefs(c, s, slotIdsOf(c))
      return out
    }
    case 'slot.copy': {
      const from = find(cmd.from)
      const copy = JSON.parse(JSON.stringify(from)) as Slot
      let s: Slot
      const out: string[] = []
      if (cmd.to !== undefined) {
        if (cmd.name !== undefined || cmd.newId !== undefined) bad('Copy over a slot by its id, or into a new one by name and newId')
        const to = find(cmd.to)
        if (to === from) bad(`clip ${to.name} can't be copied over itself`)
        s = { ...copy, id: to.id, name: to.name, loop: to.loop, inPlace: to.inPlace }
        c.clips = c.clips.map(x => (x === to ? s : x))
        out.push(`clip ${s.name}: now ${from.name}'s (${from.clip.id}${from.speed !== 1 ? `, speed ${from.speed}` : ''}), what it had gone`)
      } else {
        const slotName = name(cmd.name, 'name')
        const slotId = id(cmd.newId, 'newId')
        if (slotByName(c, slotName) !== undefined) conflict(`A clip named ${slotName} exists already; copy over it by its id`)
        if (slotById(c, slotId) !== undefined) conflict(`A clip slot ${slotId} exists already`)
        s = { ...copy, id: slotId, name: slotName }
        c.clips.push(s)
        out.push(`clip ${slotName}: added as a copy of ${from.name}`)
      }
      if (s.time?.pace?.like === s.id) {
        delete s.time.pace
        if (Object.keys(s.time).length === 0) delete s.time
        out.push(`clip ${s.name}: pace dropped (it would follow itself)`)
      }
      return out
    }
    case 'slot.remove': {
      const s = find(cmd.id)
      c.clips = c.clips.filter(x => x !== s)
      const out = [`clip ${s.name}: removed`]
      for (const o of c.clips) {
        if (o.time?.pace?.like !== s.id) continue
        delete o.time.pace
        if (Object.keys(o.time).length === 0) delete o.time
        out.push(`clip ${o.name}: pace of ${s.name} removed (that clip is gone)`)
      }
      return out
    }
    case 'slot.reorder': {
      const next = reorder(c.clips, cmd.ids, 'clip slot')
      if (next.every((s, i) => s === c.clips[i])) return []
      c.clips = next
      return ['clips reordered']
    }
    case 'slot.adjust.add': {
      const s = find(cmd.slot)
      const a = adjustment(cmd.adjustment, 'adjustment')
      refs(c, a)
      return add(c, s, a)
    }
    case 'slot.adjust.update': {
      const s = find(cmd.slot)
      const i = s.adjustments.findIndex(a => a.id === cmd.id)
      if (i < 0) missing(`clip ${s.name} has no adjustment ${cmd.id}`)
      const was = s.adjustments[i]
      const patch = obj(cmd.patch, 'patch')
      for (const k of Object.keys(patch)) {
        if (!['enabled', 'note', ...FIELDS[was.kind]].includes(k)) bad(`A ${KIND_TEXT[was.kind]} adjustment can't change ${k}`)
      }
      const merged: Obj = { ...was }
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete merged[k]
        else if (v !== undefined) merged[k] = v
      }
      const a = adjustment(merged, 'adjustment')
      refs(c, a)
      fits(s, a, s.adjustments)
      if (same(a, was)) return []
      s.adjustments[i] = a
      const out: string[] = []
      if (a.enabled !== was.enabled) out.push(`clip ${s.name}: ${adjText(c, a)} ${a.enabled ? 'on' : 'off'}`)
      const [before, after] = [adjText(c, was), adjText(c, a)]
      if (before !== after) out.push(`clip ${s.name}: ${before} -> ${after}`)
      else if (!same({ ...a, enabled: null }, { ...was, enabled: null })) out.push(`clip ${s.name}: ${after} changed`)
      return out
    }
    case 'slot.adjust.remove': {
      const s = find(cmd.slot)
      const a = s.adjustments.find(x => x.id === cmd.id) ?? missing(`clip ${s.name} has no adjustment ${cmd.id}`)
      s.adjustments = s.adjustments.filter(x => x !== a)
      return [`clip ${s.name}: ${adjText(c, a)} removed`]
    }
    case 'slot.adjust.set': {
      const s = find(cmd.slot)
      const given = list(cmd.adjustments, 'adjustments', adjustment)
      if (new Set(given.map(a => a.id)).size !== given.length) bad('Adjustment ids repeat')
      const was = s.adjustments
      settle(c, s, given)
      if (same(was, s.adjustments)) return []
      return [s.adjustments.length > 0 ? `clip ${s.name}: adjustments now ${names(s.adjustments.map(a => adjText(c, a)))}` : `clip ${s.name}: adjustments cleared`]
    }
    case 'slot.time': return timeCommand(c, find(cmd.slot), cmd.patch)
    case 'slot.keys.set': return keysCommand(c, find(cmd.slot), cmd.tracks)
    case 'slot.event.add': {
      const s = find(cmd.slot)
      const e = eventOf(cmd.event, 'event')
      if ((s.events ?? []).some(x => x.id === e.id)) conflict(`clip ${s.name} has an event ${e.id} already`)
      const all = [...(s.events ?? []), e].sort((a, b) => a.u - b.u)
      checkEvents(all, `clip ${s.name}`)
      s.events = all
      return [`clip ${s.name}: ${eventText(e)} added`]
    }
    case 'slot.event.update': {
      const s = find(cmd.slot)
      const i = (s.events ?? []).findIndex(e => e.id === cmd.id)
      if (i < 0) missing(`clip ${s.name} has no event ${cmd.id}`)
      const was = s.events![i]
      const patch = obj(cmd.patch, 'patch')
      for (const k of Object.keys(patch)) if (!['name', 'u', 'to', 'sound', 'bone', 'volume', 'pitch'].includes(k)) bad(`An event can't change ${k}`)
      const merged: Obj = { ...was }
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete merged[k]
        else if (v !== undefined) merged[k] = v
      }
      const e = eventOf(merged, 'event')
      if (same(e, was)) return []
      const all = s.events!.map(x => (x === was ? e : x)).sort((a, b) => a.u - b.u)
      checkEvents(all, `clip ${s.name}`)
      s.events = all
      return [`clip ${s.name}: ${eventText(was)} -> ${eventText(e)}`]
    }
    case 'slot.event.remove': {
      const s = find(cmd.slot)
      const e = (s.events ?? []).find(x => x.id === cmd.id) ?? missing(`clip ${s.name} has no event ${cmd.id}`)
      s.events = s.events!.filter(x => x !== e)
      if (s.events.length === 0) delete s.events
      return [`clip ${s.name}: ${eventText(e)} removed${e.name === 'hit' && e.to === undefined && s.time?.fit !== undefined ? ' (the fit finds the blow again)' : ''}`]
    }
    case 'slot.gear.update': {
      const s = find(cmd.slot)
      const g = gearById(c, id(cmd.gear, 'gear')) ?? missing(`No gear ${cmd.gear}`)
      const patch = obj(cmd.patch, 'patch')
      for (const k of Object.keys(patch)) if (!['heldBy', 'shown'].includes(k)) bad(`A gear track can't change ${k} (its keys are slot.keys.set)`)
      const track: GearTrack = { ...s.gear?.[g.id] }
      const out: string[] = []
      if (patch.heldBy !== undefined) {
        const next = patch.heldBy === null ? [] : heldByOf(patch.heldBy, 'heldBy')
        for (const x of next) joint(c, x.bone, 'heldBy bone')
        checkHolders(g, next)
        if (next.length > 0) track.heldBy = next
        else delete track.heldBy
        out.push(`clip ${s.name}: ${g.name} ${next.length > 0 ? `held by ${names(next.map(x => `${x.bone} from ${pct(x.u)}`))}` : `held by ${g.attach.kind === 'bone' ? g.attach.bone : 'its place'} all through`}`)
      }
      if (patch.shown !== undefined) {
        const next = patch.shown === null ? [] : shownOf(patch.shown, 'shown')
        if (next.length > 0) track.shown = next
        else delete track.shown
        out.push(`clip ${s.name}: ${g.name} ${next.length > 0 ? names(next.map(x => `${x.shown ? 'shown' : 'hidden'} from ${pct(x.u)}`)) : 'shown as Gear has it'}`)
      }
      putTrack(s, g.id, track)
      return out
    }
    case 'slot.ik': return ikCommand(c, find(cmd.slot), cmd.patch)
    case 'clips.replace': return replace(c, cmd)
  }
  return unknown(cmd)
}

function ikCommand (c: Character, s: Slot, v: unknown): string[] {
  const p = obj(v, 'patch')
  for (const k of Object.keys(p)) if (!['hands', 'lead', 'floor'].includes(k)) bad(`A slot's build has no ${k}`)
  const was: SlotIk = s.ik ?? { hands: [] }
  const next: SlotIk = { ...was, hands: [...was.hands] }
  if (p.hands !== undefined) next.hands = p.hands === null ? [] : ikHandsOf(p.hands, 'hands')
  if (p.lead !== undefined) {
    const lead = p.lead === null ? [] : ikLeadOf(p.lead, 'lead')
    if (lead.length > 0) next.lead = lead
    else delete next.lead
  }
  if (p.floor !== undefined) {
    if (p.floor === null) delete next.floor
    else next.floor = bool(p.floor, 'floor')
  }
  const gone = next.hands.length === 0 && next.lead === undefined
  ikRefs(c, next)
  if (same(gone ? undefined : next, s.ik)) return []
  const before = new Set(ikText(c, was)); const after = ikText(c, next)
  const added = after.filter(x => !before.has(x)); const removed = [...before].filter(x => !after.includes(x))
  if (gone) delete s.ik
  else s.ik = next
  const out: string[] = []
  if (added.length > 0) out.push(`clip ${s.name}: ${names(added)}`)
  if (removed.length > 0) out.push(`clip ${s.name}: ${names(removed.map(x => x.replace(/ leads$/, ' no longer leads').replace(/^(\w+ hand) on /, '$1 off ')))}`)
  if (!gone && was.floor !== next.floor) out.push(`clip ${s.name}: ${next.floor === false ? 'a foot the build sinks left under the floor' : 'the feet kept on the floor'}`)
  if (out.length === 0) out.push(`clip ${s.name}: hands on gear changed`)
  return out
}

function timeCommand (c: Character, s: Slot, v: unknown): string[] {
  const p = obj(v, 'patch')
  for (const k of Object.keys(p)) if (!['fit', 'pace', 'markers', 'holds'].includes(k)) bad(`A slot's time has no ${k}`)
  const t: SlotTime = { ...s.time }
  const out: string[] = []
  if (p.fit !== undefined) {
    const next = p.fit === null ? undefined : fitOf(p.fit, 'fit')
    if (!same(next, t.fit)) out.push(`clip ${s.name}: ${next === undefined ? 'blow timing removed' : t.fit === undefined ? `${fitText(next)} added` : `${fitText(t.fit)} -> ${fitText(next)}`}`)
    if (next === undefined) delete t.fit
    else t.fit = next
  }
  if (p.pace !== undefined) {
    const next = p.pace === null ? undefined : paceOf(p.pace, 'pace')
    if (next !== undefined) {
      if (next.like === s.id) bad(`clip ${s.name} can't pace like itself`)
      const like = slotById(c, next.like) ?? missing(`No clip ${next.like} to pace like`)
      if (!same(next, t.pace)) out.push(`clip ${s.name}: pace of ${like.name}${next.enabled ? '' : ' (off)'}`)
      t.pace = next
    } else if (t.pace !== undefined) {
      out.push(`clip ${s.name}: pace removed`)
      delete t.pace
    }
  }
  if (p.markers !== undefined) {
    const next = p.markers === null ? [] : markersOf(p.markers, 'markers')
    if (!same(next, t.markers ?? [])) out.push(`clip ${s.name}: ${next.length > 0 ? `retimed by ${plural(next.length, 'marker')}` : 'retime markers removed'}`)
    if (next.length > 0) t.markers = next
    else delete t.markers
  }
  if (p.holds !== undefined) {
    const next = p.holds === null ? [] : holdsOf(p.holds, 'holds')
    if (!same(next, t.holds ?? [])) out.push(`clip ${s.name}: ${next.length > 0 ? names(next.map(h => `held ${r3(h.seconds)} s at ${pct(h.u)}`)) : 'holds removed'}`)
    if (next.length > 0) t.holds = next
    else delete t.holds
  }
  if (Object.keys(t).length > 0) s.time = t
  else delete s.time
  return out
}

function keysCommand (c: Character, s: Slot, v: unknown): string[] {
  const tracks = list(v, 'tracks', (x, at): KeyTrack => {
    const o = obj(x, at)
    const keys = clipKeys(o.keys, `${at}.keys`)
    if ((o.bone === undefined) === (o.gear === undefined)) bad(`${at} names a bone or a gear piece`)
    return o.bone !== undefined ? { bone: joint(c, o.bone, `${at}.bone`), keys } : { gear: id(o.gear, `${at}.gear`), keys }
  })
  const named = tracks.map(t => ('bone' in t ? `b:${t.bone}` : `g:${t.gear}`))
  if (new Set(named).size !== named.length) bad('A track is named twice')
  const out: string[] = []
  for (const t of tracks) {
    if ('bone' in t) {
      const was = s.bones?.[t.bone] ?? []
      if (same(was, t.keys)) continue
      const bones = { ...s.bones }
      if (t.keys.length > 0) bones[t.bone] = t.keys
      else delete bones[t.bone]
      if (Object.keys(bones).length > 0) s.bones = bones
      else delete s.bones
      out.push(`clip ${s.name}: ${t.keys.length > 0 ? `${plural(t.keys.length, 'key')} on ${t.bone}` : `keys on ${t.bone} removed`}`)
    } else {
      const g = gearById(c, t.gear) ?? missing(`No gear ${t.gear}`)
      const track: GearTrack = { ...s.gear?.[g.id] }
      if (same(track.keys ?? [], t.keys)) continue
      if (t.keys.length > 0) track.keys = t.keys
      else delete track.keys
      putTrack(s, g.id, track)
      out.push(`clip ${s.name}: ${t.keys.length > 0 ? `${plural(t.keys.length, 'key')} on ${g.name}` : `keys on ${g.name} removed`}`)
    }
  }
  return out
}

/** A gear piece's track put in the slot (an empty one taken out). */
function putTrack (s: Slot, gearId: string, track: GearTrack): void {
  const gear = { ...s.gear }
  if (empty(track)) delete gear[gearId]
  else gear[gearId] = track
  if (Object.keys(gear).length > 0) s.gear = gear
  else delete s.gear
}

function setNote (s: Slot, v: unknown): string[] {
  const next = note(v, 'note')
  if (next === s.note) return []
  if (next === undefined) delete s.note
  else s.note = next
  return [`clip ${s.name}: note ${next === undefined ? 'cleared' : 'changed'}`]
}

/** A whole set in: gear references mapped onto this character's gear (by name, through gearNames) and handles (by
 * name through handleNames, else by id); what doesn't resolve dropped and said. */
function replace (c: Character, cmd: Extract<ClipsCommand, { type: 'clips.replace' }>): string[] {
  const slots = list(cmd.slots, 'slots', slotOf)
  if (new Set(slots.map(s => s.id)).size !== slots.length) bad('Clip slot ids repeat')
  for (const [i, s] of slots.entries()) if (slots.findIndex(o => o.name === s.name) !== i) bad(`Two clips are named ${s.name}`)
  const gearNames = cmd.gearNames === undefined ? null : record(cmd.gearNames, 'gearNames', str)
  const handleNames = cmd.handleNames === undefined ? {} : record(cmd.handleNames, 'handleNames', str)
  const sourceName = (gid: string): string => gearNames?.[gid] ?? gid
  const gearFor = (gid: string): Gear | undefined => (gearNames === null ? gearById(c, gid) : gearNames[gid] !== undefined ? gearByName(c, gearNames[gid]) : undefined)
  const handleFor = (gid: string, g: Gear, hid: string): Handle | undefined => {
    const n = handleNames[`${gid}/${hid}`]
    return n !== undefined ? g.handles.find(h => h.name === n) : g.handles.find(h => h.id === hid)
  }
  const ids = new Set(slots.map(s => s.id))
  const out: string[] = []
  for (const s of slots) {
    if (s.time?.pace !== undefined && (!ids.has(s.time.pace.like) || s.time.pace.like === s.id)) {
      out.push(`clip ${s.name}: pace dropped (the clip it followed isn't in the set)`)
      delete s.time.pace
      if (Object.keys(s.time).length === 0) delete s.time
    }
    const kept: Adjustment[] = []
    for (const a of s.adjustments) {
      if (a.kind === 'handPose' && a.gear !== undefined) {
        const g = gearFor(a.gear)
        const carry = g === undefined ? undefined : carryHandle(g)
        if (g === undefined || carry?.hand === undefined) {
          out.push(`clip ${s.name}: hand pose letting go of ${sourceName(a.gear)} dropped (${g === undefined ? 'no such gear here' : `${g.name} isn't carried here`})`)
          continue
        }
        a.gear = g.id
        a.hand = carry.hand
      }
      if (a.kind === 'handleHold') {
        const g = gearFor(a.gear)
        const h = g === undefined ? undefined : handleFor(a.gear, g, a.handle)
        if (g === undefined || h === undefined || h.kind !== 'pull') {
          out.push(`clip ${s.name}: hold of ${sourceName(a.gear)} dropped (${g === undefined ? 'no such gear here' : `${g.name} has no such pull`})`)
          continue
        }
        a.gear = g.id
        a.handle = h.id
      }
      kept.push(a)
    }
    s.adjustments = kept
    if (s.gear !== undefined) {
      const mapped: Record<string, GearTrack> = {}
      for (const [gid, track] of Object.entries(s.gear)) {
        const g = gearFor(gid)
        if (g !== undefined) {
          // (a holder by a handle: the handle of that name here, else where it is)
          if (track.heldBy !== undefined) {
            track.heldBy = track.heldBy.map(x => {
              if (x.handle === undefined) return x
              const h = handleFor(gid, g, x.handle)
              if (h !== undefined && h.kind !== 'pull') return { ...x, handle: h.id }
              out.push(`clip ${s.name}: ${g.name} held by ${x.bone} where it is (no such handle here)`)
              const rest = { ...x }
              delete rest.handle
              return rest
            })
          }
          mapped[g.id] = track
        } else out.push(`clip ${s.name}: the track of ${sourceName(gid)} dropped (no such gear here)`)
      }
      if (Object.keys(mapped).length > 0) s.gear = mapped
      else delete s.gear
    }
    if (s.ik !== undefined) {
      const hands: SlotIk['hands'] = []
      for (const h of s.ik.hands) {
        const g = gearFor(h.gear)
        const handle = g === undefined ? undefined : handleFor(h.gear, g, h.handle)
        if (g === undefined || g.attach.kind !== 'bone' || handle === undefined || handle.kind === 'pull') {
          out.push(`clip ${s.name}: ${h.hand} hand on ${sourceName(h.gear)} dropped (${g === undefined ? 'no such gear here' : `${g.name} has no such handle`})`)
          continue
        }
        hands.push({ ...h, gear: g.id, handle: handle.id })
      }
      const lead = (s.ik.lead ?? []).flatMap(gid => {
        const g = gearFor(gid)
        if (g !== undefined && g.attach.kind === 'bone') return [g.id]
        out.push(`clip ${s.name}: ${sourceName(gid)} leading dropped (no such gear here)`)
        return []
      })
      const ik: SlotIk = { ...s.ik, hands }
      if (lead.length > 0) ik.lead = lead
      else delete ik.lead
      if (hands.length > 0 || ik.lead !== undefined) s.ik = ik
      else delete s.ik
    }
    if (s.muted !== undefined) {
      s.muted = s.muted.flatMap(m => {
        if (!m.startsWith('gear:')) return [m]
        const g = gearFor(m.slice(5))
        return g === undefined ? [] : [`gear:${g.id}`]
      })
      if (s.muted.length === 0) delete s.muted
    }
  }
  c.clips = slots
  for (const s of slots) { settle(c, s, s.adjustments); slotRefs(c, s, ids) }
  return [`clips replaced: ${slots.length > 0 ? names(slots.map(s => s.name)) : 'none'}`, ...out]
}
