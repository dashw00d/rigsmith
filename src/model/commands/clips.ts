// slot.* and clips.*: the character's set of clips (slots: the game's clip names and trials) and the adjustments
// each makes to its clip. Rules kept here: slot names unique; one ground, blow timing, pace and keys per slot (a keys
// adjustment added merges into the slot's per bone and gear); one hold per (gear, handle); a hand's hand pose windows
// never overlap; every reference (a paced-like slot, gear, a handle) resolves.
import type { Command } from '../command-types.ts'
import { carryHandle, gearById, gearByName, slotById, slotByName } from '../select.ts'
import type { Adjustment, AdjustmentKind, Character, Gear, Handle, Slot, Window } from '../types.ts'
import {
  bad, bool, clipKeys, clipRef, conflict, handPoseRef, id, list, missing, name, names, note, num, obj, oneOf, opt, overlaps,
  pct, r3, record, refText, reorder, same, side, str, unknown, windows, windowsText, type Obj,
} from './common.ts'

export type ClipsCommand = Extract<Command, { type: `slot.${string}` | `clips.${string}` }>

const KINDS: AdjustmentKind[] = ['ground', 'blowTiming', 'pace', 'handPose', 'handleHold', 'keys']
/** What each kind holds besides id, kind, enabled and note. */
const FIELDS: Record<AdjustmentKind, string[]> = {
  ground: ['lift'], blowTiming: ['at', 'blowU', 'late', 'hand', 'window'], pace: ['like'],
  handPose: ['hand', 'pose', 'windows', 'gear'], handleHold: ['gear', 'handle', 'windows'], keys: ['bones', 'gear'],
}
const ONE_PER_SLOT: AdjustmentKind[] = ['ground', 'blowTiming', 'pace', 'keys']
const KIND_TEXT: Record<AdjustmentKind, string> = {
  ground: 'ground', blowTiming: 'blow timing', pace: 'pace', handPose: 'hand pose', handleHold: 'handle hold', keys: 'keys',
}
const WHOLE: Window[] = [[0, 1]]

/** An adjustment as given; its references are checked against the character by refs(). */
function adjustment (v: unknown, what: string): Adjustment {
  const a = obj(v, what)
  const f = (k: string): string => `${what}.${k}`
  const kind = oneOf(a.kind, KINDS, f('kind'))
  const text = note(a.note, f('note'))
  const base = { id: id(a.id, f('id')), enabled: a.enabled === undefined ? true : bool(a.enabled, f('enabled')), ...(text !== undefined ? { note: text } : {}) }
  switch (kind) {
    case 'ground': return { ...base, kind, lift: num(a.lift, f('lift')) }
    case 'blowTiming': {
      const blowU = opt(a.blowU, x => num(x, f('blowU'), { min: 0, max: 1 }))
      const late = opt(a.late, x => oneOf(x, ['cut', 'hold'] as const, f('late')))
      const hand = opt(a.hand, x => str(x, f('hand')))
      const window = opt(a.window, x => num(x, f('window'), { above: 0 }))
      return {
        ...base, kind, at: num(a.at, f('at'), { min: 0, max: 1 }), ...(blowU !== undefined ? { blowU } : {}),
        ...(late !== undefined ? { late } : {}), ...(hand !== undefined ? { hand } : {}), ...(window !== undefined ? { window } : {}),
      }
    }
    case 'pace': return { ...base, kind, like: id(a.like, f('like')) }
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
    case 'keys': {
      const bones = opt(a.bones, x => record(x, f('bones'), clipKeys))
      const gear = opt(a.gear, x => record(x, f('gear'), clipKeys))
      return { ...base, kind, ...(bones !== undefined ? { bones } : {}), ...(gear !== undefined ? { gear } : {}) }
    }
  }
}

function slotOf (v: unknown, what: string): Slot {
  const s = obj(v, what)
  const text = note(s.note, `${what}.note`)
  const adjustments = list(s.adjustments ?? [], `${what}.adjustments`, adjustment)
  if (new Set(adjustments.map(a => a.id)).size !== adjustments.length) bad(`${what}: adjustment ids repeat`)
  return {
    id: id(s.id, `${what}.id`), name: name(s.name, `${what}.name`), clip: clipRef(s.clip, `${what}.clip`),
    speed: num(s.speed, `${what}.speed`, { above: 0 }), loop: bool(s.loop, `${what}.loop`), inPlace: bool(s.inPlace, `${what}.inPlace`),
    ...(text !== undefined ? { note: text } : {}), adjustments,
  }
}

/** Its references resolve: the slot it paces like (one of `slotIds`, not its own), the gear and handle it names. */
function refs (c: Character, slot: Slot, a: Adjustment, slotIds: Set<string>): void {
  switch (a.kind) {
    case 'pace':
      if (a.like === slot.id) bad(`clip ${slot.name} can't pace like itself`)
      if (!slotIds.has(a.like)) missing(`No clip ${a.like} to pace like`)
      return
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
      return
    }
    case 'keys':
      for (const gid of Object.keys(a.gear ?? {})) if (gearById(c, gid) === undefined) missing(`No gear ${gid}`)
  }
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
    case 'blowTiming': return `blow at ${pct(a.at)}${a.window !== undefined ? ` (${r3(a.window)} s round it)` : ''}`
    case 'pace': return `pace of ${slotById(c, a.like)?.name ?? a.like}`
    case 'handPose': return `${a.hand} hand ${refText(c, a.pose)} in ${windowsText(a.windows)}${a.gear !== undefined ? ` (letting go of ${gearName(a.gear)})` : ''}`
    case 'handleHold': {
      const g = gearById(c, a.gear)
      return `hold of ${g?.name ?? a.gear} · ${g?.handles.find(h => h.id === a.handle)?.name ?? a.handle} in ${windowsText(a.windows)}`
    }
    case 'keys': return `keys on ${names([...Object.keys(a.bones ?? {}), ...Object.keys(a.gear ?? {}).map(gearName)]) || 'nothing'}`
  }
}

