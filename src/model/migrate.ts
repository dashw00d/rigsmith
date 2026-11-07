// Reads a character.json of any schema as schema 5: v1 -> v2 (docs/rebuild/DESIGN.md §2.3), then v2 -> v3
// (docs/motion-plan.md §5: a slot's blow timing, pace and keys become its time map and tracks, and every phase it held,
// a phase of the clip as it played, becomes source time), then v3 -> v4 (§11.5: a slot's holds become hold pieces of
// its source, every time it stores moved to where it plays in their composite; any other slot as it was), then v4 -> v5
// (a dynamic character's outfits, hair and beard roles, skins and clothes become its folk section and cloth layers:
// src/model/folk.ts folkFromLegacy; the old fields kept while the UI reads them). Pure and deterministic: every id it makes is
// stableId('<character id>:<what>:<index>'), so every process migrating the same file gets the same document, and a
// schema 5 document comes back as it is. It never touches files: the copies it needs are returned as fileOps, which the
// caller (server/store.ts, tools/migrate.ts) runs. GLBs and weight_edits.json are never among them.
//
// Moving a slot's phases into source time needs its blow fit's cut: the source's length and, for a blow the fit
// measured (the hand's fastest moment), that blow; making a schema 3 slot's holds pieces needs its source's length. The caller measures them on the character (src/engine/measure.ts,
// through tools/measure_clips.ts for the server) and hands them in as `clipTimes`.
//
// The converters (slotsFromV1, slotFromV2, holdsFromV1, gearFromV1, gearFromProp) are also what src/model/legacy.ts
// uses to turn a v1 PATCH into commands, and server/routes/restore.ts to read an old build.
import { folkFromLegacy } from './folk.ts'
import { stableId } from './ids.ts'
import { DEFAULT_FIST, handSide, safeName } from './select.ts'
import { fitBlow, fitRange, resolveTime, type TimeMap } from './timemap.ts'
import type {
  Adjustment, Character, ClipEvent, ClipKey, FingerLevel, Gear, GearAttach, GearTrack, Handle, HandPoseRef, Joints,
  LookSection, Piece, Placement, Quat, RetimeMarker, Settings, SkeletonSection, SkinSection, Side, Slot, SlotTime, Vec3, Window,
} from './types.ts'
import type { GameSpec } from './unit.ts'
import type { V2Adjustment, V2Character, V2ClipKey, V2Slot, V2Window } from './v2.ts'
import type { V3Character, V3Hold, V3Slot } from './v3.ts'
import type { V4Character } from './v4.ts'
import type { V1AnimationEntry, V1Character, V1ClipScript, V1Garment, V1GripScript, V1PropAttachment, V1Settings } from './v1.ts'

export interface MigrateContext {
  /** Existing textures/*.png except *.mask.png (file names): each becomes a snapshot layer. */
  textureFiles?: string[]
  /** Key count of weight_edits.json. */
  paintedCount?: number
  /** Rest bone heads of rigged.glb (from its inverse bind matrices): the joints the rig was built on. */
  bindJoints?: Joints
  /** The game's units (workspace/game/units.json), to check a rider's horse against its unit's companion, and the kinds
   * of a dynamic character (its units' folk.outfits). */
  units?: GameSpec
  /** By schema 2 slot id: its source clip's length (seconds, at speed 1) and, where its blow timing measured the blow,
   * the blow (seconds of the clip at the slot's speed, as timing.ts blowTime finds it). What moving a cut slot's
   * phases into source time needs (src/engine/measure.ts measureClipTimes). By schema 3 slot id (a slot with holds):
   * its source clip's length, what its holds becoming pieces needs (measure.ts measureHeld). */
  clipTimes?: Record<string, ClipTimes>
}

export interface ClipTimes { seconds: number, blow?: number }

/** What a measure of a character's clips found (src/engine/measure.ts measureClipTimes): per slot id, its clip's
 * times; the slots it couldn't measure, said in `problems`; of those, `missing` the ids of the slots whose clip doesn't
 * exist (no file, no such animation in it, no rig to play it on), as against one that failed to load or measure. */
export interface MeasuredTimes { times: Record<string, ClipTimes>, problems: string[], missing?: string[] }

export interface MigrateOptions {
  /** Throw when a slot's phases can't be moved into source time without `clipTimes` (a tool reading an old file),
   * rather than keep them as they were with a note. */
  strict?: boolean
}

/** A file to copy, both paths relative to the character folder. Migration never moves or deletes. */
export interface FileOp { op: 'copy', from: string, to: string }

export interface Migration {
  character: Character
  /** False: it was schema 5 already (nothing to write). */
  migrated: boolean
  /** The schema it was read at (1 to 5): a 4 is kept as character.v4.json, a 3 as character.v3.json, a 2 as
   * character.v2.json, a 1 as character.v1.json. */
  from: 1 | 2 | 3 | 4 | 5
  /** In plain words, for the journal: what changed meaning, what was dropped. */
  notes: string[]
  fileOps: FileOp[]
}

/** What the converters need besides the v1 record. */
export interface FromV1 {
  /** The character's own hand pose ids: a 'pose:<id>' naming another falls back to the default fist (as v1 did).
   * Unset: every pose id is taken as it is. */
  poses?: ReadonlySet<string>
  /** Where to say what was dropped or changed meaning. */
  notes?: string[]
}

const SIDES: Side[] = ['Left', 'Right']
const FINGER = /Hand(Thumb|Index|Middle|Ring|Pinky)\d+$/
/** Characters whose weights may be re-rigged (the rest were fixed by hand). */
const UNLOCKED = /^(scout|villager)-/

