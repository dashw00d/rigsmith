// gear.*: everything worn or carried, and its handles. Rules kept here: names unique by their bone-safe form (the game
// export names meshes and bones after them) and fixed for the game's own gear; a piece on a hand bone has exactly one
// carry handle and none elsewhere; a hand pose a slot gives while a piece is carried follows the piece; only a piece on
// a bone has grips, pulls and keyed moves.
import type { Command } from '../command-types.ts'
import { carryHandle, gearById, handSide, safeName } from '../select.ts'
import type { Character, Gear, GearAttach, Handle, SkinPolicy, Slot } from '../types.ts'
import {
  bad, bool, clipKeys, conflict, handPoseRef, id, joint, list, missing, name, names, num, obj, oneOf, opt, overlaps, patchOf,
  placeText, placement, plural, quat, refText, same, side, str, under, uniqueName, unknown, vec3, vecText,
} from './common.ts'
import { mendHolders } from './clips.ts'
import { pruneGear } from './folk.ts'
import { syncLegacyPiece } from '../folk.ts'
import { rebaseGear } from '../origin.ts'

export type GearCommand = Extract<Command, { type: `gear.${string}` }>

const POLICIES: SkinPolicy[] = ['body', 'cape', 'skirt', 'upper', 'lower', 'head']
const fromGame = (g: Gear): boolean => g.from?.startsWith('emberhold:') === true

function attach (c: Character, v: unknown): GearAttach {
  const a = obj(v, 'attach')
  const place = placement(a.place, 'attach.place')
  switch (oneOf(a.kind, ['bone', 'skin', 'spot'] as const, 'attach.kind')) {
    case 'bone': {
      const legacy = opt(a.legacyFrame, x => oneOf(x, ['grip'] as const, 'attach.legacyFrame'))
      return { kind: 'bone', bone: joint(c, a.bone, 'attach.bone'), place, ...(legacy !== undefined ? { legacyFrame: legacy } : {}) }
    }
    case 'skin': {
      const hideBody = opt(a.hideBody, x => bool(x, 'attach.hideBody'))
      return { kind: 'skin', policy: oneOf(a.policy, POLICIES, 'attach.policy'), place, ...(hideBody === true ? { hideBody } : {}) }
    }
    case 'spot': {
      const anchor = opt(a.anchor, x => vec3(x, 'attach.anchor'))
      const animation = opt(a.animation, x => str(x, 'attach.animation'))
      return { kind: 'spot', place, ...(anchor !== undefined ? { anchor } : {}), ...(animation !== undefined ? { animation } : {}) }
    }
  }
}

const handlePlace = (v: unknown, what: string): NonNullable<Handle['place']> => {
  const p = obj(v, what)
  return { position: vec3(p.position, `${what}.position`), rotation: quat(p.rotation, `${what}.rotation`) }
}

const pullOf = (c: Character, v: unknown): NonNullable<Handle['pull']> => {
  const p = obj(v, 'pull')
  return { bone: joint(c, p.bone, 'pull.bone'), grip: vec3(p.grip, 'pull.grip'), rest: vec3(p.rest, 'pull.rest') }
}

function handle (c: Character, v: unknown, what: string): Handle {
  const h = obj(v, what)
  const kind = oneOf(h.kind, ['carry', 'grip', 'pull'] as const, `${what}.kind`)
  const place = opt(h.place, x => handlePlace(x, `${what}.place`))
  const exact = opt(h.exact, x => bool(x, `${what}.exact`))
  const pose = opt(h.pose, x => handPoseRef(x, `${what}.pose`))
  let hand = opt(h.hand, x => side(x, `${what}.hand`))
  let pull: Handle['pull']
  if (kind === 'pull') {
    pull = pullOf(c, h.pull)
    hand = handSide(pull.bone) ?? undefined   // (a pull's hand is the bone drawing it, if that is a hand)
  }
  return {
    id: id(h.id, `${what}.id`), name: name(h.name, `${what}.name`), kind,
    ...(hand !== undefined ? { hand } : {}), ...(place !== undefined ? { place } : {}), ...(exact === true ? { exact } : {}),
    ...(pose !== undefined ? { pose } : {}), ...(pull !== undefined ? { pull } : {}),
  }
}