/** Added under the slot's rules: a keys adjustment merges into the slot's keys, per bone and gear. */
function add (c: Character, slot: Slot, a: Adjustment): string[] {
  const keys = a.kind === 'keys' ? slot.adjustments.find(o => o.kind === 'keys') : undefined
  if (a.kind === 'keys' && keys?.kind === 'keys') {
    if (a.bones !== undefined) keys.bones = { ...keys.bones, ...a.bones }
    if (a.gear !== undefined) keys.gear = { ...keys.gear, ...a.gear }
    return [`clip ${slot.name}: ${adjText(c, a)} merged into its keys`]
  }
  if (slot.adjustments.some(o => o.id === a.id)) conflict(`clip ${slot.name} has an adjustment ${a.id} already`)
  fits(slot, a, slot.adjustments)
  slot.adjustments.push(a)
  return [`clip ${slot.name}: ${adjText(c, a)} added`]
}

/** The slot's adjustments set to these, checked and merged by the rules. */
function settle (c: Character, slot: Slot, given: Adjustment[], slotIds: Set<string>): string[] {
  slot.adjustments = []
  return given.flatMap(a => { refs(c, slot, a, slotIds); return add(c, slot, a) })
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
      settle(c, s, s.adjustments, slotIdsOf(c))
      return [`clip ${s.name}: added (${s.clip.id})`]
    }
    case 'slot.update': {
      const s = find(cmd.id)
      const p = obj(cmd.patch, 'patch')
      for (const k of Object.keys(p)) if (!['name', 'speed', 'loop', 'inPlace', 'note'].includes(k)) bad(`patch can't change ${k}`)
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
      return out
    }
    case 'slot.fill': {
      const clip = clipRef(cmd.clip, 'clip')
      const speed = cmd.speed === undefined ? 1 : num(cmd.speed, 'speed', { above: 0 })
      const loop = opt(cmd.loop, x => bool(x, 'loop'))
      const inPlace = opt(cmd.inPlace, x => bool(x, 'inPlace'))
      const keep = opt(cmd.keepAdjustments, x => bool(x, 'keepAdjustments')) === true
      const added = list(cmd.adjustments ?? [], 'adjustments', adjustment)
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
      if (!keep && s.adjustments.length > 0) {
        out.push(`clip ${s.name}: ${names(s.adjustments.map(a => adjText(c, a)))} dropped (made for the clip it had)`)
        s.adjustments = []
      }
      const ids = slotIdsOf(c)
      for (const a of added) { refs(c, s, a, ids); out.push(...add(c, s, a)) }
      return out
    }
    case 'slot.remove': {
      const s = find(cmd.id)
      c.clips = c.clips.filter(x => x !== s)
      const out = [`clip ${s.name}: removed`]
      for (const o of c.clips) {
        const before = o.adjustments.length
        o.adjustments = o.adjustments.filter(a => a.kind !== 'pace' || a.like !== s.id)
        if (o.adjustments.length < before) out.push(`clip ${o.name}: pace of ${s.name} removed (that clip is gone)`)
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
      refs(c, s, a, slotIdsOf(c))
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
      refs(c, s, a, slotIdsOf(c))
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
      settle(c, s, given, slotIdsOf(c))
      if (same(was, s.adjustments)) return []
      return [s.adjustments.length > 0 ? `clip ${s.name}: adjustments now ${names(s.adjustments.map(a => adjText(c, a)))}` : `clip ${s.name}: adjustments cleared`]
    }
    case 'clips.replace': return replace(c, cmd)
  }
  return unknown(cmd)
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
    const kept: Adjustment[] = []
    for (const a of s.adjustments) {
      if (a.kind === 'pace' && (!ids.has(a.like) || a.like === s.id)) {
        out.push(`clip ${s.name}: pace dropped (the clip it followed isn't in the set)`)
        continue
      }
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
      if (a.kind === 'keys' && a.gear !== undefined) {
        const mapped: NonNullable<typeof a.gear> = {}
        for (const [gid, keys] of Object.entries(a.gear)) {
          const g = gearFor(gid)
          if (g !== undefined) mapped[g.id] = keys
          else out.push(`clip ${s.name}: keys on ${sourceName(gid)} dropped (no such gear here)`)
        }
        if (Object.keys(mapped).length > 0) a.gear = mapped
        else delete a.gear
        if (a.bones === undefined && a.gear === undefined) continue
      }
      kept.push(a)
    }
    s.adjustments = kept
  }
  c.clips = slots
  for (const s of slots) settle(c, s, s.adjustments, ids)
  return [`clips replaced: ${slots.length > 0 ? names(slots.map(s => s.name)) : 'none'}`, ...out]
}