export function migrate (raw: unknown, ctx: MigrateContext = {}, o: MigrateOptions = {}): Migration {
  if (raw === null || typeof raw !== 'object' || typeof (raw as { id?: unknown }).id !== 'string') throw new Error('Not a character')
  const schema = (raw as { schema?: unknown }).schema
  if (schema === 5) return { character: raw as Character, migrated: false, from: 5, notes: [], fileOps: [] }
  if (schema === 4) {
    const notes: string[] = []
    return { character: toV5(raw as V4Character, ctx, notes), migrated: true, from: 4, notes, fileOps: [] }
  }
  if (schema === 3) {
    const notes: string[] = []
    return { character: toV5(toV4(raw as V3Character, ctx, notes, o), ctx, notes), migrated: true, from: 3, notes, fileOps: [] }
  }
  if (schema === 2) {
    const notes: string[] = []
    return { character: toV5(toV4(upgrade(raw as V2Character, ctx, notes, { ...o, from: 2 }), ctx, notes, o), ctx, notes), migrated: true, from: 2, notes, fileOps: [] }
  }
  if (schema !== undefined) throw new Error(`Character schema ${String(schema)} is newer than this Rigsmith`)
  const out = migrateV1(raw, ctx)
  return { character: toV5(toV4(upgrade(out.character, ctx, out.notes, { ...o, from: 1 }), ctx, out.notes, o), ctx, out.notes), migrated: true, from: 1, notes: out.notes, fileOps: out.fileOps }
}

/** A v1 character as schema 2 (DESIGN.md §2.3), what the schema 3 upgrade reads; also how the clip measure
 * (tools/measure_clips.ts) finds an old file's slots. Schema 2 comes back as it is. */
export function migrateV1 (raw: unknown, ctx: MigrateContext = {}): { character: V2Character, notes: string[], fileOps: FileOp[] } {
  if ((raw as { schema?: unknown }).schema === 2) return { character: raw as V2Character, notes: [], fileOps: [] }
  const v = raw as V1Character
  const notes: string[] = []
  const fileOps: FileOp[] = []
  const poses = new Set((v.handPoses ?? []).map(p => p.id))
  const o: FromV1 = { poses, notes }

  const garments = v.garments ?? []
  const gear = [...garments.map(g => gearFromV1(g, o)), ...(v.props ?? []).flatMap(p => gearFromProp(p, o) ?? [])]
  dedupe(gear.map(g => g.name), safeName).forEach((name, i) => {
    if (name === gear[i].name) return
    notes.push(`Two pieces of gear were named ${gear[i].name}: the second is now ${name}`)
    gear[i].name = name
  })
  // (keys name rigid garments: the first of a name, as v1 found them)
  const gearIdByName: Record<string, string> = {}
  for (const g of garments) gearIdByName[g.name] ??= g.id

  const hold = holdsFromV1(v.scripts, o)
  const character: V2Character = defined({
    schema: 2 as const,
    id: v.id,
    name: v.name,
    createdAt: v.createdAt ?? 0,
    updatedAt: v.updatedAt ?? 0,
    version: 1,
    revision: v.revision ?? 0,
    thumbVersion: v.thumbVersion,
    files: { ...v.files },
    status: v.status,
    error: v.error,
    source: defined({
      file: v.source?.file ?? '',
      originalName: v.source?.originalName ?? '',
      bytes: v.source?.bytes ?? 0,
      // (a rigged import converted onto the Rigsmith rig said 'mesh' and kept its preset)
      kind: v.kind === 'mesh' && v.rigPreset !== undefined ? 'rigged' as const : v.kind ?? 'mesh',
      rigPreset: v.rigPreset,
      scale: v.scale ?? 1,
      stats: v.stats === undefined ? undefined : { ...v.stats },
      warnings: v.rigReport?.method === 'import' ? [...v.rigReport.warnings] : [],
    }),
    skeleton: skeletonFromV1(v, notes),
    skin: skinFromV1(v, ctx, notes),
    hands: defined({ poses: clone(v.handPoses ?? []), hold: Object.keys(hold).length > 0 ? hold : undefined }),
    gear,
    clips: slotsFromV1(v.animations ?? [], v.scripts, gearIdByName, v.id, { ...o, garments }),
    look: lookFromV1(v, ctx, notes, fileOps),
    mount: v.mount === undefined ? undefined : clone(v.mount),
  })
  if (v.mount !== undefined) {
    for (const [name, unit] of Object.entries(ctx.units?.units ?? {})) {
      if (unit.character !== v.id || unit.companion?.character === v.mount.character) continue
      notes.push(`Rides ${v.mount.character}, but the unit ${name}'s companion is ${unit.companion?.character ?? 'none'}`)
    }
  }
  return { character, notes, fileOps }
}

/** How every reader that bypasses the server reads a character.json (tools, the unit export, dev scripts). Strict: an
 * old file whose slots need measuring to move into source time throws (run node tools/migrate.ts, or open Rigsmith). */
export function readCharacter (raw: unknown, ctx: MigrateContext = {}): Character {
  return migrate(raw, ctx, { strict: true }).character
}

// ---- schema 2 -> 3 ----------------------------------------------------------------------------------------------

/** A schema 2 character as schema 3: its slots through slotFromV2, the rest as it is. */
function upgrade (c: V2Character, ctx: MigrateContext, notes: string[], o: MigrateOptions & { from: 1 | 2 }): V3Character {
  const clips = c.clips.map((s, i) => slotFromV2(s, { characterId: c.id, index: i, times: ctx.clipTimes?.[s.id], notes, strict: o.strict, windowsInSource: o.from === 1 }))
  return { ...c, schema: 3, clips }
}

// ---- schema 3 -> 4 ----------------------------------------------------------------------------------------------

/** A schema 3 character as schema 4: each slot with holds through piecesFromHolds (its clip's length from
 * `clipTimes`), every other slot as it is. */
function toV4 (c: V3Character, ctx: MigrateContext, notes: string[], o: MigrateOptions): V4Character {
  const clips = c.clips.map((s, i): Slot => {
    if (heldOf(s).length === 0) return withoutHolds(s)
    const seconds = ctx.clipTimes?.[s.id]?.seconds
    if (seconds === undefined) {
      if (o.strict === true) throw new Error(`clip ${s.name} of ${c.id}: its clip's length must be measured to make its holds pieces: run node tools/migrate.ts (or open Rigsmith)`)
      notes.push(`clip ${s.name}: its ${heldOf(s).length === 1 ? 'hold' : 'holds'} dropped (its clip couldn't be measured to make them pieces)`)
      return withoutHolds(s)
    }
    notes.push(`clip ${s.name}: its ${heldOf(s).length === 1 ? 'hold is a held piece' : 'holds are held pieces'} of the clip now (real time: it can be keyed)`)
    return piecesFromHolds(s, seconds, `${c.id}:piece:${i}`)
  })
  return { ...c, schema: 4, clips }
}