function gearOf (c: Character, v: unknown): Gear {
  const g = obj(v, 'gear')
  const gid = id(g.id, 'gear.id')
  const handles = list(g.handles ?? [], 'gear.handles', (x, what) => handle(c, x, what))
  if (new Set(handles.map(h => h.id)).size !== handles.length) bad('Handle ids repeat')
  if (new Set(handles.map(h => h.name)).size !== handles.length) bad('Handle names repeat')
  if (handles.filter(h => h.kind === 'carry').length > 1) bad('A piece has one carry handle at most')
  const model = opt(g.model, x => under(x, `garments/${gid}/`, 'gear.model'))
  const catalog = opt(g.catalog, x => under(x, '', 'gear.catalog'))
  const error = opt(g.error, x => str(x, 'gear.error'))
  const hidden = opt(g.hidden, x => bool(x, 'gear.hidden'))
  const swapSet = opt(g.swapSet, x => (typeof x === 'string' ? x.trim() : bad('gear.swapSet must be text')))
  const from = opt(g.from, x => str(x, 'gear.from'))
  const painted = opt(g.painted, x => num(x, 'gear.painted', { min: 0 }))
  const origin = opt(g.origin, x => vec3(x, 'gear.origin'))
  const outfit = opt(g.outfit, x => (typeof x === 'string' ? x.trim() : bad('gear.outfit must be text')))
  const role = opt(g.role, x => oneOf(x, ['hair', 'beard'] as const, 'gear.role'))
  const tags = opt(g.tags, x => tagsOf(x, 'gear.tags'))
  return {
    id: gid, name: name(g.name, 'gear.name'),
    ...(model !== undefined ? { model } : {}), ...(catalog !== undefined ? { catalog } : {}),
    ...(origin !== undefined && origin.some(x => x !== 0) ? { origin } : {}),
    status: oneOf(g.status, ['importing', 'ready', 'error'] as const, 'gear.status'), ...(error !== undefined ? { error } : {}),
    attach: attach(c, g.attach), handles,
    ...(hidden === true ? { hidden } : {}), ...(swapSet ? { swapSet } : {}), ...(from !== undefined ? { from } : {}),
    ...(painted !== undefined ? { painted } : {}),
    ...(outfit ? { outfit } : {}), ...(role !== undefined ? { role } : {}), ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
  }
}

/** Tags: short lower-case words, each once. */
export function tagsOf (v: unknown, what: string): string[] {
  return [...new Set(list(v, what, (x, w) => (typeof x === 'string' && /^[a-z0-9-]{1,32}$/.test(x.trim()) ? x.trim() : bad(`${w} must be a short lower-case word`))))]
}

function attachText (a: GearAttach): string {
  if (a.kind === 'bone') return `on ${a.bone}`
  if (a.kind === 'skin') return `worn on the skin (follows ${a.policy})${a.hideBody === true ? ', hiding the body under it' : ''}`
  return `pinned to the skin${a.anchor !== undefined ? ` at ${vecText(a.anchor)}` : ''}${a.animation !== undefined ? `, playing ${a.animation}` : ''}`
}

function handleText (h: Handle): string {
  if (h.kind === 'pull') return `pull ${h.name} (drawn by ${h.pull!.bone})`
  if (h.kind === 'carry') return `carry handle ${h.name}`
  return `grip ${h.name}${h.hand !== undefined ? ` (${h.hand} hand)` : ''}`
}

const taken = (c: Character, gearName: string, except?: Gear): boolean => c.gear.some(o => o !== except && safeName(o.name) === safeName(gearName))

/** A carry handle exactly when the piece is on a hand bone, on that hand; the hand poses slots give it follow it to
 * the other hand (unless that hand is posed then already) and go when it leaves the hands. */
