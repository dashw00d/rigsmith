// Reads a character.json of any schema as schema 2 (docs/rebuild/DESIGN.md §2.3). Pure and deterministic: every id it
// makes is stableId('<character id>:<what>:<index>'), so every process migrating the same file gets the same document,
// and a schema 2 document comes back as it is. It never touches files: the copies it needs are returned as fileOps,
// which the caller (server/store.ts, tools/migrate.ts) runs. GLBs and weight_edits.json are never among them.
//
// The converters (slotsFromV1, holdsFromV1, gearFromV1, gearFromProp) are also what src/model/legacy.ts uses to turn
// a v1 PATCH into commands.
import { stableId } from './ids.ts'
import { DEFAULT_FIST, handSide, safeName } from './select.ts'
import type {
  Adjustment, Character, ClipKey, FingerLevel, Gear, GearAttach, Handle, HandPoseRef, Joints, LookSection, Placement,
  Quat, Settings, SkeletonSection, SkinSection, Side, Slot, Vec3, Window,
} from './types.ts'
import type { GameSpec } from './unit.ts'
import type { V1AnimationEntry, V1Character, V1ClipScript, V1Garment, V1GripScript, V1PropAttachment, V1Settings } from './v1.ts'

export interface MigrateContext {
  /** Existing textures/*.png except *.mask.png (file names): each becomes a snapshot layer. */
  textureFiles?: string[]
  /** Key count of weight_edits.json. */
  paintedCount?: number
  /** Rest bone heads of rigged.glb (from its inverse bind matrices): the joints the rig was built on. */
  bindJoints?: Joints
  /** The game's units (workspace/game/units.json), to check a rider's horse against its unit's companion. */
  units?: GameSpec
}

/** A file to copy, both paths relative to the character folder. Migration never moves or deletes. */
export interface FileOp { op: 'copy', from: string, to: string }

export interface Migration {
  character: Character
  /** False: it was schema 2 already (nothing to write). */
  migrated: boolean
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

export function migrate (raw: unknown, ctx: MigrateContext = {}): Migration {
  if (raw === null || typeof raw !== 'object' || typeof (raw as { id?: unknown }).id !== 'string') throw new Error('Not a character')
  const schema = (raw as { schema?: unknown }).schema
  if (schema === 2) return { character: raw as Character, migrated: false, notes: [], fileOps: [] }
  if (schema !== undefined) throw new Error(`Character schema ${String(schema)} is newer than this Rigsmith`)
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
  const character: Character = defined({
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
  return { character, migrated: true, notes, fileOps }
}

/** How every reader that bypasses the server reads a character.json (tools, the unit export, dev scripts). */
export function readCharacter (raw: unknown): Character {
  return migrate(raw).character
}

/** Settings of any schema: the game repo and the shared hand poses (the export options went with the generic export). */
export function migrateSettings (raw: unknown, fallback: Settings = { gameRepo: '' }): Settings {
  const v = (raw ?? {}) as V1Settings
  return defined({
    gameRepo: typeof v.gameRepo === 'string' && v.gameRepo !== '' ? v.gameRepo : fallback.gameRepo,
    handPoses: v.handPoses ?? fallback.handPoses,
  })
}

// ---- skeleton and skin ------------------------------------------------------------------------------------------

/** The finger level a set of joints was made at. */
function levelOf (joints: Joints): FingerLevel {
  const has = (finger: string): boolean => `LeftHand${finger}1` in joints || `RightHand${finger}1` in joints
  return has('Middle') ? 'full' : has('Thumb') ? 'two' : has('Index') ? 'one' : 'none'
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
type NewAdjustment = Without<Adjustment, 'id'>

/**
 * Animation entries as slots, with what v1 kept elsewhere as their adjustments: the entry's lift and keys (gear keys
 * by garment name, through `gearIdByName`), blow and pace scripts (by entry name), the grip scripts' open windows,
 * and the garments' carryOpen windows and pull holds (`o.garments`, their ids the gear ids). Slot and adjustment ids
 * are stableId('<characterId>:slot:<i>') and ('<characterId>:adjust:<slot i>:<j>'). A name used twice: the first
 * keeps it and gets what is keyed by it, later ones are renamed.
 */
export function slotsFromV1 (animations: V1AnimationEntry[], scripts: V1ClipScript[] | undefined, gearIdByName: Record<string, string>,
  characterId: string, o: FromV1 & { garments?: V1Garment[] } = {}): Slot[] {
  const names = dedupe(animations.map(e => e.name))
  const slots: Slot[] = animations.map((e, i) => {
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
  const add = (slot: Slot, a: NewAdjustment): void => {
    const id = stableId(`${characterId}:adjust:${slots.indexOf(slot)}:${slot.adjustments.length}`)
    slot.adjustments.push(defined({ id, ...a }) as Adjustment)
  }
  const slotFor = (name: string, what: string): Slot | undefined => {
    const slot = byName.get(name)
    if (slot === undefined) o.notes?.push(`${what} for ${name} dropped: no clip of that name`)
    return slot
  }

  animations.forEach((e, i) => {
    const slot = slots[i]
    if (e.lift !== undefined && e.lift !== 0) add(slot, { kind: 'ground', enabled: true, lift: e.lift })
    const gear: Record<string, ClipKey[]> = {}
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
      o.notes?.push(`${slot.name}: its hand windows were set on the clip before its blow cut and are kept as they were; check them`)
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