// ---- schema 4 -> 5 ----------------------------------------------------------------------------------------------

/** A schema 4 character as schema 5: a dynamic character (gear with an outfit or a role) gets its folk section and cloth
 * layers from its old fields (src/model/folk.ts folkFromLegacy: each outfit a set, the hair and beard roles pools with
 * the old rules as requires/excludes, the skins the skin pool, each clothes layer a top-and-bottom cloth layer, the kinds
 * its game units' folk.outfits name, else one kind 'folk' wearing every set); Gear.outfit, Gear.role and look.clothes stay
 * as they are, read by the UI until it is ported. Anything else only changes its schema. */
export function toV5 (c: V4Character, ctx: MigrateContext = {}, notes: string[] = []): Character {
  const out: Character = { ...c, schema: 5 }
  const made = folkFromLegacy(c, ctx.units)
  if (made === null) return out
  out.folk = made.folk
  if (made.cloth.length > 0) out.look = { ...c.look, cloth: made.cloth }
  const f = made.folk
  const pools = f.pools.map(p => `${p.name.toLowerCase()} (${p.items.length})`)
  notes.push(`dynamic character: its ${f.sets.length === 1 ? 'outfit is a set' : `${f.sets.length} outfits are sets`}${pools.length > 0 ? `, pools ${pools.join(', ')}` : ''}` +
    `${made.cloth.length > 0 ? `, its clothes ${made.cloth.length} cloth layers (top and bottom)` : ''}; kinds ${f.kinds.map(k => k.id).join(', ')}`)
  return out
}

/** A slot's holds that hold anything, by `u`. */
const heldOf = (s: V3Slot): V3Hold[] => [...(s.time?.holds ?? [])].filter(h => h.seconds > 0).sort((a, b) => a.u - b.u)

function withoutHolds (s: V3Slot): Slot {
  if (s.time?.holds === undefined) return s as Slot
  const time = { ...s.time }
  delete time.holds
  const out = { ...s, time } as Slot
  if (Object.keys(time).length === 0) delete out.time
  return out
}

/**
 * A schema 3 slot's holds as hold pieces of its source (docs/motion-plan.md §11.5): with D its clip's length and holds at
 * u_1 < ... < u_k (s_j seconds), its pieces are clip [0, u_1·D], hold s_1, clip [u_1·D, u_2·D], ..., clip [u_k·D, D]
 * (empty clip pieces left out, holds with none between them one), and every time it stores moves from u to
 * (u·D + the seconds of the holds before u) / (D + all of them): where it played (one at a hold's u at its start).
 * Retime markers move the same way, with knots at each hold piece's ends, so the warp plays the same seconds. Ids:
 * a hold piece keeps its hold's id, a clip piece is stableId('<idBase>:<j>').
 */
export function piecesFromHolds (s: V3Slot, seconds: number, idBase: string): Slot {
  const holds = heldOf(s)
  const out = withoutHolds(s)
  if (holds.length === 0) return out
  const D = seconds
  const total = D + holds.reduce((n, h) => n + h.seconds, 0)
  const before = (u: number): number => holds.reduce((n, h) => n + (h.u < u ? h.seconds : 0), 0)
  const move = (u: number): number => Math.round((u * D + before(u)) / total * 1e12) / 1e12
  const pieces: Piece[] = []
  let at = 0
  for (const [j, h] of holds.entries()) {
    const u = Math.min(1, Math.max(0, h.u))
    if ((u - at) * D > 1e-6) pieces.push({ id: stableId(`${idBase}:${j}`), kind: 'clip', clip: { ...s.clip }, from: at * D, to: u * D })
    const last = pieces.at(-1)
    if (last?.kind === 'hold') last.to += h.seconds
    else pieces.push({ id: h.id, kind: 'hold', from: 0, to: h.seconds })
    at = u
  }
  if ((1 - at) * D > 1e-6) pieces.push({ id: stableId(`${idBase}:${holds.length}`), kind: 'clip', clip: { ...s.clip }, from: at * D, to: D })
  out.pieces = pieces
  const keys = (ks: ClipKey[]): ClipKey[] => ks.map(k => ({ ...k, u: move(k.u) }))
  const win = (ws: Window[]): Window[] => ws.map(([a, b]): Window => [move(a), move(b)])
  if (out.bones !== undefined) out.bones = Object.fromEntries(Object.entries(out.bones).map(([b, ks]) => [b, keys(ks)]))
  if (out.gear !== undefined) {
    out.gear = Object.fromEntries(Object.entries(out.gear).map(([g, t]): [string, GearTrack] => [g, defined({
      keys: t.keys === undefined ? undefined : keys(t.keys),
      heldBy: t.heldBy?.map(x => ({ ...x, u: move(x.u) })),
      shown: t.shown?.map(x => ({ ...x, u: move(x.u) })),
    })]))
  }
  if (out.events !== undefined) out.events = out.events.map(e => defined({ ...e, u: move(e.u), to: e.to === undefined ? undefined : move(e.to) }))
  out.adjustments = out.adjustments.map(a => (a.kind === 'ground' || (a.kind === 'handPose' && a.windows === undefined) ? a : { ...a, windows: win(a.windows!) }))
  if (out.ik !== undefined) out.ik = { ...out.ik, hands: out.ik.hands.map(h => defined({ ...h, windows: h.windows === undefined ? undefined : win(h.windows) })) }
  const markers = out.time?.markers
  if (markers !== undefined && out.time !== undefined) {
    // (the warp W' through each marker moved and each hold piece's ends: tau = W(u)·D + held before plays the same)
    const ms = [...markers].filter(m => m.u > 0 && m.u < 1).sort((a, b) => a.u - b.u)
    const warp = (u: number): number => {
      const xs = [0, ...ms.map(m => m.u), 1]; const ys = [0, ...ms.map(m => m.to), 1]
      let i = 1
      while (i < xs.length - 1 && xs[i] < u) i++
      return ys[i - 1] + (u - xs[i - 1]) / Math.max(xs[i] - xs[i - 1], 1e-12) * (ys[i] - ys[i - 1])
    }
    const knots: RetimeMarker[] = ms.map(m => ({ id: m.id, u: move(m.u), to: (m.to * D + before(m.u)) / total }))
    for (const [j, h] of holds.entries()) {
      const start = (h.u * D + before(h.u)) / total
      const w = (warp(h.u) * D + before(h.u)) / total
      knots.push({ id: stableId(`${idBase}:warp:${j}:a`), u: start, to: w }, { id: stableId(`${idBase}:warp:${j}:b`), u: start + h.seconds / total, to: w + h.seconds / total })
    }
    const kept = knots.map(m => ({ ...m, u: Math.round(m.u * 1e12) / 1e12, to: Math.round(m.to * 1e12) / 1e12 }))
      .filter(m => m.u > 1e-9 && m.u < 1 - 1e-9).sort((a, b) => a.u - b.u)
      .filter((m, i, all) => i === 0 || m.u - all[i - 1].u > 1e-9)
    out.time = { ...out.time, markers: kept }
  }
  return out
}