function syncCarry (c: Character, g: Gear): string[] {
  const out: string[] = []
  const hand = g.attach.kind === 'bone' ? handSide(g.attach.bone) : null
  const carry = carryHandle(g)
  if (hand === null) {
    if (carry !== undefined) {
      g.handles = g.handles.filter(h => h.kind !== 'carry')
      out.push(`gear ${g.name}: no longer carried (its carry handle removed)`)
    }
    for (const s of c.clips) {
      const gone = s.adjustments.filter(a => a.kind === 'handPose' && a.gear === g.id)
      if (gone.length === 0) continue
      s.adjustments = s.adjustments.filter(a => !gone.includes(a))
      out.push(`clip ${s.name}: hand pose letting go of ${g.name} removed (it isn't carried)`)
    }
    return out
  }
  if (carry === undefined) {
    let handleId = 'carry'
    for (let i = 2; g.handles.some(h => h.id === handleId); i++) handleId = `carry-${i}`
    g.handles.push({ id: handleId, name: uniqueName('Carried', x => g.handles.some(h => h.name === x)), kind: 'carry', hand })
    out.push(`gear ${g.name}: carried in the ${hand} hand`)
    return out
  }
  if (carry.hand === hand) return out
  carry.hand = hand
  out.push(`gear ${g.name}: carried in the ${hand} hand`)
  for (const s of c.clips) {
    for (const a of s.adjustments) {
      if (a.kind !== 'handPose' || a.gear !== g.id) continue
      const clash = s.adjustments.some(o => o.kind === 'handPose' && o !== a && o.hand === hand &&
        (o.windows ?? [[0, 1]]).some(w => (a.windows ?? [[0, 1]]).some(x => overlaps(w, x))))
      if (clash) {
        s.adjustments = s.adjustments.filter(o => o !== a)
        out.push(`clip ${s.name}: hand pose letting go of ${g.name} removed (the ${hand} hand is posed then already)`)
      } else {
        a.hand = hand
        out.push(`clip ${s.name}: hand pose letting go of ${g.name} moved to the ${hand} hand`)
      }
    }
  }
  return out
}

/** Off a bone (worn on the skin, pinned to a spot), a piece has no grips or pulls and no keyed moves (the export gives
 * only bone gear a bone of its own to key): they go, with the holds of its pulls. An undo brings them back with the
 * piece and its slots. */
function syncOffBone (c: Character, g: Gear): string[] {
  if (g.attach.kind === 'bone') return []
  const out: string[] = []
  const gone = g.handles.filter(h => h.kind === 'grip' || h.kind === 'pull')
  if (gone.length > 0) {
    g.handles = g.handles.filter(h => !gone.includes(h))
    for (const h of gone) out.push(`gear ${g.name}: ${handleText(h)} removed (it isn't on a bone)`)
  }
  for (const s of c.clips) {
    if (dropTrack(s, g.id)) out.push(`clip ${s.name}: the track of ${g.name} removed (it isn't on a bone)`)
    s.adjustments = s.adjustments.filter(a => {
      if (a.kind === 'handleHold' && a.gear === g.id) {
        out.push(`clip ${s.name}: hold of ${g.name} · ${gone.find(h => h.id === a.handle)?.name ?? a.handle} removed (it isn't on a bone)`)
        return false
      }
      return true
    })
  }
  return out
}

/** A slot's track of a piece (its keys, who holds it, when it shows) and its 'gear:<id>' mute taken out; whether it
 * had one. */
function dropTrack (s: Slot, gearId: string): boolean {
  if (s.muted !== undefined) {
    s.muted = s.muted.filter(m => m !== `gear:${gearId}`)
    if (s.muted.length === 0) delete s.muted
  }
  if (s.gear?.[gearId] === undefined) return false
  const rest = { ...s.gear }
  delete rest[gearId]
  if (Object.keys(rest).length > 0) s.gear = rest
  else delete s.gear
  return true
}

/** Each slot's build (slot.ik) keeps only hands on handles that still are (bone gear, a handle a hand can hold) and
 * pieces that still lead (bone gear); what went is said. */