/** Whether a schema 2 slot's phases move when they go into source time: its blow timing is on and something in it has
 * a phase (keys, windows; `windowsInSource`: a slot from v1, whose windows were source time already, keys only). Speed
 * and pace are uniform, so nothing else moves them. */
export function cutMoves (s: V2Slot, o: { windowsInSource?: boolean } = {}): boolean {
  const on = s.adjustments.filter(a => a.enabled)
  if (!on.some(a => a.kind === 'blowTiming')) return false
  return s.adjustments.some(a => (a.kind === 'keys' && [...Object.values(a.bones ?? {}), ...Object.values(a.gear ?? {})].some(k => k.length > 0)) ||
    (o.windowsInSource !== true && ((a.kind === 'handPose' && a.windows !== undefined) || a.kind === 'handleHold')))
}

/** Whether migrating this file (any schema) needs its clips measured (src/engine/measure.ts): a schema 3 one with holds
 * (their clips' lengths), an older one whose phases move into source time. */
export function needsClipTimes (raw: unknown): boolean {
  const schema = (raw as { schema?: unknown }).schema
  if (schema === 4 || schema === 5) return false
  if (schema === 3) return (raw as V3Character).clips.some(s => heldOf(s).length > 0)
  return migrateV1(raw).character.clips.some(s => cutMoves(s, { windowsInSource: schema === undefined }))
}

/** What stops an old file (any schema) being written as schema 4 with `clipTimes`: the names of the slots whose keys
 * and windows move into source time (cutMoves) but whose cut can't be known from the times (of a schema 3 file: the
 * slots with holds whose clip's length isn't known), unless their clip doesn't
 * exist (`missing`, slot ids: it can't play either, so its phases are kept with a note). A clip that failed to load or
 * measure (a crash, a timeout, a bad file) is not missing: written then, its keys and windows would stay phases of the
 * clip as it played (wrong wherever a blow cut its start) and never be measured again, so the caller leaves the old
 * file to try again. Empty: it can be written. */
export function unmeasured (raw: unknown, clipTimes: Record<string, ClipTimes> | undefined, missing: readonly string[] = []): string[] {
  const schema = (raw as { schema?: unknown }).schema
  if (schema === 4 || schema === 5) return []
  if (schema === 3) return (raw as V3Character).clips.filter(s => heldOf(s).length > 0 && !missing.includes(s.id) && clipTimes?.[s.id]?.seconds === undefined).map(s => s.name)
  return migrateV1(raw).character.clips
    .filter(s => cutMoves(s, { windowsInSource: schema === undefined }) && !missing.includes(s.id) && v2TimeMap(s, clipTimes?.[s.id]) === null)
    .map(s => s.name)
}

/** The time map schema 2 played a slot by (its blow cut, with the measured blow where the fit measured it), or null
 * when the cut can't be known (`times` missing). Identity without an enabled blow timing. */
export function v2TimeMap (s: V2Slot, times: ClipTimes | undefined): TimeMap | null {
  const blow = s.adjustments.find((a): a is Extract<V2Adjustment, { kind: 'blowTiming' }> => a.enabled && a.kind === 'blowTiming')
  if (blow === undefined) return resolveTime({ seconds: times?.seconds ?? 1, speed: s.speed })
  if (times === undefined || (blow.blowU === undefined && times.blow === undefined)) return null
  const uncut = times.seconds / s.speed
  const at = blow.blowU !== undefined ? fitBlow(blow.blowU, uncut) : times.blow!
  return resolveTime({ seconds: times.seconds, speed: s.speed, kept: fitRange(at, uncut, blow) })
}

/**
 * A schema 2 slot as schema 3 (docs/motion-plan.md §5): blow timing -> time.fit (a blow picked by hand -> its `hit`
 * event), pace -> time.pace, keys -> bones and gear tracks (switched off: muted), ground, hand poses and handle holds
 * kept; every key and window from a phase of the clip as it played to source time, through the cut its blow timing
 * made (`times`; none needed without an enabled blow timing). Ids: the adjustments keep theirs, a hit event is
 * stableId('<character>:hit:<slot index>'). `windowsInSource`: the slot came from v1, which laid hand windows on before
 * its blow cut, so they are source time already. Without `times` where they are needed: strict throws, else the
 * phases are kept as they were and a note says so.
 */
export function slotFromV2 (s: V2Slot, o: { characterId: string, index: number, times?: ClipTimes, notes?: string[], strict?: boolean, windowsInSource?: boolean }): Slot {
  const moves = cutMoves(s, { windowsInSource: o.windowsInSource })
  const map = v2TimeMap(s, o.times)
  if (map === null) {
    if (o.strict === true && moves) throw new Error(`clip ${s.name} of ${o.characterId}: its blow cut must be measured to move its keys and windows into source time: run node tools/migrate.ts (or open Rigsmith)`)
    if (moves) o.notes?.push(`clip ${s.name}: its blow cut couldn't be measured, so its keys and windows were kept where the clip played them; check them`)
  }
  if (map !== null && moves) o.notes?.push(`clip ${s.name}: its keys and windows kept against its source clip, where its blow timing played them (so a change of timing no longer moves them)`)
  const toSource = (u: number): number => (map === null ? u : clampU(map.toSource(u)))
  const win = (w: V2Window[]): Window[] => w.map(([a, b]): Window => (o.windowsInSource === true ? [a, b] : [toSource(a), toSource(b)]))
  const keys = (ks: V2ClipKey[]): ClipKey[] => ks.map(k => defined({ u: toSource(k.u), q: [...k.q] as Quat, p: k.p === undefined ? undefined : [...k.p] as Vec3 }))
  const out: Slot = defined({
    id: s.id, name: s.name, clip: { ...s.clip }, speed: s.speed, loop: s.loop, inPlace: s.inPlace, note: s.note,
    adjustments: [] as Adjustment[],
  })
  const time: SlotTime = {}
  const events: ClipEvent[] = []
  for (const a of s.adjustments) {
    const lost = a.note !== undefined ? ` (its note: ${a.note})` : ''
    switch (a.kind) {
      case 'ground': out.adjustments.push(clone(a)); break
      case 'handPose': out.adjustments.push(defined({ ...clone(a), windows: a.windows === undefined ? undefined : win(a.windows) })); break
      case 'handleHold': out.adjustments.push({ ...clone(a), windows: win(a.windows) }); break
      case 'blowTiming':
        time.fit = defined({ enabled: a.enabled, at: a.at, late: a.late, window: a.window, hand: a.hand })
        if (a.blowU !== undefined) events.push({ id: stableId(`${o.characterId}:hit:${o.index}`), name: 'hit', u: a.blowU })
        if (lost !== '') o.notes?.push(`clip ${s.name}: blow timing${lost}`)
        break
      case 'pace':
        time.pace = { enabled: a.enabled, like: a.like }
        if (lost !== '') o.notes?.push(`clip ${s.name}: pace${lost}`)
        break
      case 'keys': {
        const bones = Object.entries(a.bones ?? {}).filter(([, k]) => k.length > 0)
        const gear = Object.entries(a.gear ?? {}).filter(([, k]) => k.length > 0)
        if (bones.length > 0) out.bones = Object.fromEntries(bones.map(([b, k]) => [b, keys(k)]))
        if (gear.length > 0) out.gear = Object.fromEntries(gear.map(([g, k]): [string, GearTrack] => [g, { keys: keys(k) }]))
        if (!a.enabled && (bones.length > 0 || gear.length > 0)) out.muted = ['bones', 'gear']
        if (lost !== '') o.notes?.push(`clip ${s.name}: keys${lost}`)
        break
      }
    }
  }
  if (Object.keys(time).length > 0) out.time = time
  if (events.length > 0) out.events = events
  return out
}

const clampU = (u: number): number => Math.min(16, Math.max(0, u))

/** A schema 3 slot in schema 2's shape, its times left as they are (source time): for the deprecated v1 view
 * (src/model/legacy.ts), whose clients never read phases closely. Its fit, pace and keys become the adjustments they
 * were (ids '<slot>-fit', '-pace', '-keys'; `rowIds`: 'fit', 'pace', 'keys', the Motion stack's rows). What schema 2 had no place for (markers, holds, events but the hit, who
 * holds gear, eases) is left out. */
export function slotToV2 (s: Slot, o: { rowIds?: boolean } = {}): V2Slot {
  const idOf = (what: string): string => (o.rowIds === true ? what : `${s.id}-${what}`)
  const adjustments = clone(s.adjustments) as V2Adjustment[]
  const fit = s.time?.fit
  const hit = s.events?.find(e => e.name === 'hit' && e.to === undefined)
  if (fit !== undefined) adjustments.push(defined({ id: idOf('fit'), kind: 'blowTiming' as const, enabled: fit.enabled, at: fit.at, blowU: hit?.u, late: fit.late, hand: fit.hand, window: fit.window }))
  if (s.time?.pace !== undefined) adjustments.push({ id: idOf('pace'), kind: 'pace', enabled: s.time.pace.enabled, like: s.time.pace.like })
  const strip = (ks: ClipKey[]): V2ClipKey[] => ks.map(k => defined({ u: k.u, q: [...k.q] as Quat, p: k.p === undefined ? undefined : [...k.p] as Vec3 }))
  const bones = Object.fromEntries(Object.entries(s.bones ?? {}).map(([b, k]) => [b, strip(k)]))
  const gear = Object.fromEntries(Object.entries(s.gear ?? {}).filter(([, t]) => (t.keys?.length ?? 0) > 0).map(([g, t]) => [g, strip(t.keys!)]))
  if (Object.keys(bones).length > 0 || Object.keys(gear).length > 0) {
    adjustments.push(defined({
      id: idOf('keys'), kind: 'keys' as const, enabled: !(s.muted?.includes('bones') === true && s.muted.includes('gear')),
      bones: Object.keys(bones).length > 0 ? bones : undefined, gear: Object.keys(gear).length > 0 ? gear : undefined,
    }))
  }
  return defined({ id: s.id, name: s.name, clip: { ...s.clip }, speed: s.speed, loop: s.loop, inPlace: s.inPlace, note: s.note, adjustments })
}

/** Settings of any schema: the game repo and the shared hand poses (the export options went with the generic export). */
export function migrateSettings (raw: unknown, fallback: Settings = { gameRepo: '' }): Settings {
  const v = (raw ?? {}) as V1Settings
  return defined({
    gameRepo: typeof v.gameRepo === 'string' && v.gameRepo !== '' ? v.gameRepo : fallback.gameRepo,
    handPoses: v.handPoses ?? fallback.handPoses,
    comfyUrl: typeof (raw as { comfyUrl?: unknown } | null)?.comfyUrl === 'string' && (raw as { comfyUrl: string }).comfyUrl.trim() !== ''
      ? (raw as { comfyUrl: string }).comfyUrl.trim() : fallback.comfyUrl,
    incomingDir: typeof (raw as { incomingDir?: unknown } | null)?.incomingDir === 'string' && (raw as { incomingDir: string }).incomingDir.trim() !== ''
      ? (raw as { incomingDir: string }).incomingDir.trim() : fallback.incomingDir,
  })
}

// ---- skeleton and skin ------------------------------------------------------------------------------------------