function pruneIk (c: Character): string[] {
  const out: string[] = []
  for (const s of c.clips) {
    const ik = s.ik
    if (ik === undefined) continue
    const onBone = (gid: string): Gear | undefined => { const g = gearById(c, gid); return g?.attach.kind === 'bone' ? g : undefined }
    const hands = ik.hands.filter(h => {
      const g = onBone(h.gear)
      const handle = g?.handles.find(x => x.id === h.handle)
      if (handle !== undefined && handle.kind !== 'pull') return true
      out.push(`clip ${s.name}: ${h.hand} hand off ${g?.name ?? h.gear} (its handle went)`)
      return false
    })
    const lead = (ik.lead ?? []).filter(gid => {
      if (onBone(gid) !== undefined) return true
      out.push(`clip ${s.name}: ${gearById(c, gid)?.name ?? gid} no longer leads`)
      return false
    })
    if (hands.length === ik.hands.length && lead.length === (ik.lead ?? []).length) continue
    const next = { ...ik, hands }
    if (lead.length > 0) next.lead = lead
    else delete next.lead
    if (hands.length > 0 || next.lead !== undefined) s.ik = next
    else delete s.ik
  }
  return out
}

/** Each slot's holders of a piece (GearTrack.heldBy) made to fit it as it is now (clips.ts mendHolders: one by a
 * handle that went held where it is, one by a handle now for another bone that bone's, one placed on its attach bone
 * as it is), so a later slot.gear.update of the track passes; what changed is said. */
function pruneHolders (c: Character, g: Gear): string[] {
  const out: string[] = []
  for (const s of c.clips) {
    const track = s.gear?.[g.id]
    if (track?.heldBy === undefined) continue
    const { held, said } = mendHolders(g, track.heldBy, `clip ${s.name}`)
    if (said.length === 0) continue
    s.gear = { ...s.gear, [g.id]: { ...track, heldBy: held } }
    out.push(...said)
  }
  return out
}

/** Shown in a swap set, the others of the set are hidden. */
function showOnly (c: Character, g: Gear): string[] {
  if (g.hidden === true || g.swapSet === undefined) return []
  const out: string[] = []
  for (const o of c.gear) {
    if (o === g || o.hidden === true || o.swapSet !== g.swapSet) continue
    o.hidden = true
    out.push(`gear ${o.name}: hidden (${g.name} of swap set ${g.swapSet} shown)`)
  }
  return out
}