/** The finger level a set of joints was made at. */
function levelOf (joints: Joints): FingerLevel {
  const has = (finger: string): boolean => `LeftHand${finger}1` in joints || `RightHand${finger}1` in joints
  return has('Ring') ? 'full' : has('Middle') ? 'three' : has('Thumb') ? 'two' : has('Index') ? 'one' : 'none'
}

function skeletonFromV1 (v: V1Character, notes: string[]): SkeletonSection {
  const s: SkeletonSection = defined({
    template: v.template ?? 'human',
    fingerLevel: v.fingers ?? 'full',
    overrides: {},
    imported: (v.template ?? 'human') === 'human' && v.autoJoints !== undefined ? clone(v.autoJoints) : undefined,
    converted: v.kind === 'mesh' && v.rigPreset !== undefined ? true as const : undefined,
    markers: v.markers === undefined ? undefined : clone(v.markers),
    boneMap: v.boneMap === undefined ? undefined : { ...v.boneMap },
  })
  const joints = v.joints
  if (joints === undefined) return s
  if (v.autoJoints === undefined || v.jointsEdited !== true) {
    s.detected = clone(joints)
    return s
  }
  // Edited by hand: what was detected is the import's (autoJoints), except fingers traced since at another level (a
  // finger level change rewrote them in `joints`); what differs from that is the user's.
  const auto = v.autoJoints
  const fingers = levelOf(auto) === s.fingerLevel ? auto : joints
  const detected: Joints = {}
  for (const [k, p] of Object.entries(auto)) if (!FINGER.test(k)) detected[k] = [...p]
  for (const [k, p] of Object.entries(fingers)) if (FINGER.test(k)) detected[k] = [...p]
  for (const [k, p] of Object.entries(joints)) if (!(k in auto)) detected[k] = [...p]
  for (const [k, p] of Object.entries(joints)) {
    const d = detected[k]
    if (d === undefined || p.some((x, i) => Math.abs(x - d[i]) > 1e-7)) s.overrides[k] = [...p]
  }
  s.detected = detected
  const n = Object.keys(s.overrides).length
  if (n > 0) notes.push(`${n} joint${n === 1 ? '' : 's'} placed by hand kept as overrides of the detected skeleton`)
  return s
}

function skinFromV1 (v: V1Character, ctx: MigrateContext, notes: string[]): SkinSection {
  const rigged = v.status === 'rigged'
  const locked = rigged && !UNLOCKED.test(v.id)
  if (locked) notes.push('Skin locked: its weights were fixed by hand (unlock it in Skin to re-rig or paint)')
  const r = v.rigReport
  const rigJoints = ctx.bindJoints ?? v.joints
  return defined({
    report: r === undefined || r.method === 'import' ? undefined : { method: r.method, seconds: r.seconds, warnings: [...r.warnings] },
    locked,
    lockReason: locked ? 'hand-fixed weights' : undefined,
    painted: ctx.paintedCount !== undefined && ctx.paintedCount > 0 ? ctx.paintedCount : undefined,
    rigJoints: rigged && rigJoints !== undefined ? clone(rigJoints) : undefined,
    bones: rigged ? v.stats?.bones : undefined,
  })
}

// ---- hands ------------------------------------------------------------------------------------------------------

/** A v1 hand pose string as a reference: unset or the default fist 'default', 'open' the clip's own hand, 'pose:<id>'
 * one of the character's poses, any other a fist clip. */
function refOf (x: string | undefined, o: FromV1, what: string): HandPoseRef {
  if (x === undefined || x === DEFAULT_FIST) return 'default'
  if (x === 'open') return 'clip'
  if (!x.startsWith('pose:')) return { fist: x }
  const id = x.slice(5)
  if (o.poses === undefined || o.poses.has(id)) return { pose: id }
  o.notes?.push(`${what}: its hand pose ${id} no longer exists, so the default fist`)
  return 'default'
}

/** Each hand's grip script as v1 applied it: of the enabled ones, the last (it was laid over the others). */
function gripsOf (scripts: V1ClipScript[] | undefined): Partial<Record<Side, V1GripScript>> {
  const out: Partial<Record<Side, V1GripScript>> = {}
  for (const s of scripts ?? []) if (s.kind === 'grip' && s.enabled) out[s.side] = s
  return out
}

/** The character-wide grip scripts as hands.hold. (Their open windows are slot adjustments: slotsFromV1.) */
export function holdsFromV1 (scripts: V1ClipScript[] | undefined, o: FromV1 = {}): Partial<Record<Side, HandPoseRef>> {
  const hold: Partial<Record<Side, HandPoseRef>> = {}
  const grips = gripsOf(scripts)
  for (const s of scripts ?? []) {
    if (s.kind !== 'grip') continue
    if (!s.enabled) o.notes?.push(`The ${s.side} hand's grip (${s.clip}), switched off, dropped`)
    else if (grips[s.side] !== s) o.notes?.push(`The ${s.side} hand had two grips: the later one (${grips[s.side]!.clip}) kept`)
  }
  for (const side of SIDES) {
    const s = grips[side]
    if (s === undefined) continue
    hold[side] = refOf(s.clip, o, `The ${side} hand's grip`)
    o.notes?.push(`${side} hand held in every clip (${s.clip})${s.note !== undefined ? `: ${s.note}` : ''}`)
  }
  return hold
}

// ---- gear -------------------------------------------------------------------------------------------------------

const handOf = (bone: string): Side | undefined => handSide(bone) ?? undefined

/** Whose grip a v1 socket was: by its name ("Left hand") or its id ("left-hand"). */
function socketHand (s: { id: string, name: string }): Side | undefined {
  const m = /^(Left|Right)\b/.exec(s.name)?.[1] ?? /^(left|right)-hand$/.exec(s.id)?.[1]
  return m === undefined ? undefined : (m[0].toUpperCase() + m.slice(1)) as Side
}

const placeOf = (x: { position: Vec3, rotation: Vec3, scale: number }): Placement =>
  ({ position: [...x.position], rotation: [...x.rotation], scale: x.scale })

/** A garment as gear: its kind as an attach, its carry socket, grips and pulls as handles. */
export function gearFromV1 (g: V1Garment, o: FromV1 = {}): Gear {
  const place = placeOf(g)
  const attach: GearAttach = g.mode === 'clothing'
    ? defined({ kind: 'skin' as const, policy: g.policy ?? 'body', place, hideBody: g.hideBody === true ? true as const : undefined })
    : g.mode === 'part'
      ? defined({ kind: 'spot' as const, place, anchor: g.anchor === undefined ? undefined : [...g.anchor] as Vec3, animation: g.animation })
      : { kind: 'bone', bone: g.bone, place }
  const handles: Handle[] = []
  const side = attach.kind === 'bone' ? handOf(attach.bone) : undefined
  const carry: Handle | undefined = side === undefined
    ? undefined
    : { id: 'carry', name: 'Carried', kind: 'carry', hand: side, pose: refOf(g.carryPose, o, `${g.name}'s carry pose`) }
  if (carry !== undefined) handles.push(carry)
  for (const s of g.sockets ?? []) {
    // ("(carries it)" sockets were made from the carry hand and filtered out again)
    if (/\(carries it\)$/.test(s.name)) continue
    const hand = socketHand(s)
    const at = { position: [...s.position] as Vec3, rotation: [...s.rotation] as Quat }
    if (carry !== undefined && hand === side && carry.place === undefined) {
      carry.place = at
      if (s.placed === true) carry.exact = true
      continue
    }
    handles.push(defined({ id: s.id, name: s.name, kind: 'grip' as const, hand, place: at, exact: s.placed === true ? true : undefined }))
  }
  for (const p of g.pulls ?? []) {
    handles.push(defined({
      id: p.id,
      name: p.name,
      kind: 'pull' as const,
      hand: handOf(p.bone),
      pull: { bone: p.bone, grip: [...p.grip] as Vec3, rest: [...p.rest] as Vec3 },
      pose: p.pose === undefined || p.pose === 'open' ? undefined : refOf(p.pose, o, `${g.name}'s ${p.name}`),
    }))
  }
  return defined({
    id: g.id,
    name: g.name,
    model: g.file,
    status: g.status,
    error: g.error,
    attach,
    handles,
    hidden: g.hidden === true ? true : undefined,
    swapSet: g.group === '' ? undefined : g.group,
    from: g.from,
    painted: g.painted,
  })
}

/** A catalog prop as gear, its placement still in the old grip frame (the gear area converts it on first load).
 * Null for a prop that names no catalog file. */
export function gearFromProp (p: V1PropAttachment, o: FromV1 = {}): Gear | null {
  if (!p.ref.startsWith('catalog:')) {
    o.notes?.push(`${p.name} (${p.ref}) dropped: only catalog props can be read`)
    return null
  }
  const hand = handOf(p.socket)
  // (v1 never closed a hand round a catalog prop: its carry handle leaves the clip's own hand)
  if (hand !== undefined) o.notes?.push(`${p.name}, a catalog prop in the ${hand} hand: the hand stays as each clip has it, as before`)
  return {
    id: p.id,
    name: p.name,
    catalog: p.ref.slice('catalog:'.length),
    from: p.ref,
    status: 'ready',
    attach: { kind: 'bone', bone: p.socket, place: placeOf(p), legacyFrame: 'grip' },
    handles: hand === undefined ? [] : [{ id: 'carry', name: 'Carried', kind: 'carry', hand, pose: 'clip' }],
  }
}

// ---- clips ------------------------------------------------------------------------------------------------------

// (Omit over each kind of the union, not over the union as a whole)
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type NewAdjustment = Without<V2Adjustment, 'id'>

/**
 * Animation entries as slots, with what v1 kept elsewhere as their adjustments: the entry's lift and keys (gear keys
 * by garment name, through `gearIdByName`), blow and pace scripts (by entry name), the grip scripts' open windows,
 * and the garments' carryOpen windows and pull holds (`o.garments`, their ids the gear ids). Slot and adjustment ids
 * are stableId('<characterId>:slot:<i>') and ('<characterId>:adjust:<slot i>:<j>'). A name used twice: the first
 * keeps it and gets what is keyed by it, later ones are renamed.
 */