export function reduceGear (c: Character, cmd: GearCommand): string[] {
  switch (cmd.type) {
    case 'gear.add': {
      const g = gearOf(c, cmd.gear)
      if (gearById(c, g.id) !== undefined) conflict(`Gear id ${g.id} is taken`)
      const was = g.name
      if (taken(c, was)) {
        if (fromGame(g)) conflict(`A gear named ${was} exists already; the game names its gear, so this one can't be renamed`)
        g.name = uniqueName(was, x => taken(c, x))
      }
      c.gear.push(g)
      return [`gear ${g.name}: added (${attachText(g.attach)}${g.name !== was ? `; ${was} was taken` : ''})`, ...syncCarry(c, g), ...syncOffBone(c, g), ...showOnly(c, g), ...syncLegacyPiece(c, g, null)]
    }
    case 'gear.update': {
      const g = gearById(c, cmd.id) ?? missing(`No gear ${cmd.id}`)
      const p = patchOf(cmd.patch, ['name', 'hidden', 'swapSet', 'model', 'from', 'outfit', 'role', 'tags'])
      const out: string[] = []
      // (what a dynamic character's sets and pools follow until the UI is ported: src/model/folk.ts syncLegacyPiece)
      const legacy = { name: g.name, outfit: g.outfit, role: g.role, tags: g.tags === undefined ? undefined : [...g.tags] }
      // (`from` first: a tool may take a piece out of the game's hands and rename it at once)
      if (p.from !== undefined) {
        const from = opt(p.from, x => str(x, 'from'))
        if (from !== g.from) {
          if (from === undefined) delete g.from
          else g.from = from
          out.push(`gear ${g.name}: ${from === undefined ? 'its source forgotten' : `from ${from}`}`)
        }
      }
      if (p.name !== undefined) {
        const next = name(p.name, 'name')
        if (next !== g.name) {
          if (fromGame(g)) conflict(`${g.name} comes from the game, which names it`)
          if (taken(c, next, g)) conflict(`A gear named ${next} exists already`)
          out.push(`gear ${g.name}: renamed ${next}`)
          g.name = next
        }
      }
      if (p.swapSet !== undefined) {
        const set = p.swapSet === null ? '' : typeof p.swapSet === 'string' ? p.swapSet.trim() : bad('swapSet must be text')
        if (set !== (g.swapSet ?? '')) {
          if (set === '') delete g.swapSet
          else g.swapSet = set
          out.push(`gear ${g.name}: ${set === '' ? 'out of its swap set' : `in swap set ${set}`}`)
        }
      }
      if (p.outfit !== undefined) {
        const outfit = p.outfit === null ? '' : typeof p.outfit === 'string' ? p.outfit.trim() : bad('outfit must be text')
        if (outfit !== (g.outfit ?? '')) {
          if (outfit === '') delete g.outfit
          else g.outfit = outfit
          out.push(`gear ${g.name}: ${outfit === '' ? 'in no outfit' : `in outfit ${outfit}`}`)
        }
      }
      if (p.role !== undefined) {
        const role = p.role === null ? undefined : oneOf(p.role, ['hair', 'beard'] as const, 'role')
        if (role !== g.role) {
          if (role === undefined) delete g.role
          else g.role = role
          out.push(`gear ${g.name}: ${role === undefined ? 'no longer hair or beard' : `a unit's ${role}`}`)
        }
      }
      if (p.tags !== undefined) {
        const tags = p.tags === null ? [] : tagsOf(p.tags, 'tags')
        if (tags.join(' ') !== (g.tags ?? []).join(' ')) {
          if (tags.length === 0) delete g.tags
          else g.tags = tags
          out.push(`gear ${g.name}: ${tags.length === 0 ? 'no tags' : `tagged ${tags.join(', ')}`}`)
        }
      }
      if (p.model !== undefined) {
        const model = under(p.model, `garments/${g.id}/`, 'model')
        if (model !== g.model) {
          g.model = model
          const hadPainting = (g.painted ?? 0) > 0
          delete g.painted
          if (hadPainting) out.push(`gear ${g.name}: previous mesh weights cleared`)
          // (the origin was a point of the old file: the new one comes with its own)
          const had = g.origin !== undefined
          delete g.origin
          out.push(`gear ${g.name}: new mesh${had ? ' (its origin the new file\'s own)' : ''}`)
        }
      }
      if (p.hidden !== undefined) {
        const hidden = bool(p.hidden, 'hidden')
        if (hidden !== (g.hidden === true)) {
          if (hidden) g.hidden = true
          else delete g.hidden
          out.push(`gear ${g.name}: ${hidden ? 'hidden' : 'shown'}`)
        }
        if (!hidden) out.push(...showOnly(c, g))
      }
      if (!same(legacy, { name: g.name, outfit: g.outfit, role: g.role, tags: g.tags })) out.push(...syncLegacyPiece(c, g, legacy))
      return out
    }
    case 'gear.outfit.show': {
      const outfit = cmd.outfit === null ? null : str(cmd.outfit, 'outfit').trim()
      if (outfit !== null && !c.gear.some(g => g.outfit === outfit)) missing(`No outfit ${outfit}`)
      const out: string[] = []
      for (const g of c.gear) {
        if (g.outfit === undefined) continue
        const hide = g.outfit !== outfit
        if (hide === (g.hidden === true)) continue
        if (hide) g.hidden = true
        else delete g.hidden
      }
      out.push(outfit === null ? 'outfits: none shown' : `outfit ${outfit} shown`)
      return out
    }
    case 'gear.attach': {
      const g = gearById(c, cmd.id) ?? missing(`No gear ${cmd.id}`)
      const next = attach(c, cmd.attach)
      if (same(g.attach, next)) return []
      const was = g.attach
      g.attach = next
      const out: string[] = []
      if (!same({ ...was, place: null }, { ...next, place: null })) out.push(`gear ${g.name}: ${attachText(next)}`)
      if (!same(was.place, next.place)) out.push(`gear ${g.name}: ${placeText(next.place)}`)
      return [...out, ...syncCarry(c, g), ...syncOffBone(c, g), ...pruneIk(c), ...pruneHolders(c, g)]
    }
    case 'gear.place': {
      const g = gearById(c, cmd.id) ?? missing(`No gear ${cmd.id}`)
      const place = placement(cmd.place, 'place')
      const legacy = g.attach.kind === 'bone' && g.attach.legacyFrame !== undefined
      if (same(g.attach.place, place) && !legacy) return []
      g.attach.place = place
      if (g.attach.kind === 'bone') delete g.attach.legacyFrame
      return [`gear ${g.name}: ${placeText(place)}`]
    }
    case 'gear.origin': {
      const g = gearById(c, cmd.id) ?? missing(`No gear ${cmd.id}`)
      if (g.attach.kind === 'bone' && g.attach.legacyFrame !== undefined) conflict(`${g.name} is still placed in the old catalog frame: place it in Gear first`)
      const origin = cmd.origin === null ? null : vec3(cmd.origin, 'origin')
      const lead = cmd.lead === undefined ? {} : Object.fromEntries(Object.entries(obj(cmd.lead, 'lead')).map(([sid, keys]) => [sid, clipKeys(keys, `lead.${sid}`)]))
      if (same(g.origin ?? [0, 0, 0], origin ?? [0, 0, 0])) return []
      const r = rebaseGear(c, g, origin, lead)
      const carried = [
        'its placement',
        ...(r.handles > 0 ? [plural(r.handles, 'handle')] : []),
        ...(r.pulls > 0 ? [plural(r.pulls, 'pull')] : []),
        ...(r.slots.length > 0 ? [`its track in ${plural(r.slots.length, 'clip')}`] : []),
      ]
      return [
        `gear ${g.name}: origin ${origin === null || origin.every(x => x === 0) ? "back to its file's own" : `at ${vecText(origin)} of its model`} (nothing moves: ${names(carried)} carried over)`,
        ...r.leadKept.map(n => `clip ${n}: the keys of ${g.name}, which leads there, kept as they were (they turn about its new origin)`),
      ]
    }
    case 'gear.remove': {
      const g = gearById(c, cmd.id) ?? missing(`No gear ${cmd.id}`)
      c.gear = c.gear.filter(o => o !== g)
      const out = [`gear ${g.name}: removed`]
      // What pointed at it goes with it (and comes back with an undo).
      for (const s of c.clips) {
        if (dropTrack(s, g.id)) out.push(`clip ${s.name}: the track of ${g.name} removed`)
        s.adjustments = s.adjustments.filter(a => {
          if (a.kind === 'handleHold' && a.gear === g.id) {
            out.push(`clip ${s.name}: hold of ${g.name} · ${g.handles.find(h => h.id === a.handle)?.name ?? a.handle} removed`)
            return false
          }
          if (a.kind === 'handPose' && a.gear === g.id) {
            out.push(`clip ${s.name}: hand pose letting go of ${g.name} removed`)
            return false
          }
          return true
        })
      }
      return [...out, ...pruneIk(c), ...pruneGear(c, g)]
    }
    case 'gear.handle.add': {
      const g = gearById(c, cmd.gear) ?? missing(`No gear ${cmd.gear}`)
      const h = handle(c, cmd.handle, 'handle')
      if (h.kind === 'carry') {
        conflict(carryHandle(g) !== undefined ? `${g.name} has its carry handle already` : `${g.name} isn't on a hand; put it on one to carry it`)
      }
      if (g.attach.kind !== 'bone') bad(`${g.name} isn't on a bone; only a piece on a bone has grips and pulls`)
      if (g.handles.some(o => o.id === h.id)) conflict(`${g.name} has a handle ${h.id} already`)
      if (g.handles.some(o => o.name === h.name)) conflict(`${g.name} has a handle named ${h.name} already`)
      g.handles.push(h)
      return [`gear ${g.name}: ${handleText(h)} added`]
    }
    case 'gear.handle.update': {
      const g = gearById(c, cmd.gear) ?? missing(`No gear ${cmd.gear}`)
      const h = g.handles.find(o => o.id === cmd.id) ?? missing(`${g.name} has no handle ${cmd.id}`)
      const p = patchOf(cmd.patch, ['name', 'hand', 'place', 'exact', 'pose', 'pull'])
      const out: string[] = []
      const was = h.name
      if (p.name !== undefined) {
        const next = name(p.name, 'name')
        if (next !== h.name) {
          if (g.handles.some(o => o !== h && o.name === next)) conflict(`${g.name} has a handle named ${next} already`)
          h.name = next
          out.push(`gear ${g.name}: ${was} renamed ${next}`)
        }
      }
      if (p.pull !== undefined) {
        if (h.kind !== 'pull') bad('Only a pull handle has a pull')
        const pull = pullOf(c, p.pull)
        if (!same(pull, h.pull)) {
          h.pull = pull
          const hand = handSide(pull.bone)
          if (hand === null) delete h.hand
          else h.hand = hand
          out.push(`gear ${g.name}: ${h.name} drawn by ${pull.bone}, held at ${vecText(pull.grip)}, resting at ${vecText(pull.rest)}`)
        }
      }
      if (p.hand !== undefined) {
        const hand = opt(p.hand, x => side(x, 'hand'))
        if (h.kind !== 'grip' && hand !== h.hand) bad(h.kind === 'carry' ? "A carry handle's hand is the one the piece is on" : "A pull's hand is the bone drawing it")
        if (hand !== h.hand) {
          if (hand === undefined) delete h.hand
          else h.hand = hand
          out.push(`gear ${g.name}: ${h.name} for ${hand === undefined ? 'either hand' : `the ${hand} hand`}`)
        }
      }
      if (p.place !== undefined) {
        if (h.kind === 'pull') bad('A pull is placed by its pull')
        const place = opt(p.place, x => handlePlace(x, 'place'))
        if (!same(place ?? null, h.place ?? null)) {
          if (place === undefined) delete h.place
          else h.place = place
          out.push(`gear ${g.name}: ${h.name} ${place === undefined ? 'unplaced' : `placed at ${vecText(place.position)}`}`)
        }
      }
      if (p.exact !== undefined) {
        const exact = opt(p.exact, x => bool(x, 'exact')) === true
        if (exact !== (h.exact === true)) {
          if (exact) h.exact = true
          else delete h.exact
          out.push(`gear ${g.name}: ${h.name} held ${exact ? 'exactly where placed' : 'with some give'}`)
        }
      }
      if (p.pose !== undefined) {
        const pose = opt(p.pose, x => handPoseRef(x, 'pose'))
        if (!same(pose ?? null, h.pose ?? null)) {
          if (pose === undefined) delete h.pose
          else h.pose = pose
          const what = pose === undefined && h.kind === 'pull' ? 'leaves the hand as it is' : pose === undefined && h.kind === 'grip' ? 'holds the hand as it is held' : `holds the hand ${refText(c, pose)}`
          out.push(`gear ${g.name}: ${h.name} ${what}`)
        }
      }
      return [...out, ...pruneHolders(c, g)]
    }
    case 'gear.handle.remove': {
      const g = gearById(c, cmd.gear) ?? missing(`No gear ${cmd.gear}`)
      const h = g.handles.find(o => o.id === cmd.id) ?? missing(`${g.name} has no handle ${cmd.id}`)
      if (h.kind === 'carry') conflict(`The carry handle stays while ${g.name} is on a hand; move it off the hand instead`)
      g.handles = g.handles.filter(o => o !== h)
      const out = [`gear ${g.name}: ${handleText(h)} removed`]
      for (const s of c.clips) {
        const gone = s.adjustments.filter(a => a.kind === 'handleHold' && a.gear === g.id && a.handle === h.id)
        if (gone.length === 0) continue
        s.adjustments = s.adjustments.filter(a => !gone.includes(a))
        out.push(`clip ${s.name}: hold of ${g.name} · ${h.name} removed`)
      }
      return [...out, ...pruneIk(c), ...pruneHolders(c, g)]
    }
  }
  return unknown(cmd)
}