export function slotsFromV1 (animations: V1AnimationEntry[], scripts: V1ClipScript[] | undefined, gearIdByName: Record<string, string>,
  characterId: string, o: FromV1 & { garments?: V1Garment[] } = {}): V2Slot[] {
  const names = dedupe(animations.map(e => e.name))
  const slots: V2Slot[] = animations.map((e, i) => {
    if (names[i] !== e.name) o.notes?.push(`Two clips were named ${e.name}: the second is now ${names[i]}`)
    return defined({
      id: stableId(`${characterId}:slot:${i}`),
      name: names[i],
      clip: defined({ id: e.clipId, url: e.url }),
      speed: e.speed ?? 1,
      loop: e.loop === true,
      inPlace: e.inPlace === true,
      note: e.note,
      adjustments: [],
    })
  })
  const byName = new Map(slots.map(s => [s.name, s]))
  const add = (slot: V2Slot, a: NewAdjustment): void => {
    const id = stableId(`${characterId}:adjust:${slots.indexOf(slot)}:${slot.adjustments.length}`)
    slot.adjustments.push(defined({ id, ...a }) as V2Adjustment)
  }
  const slotFor = (name: string, what: string): V2Slot | undefined => {
    const slot = byName.get(name)
    if (slot === undefined) o.notes?.push(`${what} for ${name} dropped: no clip of that name`)
    return slot
  }

  animations.forEach((e, i) => {
    const slot = slots[i]
    if (e.lift !== undefined && e.lift !== 0) add(slot, { kind: 'ground', enabled: true, lift: e.lift })
    const gear: Record<string, V2ClipKey[]> = {}
    for (const [name, keys] of Object.entries(e.keys?.props ?? {})) {
      const id = gearIdByName[name]
      if (id === undefined) o.notes?.push(`${slot.name}: keys for ${name} dropped (no gear of that name)`)
      else gear[id] = clone(keys)
    }
    const bones = e.keys?.bones
    const hasBones = bones !== undefined && Object.keys(bones).length > 0
    if (hasBones || Object.keys(gear).length > 0) {
      add(slot, { kind: 'keys', enabled: true, bones: hasBones ? clone(bones) : undefined, gear: Object.keys(gear).length > 0 ? gear : undefined })
    }
  })

  for (const s of scripts ?? []) {
    if (s.kind === 'blow') {
      const slot = slotFor(s.clip, 'Blow timing')
      if (slot === undefined) continue
      if (slot.adjustments.some(a => a.kind === 'blowTiming')) { o.notes?.push(`${slot.name}: a second blow timing dropped`); continue }
      add(slot, { kind: 'blowTiming', enabled: s.enabled, note: s.note, at: s.at, blowU: s.blowU, late: s.late, hand: s.hand, window: s.window })
    } else if (s.kind === 'pace') {
      const slot = slotFor(s.clip, 'Pace')
      const like = byName.get(s.like)
      if (slot === undefined) continue
      if (like === undefined || like === slot) { o.notes?.push(`${slot.name}: its pace like ${s.like} dropped (${like === slot ? 'itself' : 'no clip of that name'})`); continue }
      if (slot.adjustments.some(a => a.kind === 'pace')) { o.notes?.push(`${slot.name}: a second pace dropped`); continue }
      add(slot, { kind: 'pace', enabled: s.enabled, note: s.note, like: like.id })
    }
  }

  const grips = gripsOf(scripts)
  for (const side of SIDES) {
    for (const [name, windows] of Object.entries(grips[side]?.open ?? {})) {
      const slot = windows.length > 0 ? slotFor(name, `The ${side} hand's open windows`) : undefined
      if (slot !== undefined) add(slot, { kind: 'handPose', enabled: true, hand: side, pose: 'clip', windows: sorted(windows) })
    }
  }
  for (const g of o.garments ?? []) {
    const side = g.mode === 'rigid' ? handOf(g.bone) : undefined
    for (const [name, windows] of Object.entries(g.carryOpen ?? {})) {
      if (windows.length === 0) continue
      if (side === undefined) { o.notes?.push(`${g.name}: its open windows dropped (it is not carried in a hand)`); continue }
      const slot = slotFor(name, `${g.name}'s open windows`)
      if (slot === undefined) continue
      // (v1 skipped a carried piece's fist and windows altogether when the hand had a grip of its own)
      if (grips[side] !== undefined) o.notes?.push(`${slot.name}: ${g.name}'s open windows now open the ${side} hand over its grip too`)
      add(slot, { kind: 'handPose', enabled: true, hand: side, pose: 'clip', windows: sorted(windows), gear: g.id })
    }
    for (const p of g.pulls ?? []) {
      for (const [name, windows] of Object.entries(p.holds ?? {})) {
        const slot = windows.length > 0 ? slotFor(name, `${g.name}'s ${p.name} holds`) : undefined
        if (slot !== undefined) add(slot, { kind: 'handleHold', enabled: true, gear: g.id, handle: p.id, windows: sorted(windows) })
      }
    }
  }

  for (const slot of slots) {
    const cut = slot.adjustments.some(a => a.kind === 'blowTiming' && a.enabled)
    if (cut && slot.adjustments.some(a => a.kind === 'handPose' || a.kind === 'handleHold')) {
      o.notes?.push(`${slot.name}: its hand windows were set on the clip before its blow cut, as source time keeps them now`)
    }
  }
  return slots
}

// ---- look -------------------------------------------------------------------------------------------------------

// (Blender's bpy.path.clean_name keeps ASCII letters, digits, _ and -, U+00FF and everything above it)
const kept = (c: number): boolean =>
  c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c >= 0xff

/** Blender's bpy.path.clean_name, exactly: what textures/<image>.png is named by, and the name a look layer and the
 * scan give an image. The model keeps its own copy (it imports neither the server nor three.js); server/glbimages.ts
 * cleanImageName and src/engine/projection.ts cleanName are the others, and the tests hold all three to the same names. */
function cleanName (name: string): string {
  let out = ''
  for (const ch of name) out += kept(ch.codePointAt(0)!) ? ch : '_'
  return out
}
const stem = (file: string): string => file.replace(/^.*\//, '').replace(/\.png$/i, '')

function lookFromV1 (v: V1Character, ctx: MigrateContext, notes: string[], fileOps: FileOp[]): LookSection {
  const t = v.texture
  const look: LookSection = defined({
    layers: [],
    scan: t !== undefined && t.images.length > 0
      ? { images: t.images.map(i => ({ image: typeof i.file === 'string' && i.file !== '' ? stem(i.file) : cleanName(i.image), coverage: i.coverage })), at: t.at ?? 0 }
      : undefined,
    at: t?.at,
    skins: v.skins !== undefined && v.skins.length > 0 ? clone(v.skins) : undefined,
  })
  // (the texture as it is now, made before layers existed: kept whole, laid over the source image)
  const files = (ctx.textureFiles ?? []).filter(f => /\.png$/i.test(f) && !/\.mask\.png$/i.test(f)).sort()
  files.forEach((f, i) => {
    const id = stableId(`${v.id}:layer:${i}`)
    const file = `textures/layers/${id}.png`
    look.layers.push({ id, kind: 'snapshot', image: stem(f), file, enabled: true, at: t?.at ?? 0 })
    fileOps.push({ op: 'copy', from: `textures/${f}`, to: file })
    notes.push(`The texture ${f} kept as a layer`)
  })
  return look
}

// ---- helpers ----------------------------------------------------------------------------------------------------

/** `o` without its undefined keys (so documents compare and serialize the same however they were built). */
function defined<T extends object> (o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k]
  return o
}

function clone<T> (x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

/** Windows in order of their start, as the reducers keep them. */
const sorted = (windows: Array<[number, number]>): Window[] => windows.map(([a, b]): Window => [a, b]).sort((x, y) => x[0] - y[0])

/** Names made unique (by `key`): the first keeps its name, a later one becomes `<name> 2`, `<name> 3`…, one no other
 * name has. */
function dedupe (names: string[], key: (name: string) => string = n => n): string[] {
  const all = new Set(names.map(key))
  const used = new Set<string>()
  return names.map(name => {
    let out = name
    for (let n = 2; used.has(key(out)) || (out !== name && all.has(key(out))); n++) out = `${name} ${n}`
    used.add(key(out))
    return out
  })
}
