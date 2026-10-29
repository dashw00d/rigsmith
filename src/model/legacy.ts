// The deprecated v1 layer (docs/rebuild/DESIGN.md §4.2): a character as v1 clients read it, and their whole-field
// PATCHes as commands. The game repo's own scripts (tools/rigsmith/import_new_units.py, import_gear.py) and
// tools/game_import.py speak v1 until they are ported; server/compat.ts answers them through this file. The view is
// read-only: a v1 client changes animations, scripts, garments and props only, through v1PatchToCommands.
//
// Slots go through schema 2's shape (src/model/migrate.ts slotToV2 / slotFromV2), their times left as they are: v1
// clients never read a slot's phases closely, and what schema 3 has that v1 had no place for (retime markers, holds,
// events, who holds gear) stays on a slot whose clip a PATCH leaves as it was.
import type { Command } from './command-types.ts'
import { applyCommands } from './commands.ts'
import { gearFromProp, gearFromV1, holdsFromV1, slotFromV2, slotsFromV1, slotToV2 } from './migrate.ts'
import { DEFAULT_FIST, carryHandle, handSide, jointsOf } from './select.ts'
import type { Character, Gear, Handle, HandPoseRef, Job, Side, Slot } from './types.ts'
import type { V2Adjustment as Adjustment, V2AdjustmentKind as AdjustmentKind, V2Slot, V2Window as Window } from './v2.ts'
import type { GameSpec } from './unit.ts'
import type {
  V1AnimationEntry, V1Character, V1ClipKey, V1ClipScript, V1Garment, V1GarmentSocket, V1PropAttachment, V1PullSocket,
} from './v1.ts'

/** What a v1 PATCH may carry (any other key is refused by server/compat.ts). */
export interface V1Patch {
  animations?: V1AnimationEntry[]
  scripts?: V1ClipScript[]
  garments?: V1Garment[]
  props?: V1PropAttachment[]
}

const SIDES: Side[] = ['Left', 'Right']

/** What v1 called garments: all gear but the catalog's. */
const isGarment = (g: Gear): boolean => g.catalog === undefined
/** What v1 called props: catalog gear still placed in the old grip frame (once the gear area has converted it, it
 * has no v1 form and v1 clients neither see nor change it). */
const isProp = (g: Gear): boolean => g.catalog !== undefined && g.attach.kind === 'bone' && g.attach.legacyFrame === 'grip'

/** A hand pose as v1 wrote it (undefined: the default fist). */
function poseToV1 (ref: HandPoseRef | undefined): string | undefined {
  if (ref === undefined || ref === 'default') return undefined
  if (ref === 'clip') return 'open'
  return 'pose' in ref ? `pose:${ref.pose}` : ref.fist
}

/** A character's slots in schema 2's shape (the v1 view reads them so). */
type Viewed = Omit<Character, 'clips'> & { clips: V2Slot[] }
const viewed = (c: Character): Viewed => ({ ...c, clips: c.clips.map(s => slotToV2(s)) })

/** Per slot name, the windows `pick` finds in its enabled adjustments. */
function windowsBySlot (c: Viewed, pick: (a: Adjustment) => Window[] | undefined): Record<string, Window[]> {
  const out: Record<string, Window[]> = {}
  for (const s of c.clips) {
    for (const a of s.adjustments) {
      const w = a.enabled ? pick(a) : undefined
      if (w !== undefined && w.length > 0) (out[s.name] ??= []).push(...w)
    }
  }
  return out
}

const enabled = <K extends AdjustmentKind>(s: V2Slot, kind: K): Extract<Adjustment, { kind: K }> | undefined =>
  s.adjustments.find((a): a is Extract<Adjustment, { kind: K }> => a.kind === kind && a.enabled)

// ---- the v1 view ------------------------------------------------------------------------------------------------

/** The character as a v1 client reads it. A copy: changing it changes nothing. (`units` is in the signature
 * server/compat.ts calls; nothing in a v1 file came from them.) `job`: the character's queued or running job, if
 * any, whose state v1 kept in `status` (see statusOf). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function toV1 (character: Character, units?: GameSpec, job?: Pick<Job, 'kind' | 'status'> | null): V1Character {
  const c = viewed(character)
  const s = c.skeleton
  const placed = s.detected !== undefined || Object.keys(s.overrides).length > 0
  const view: V1Character = {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    source: { file: c.source.file, originalName: c.source.originalName, bytes: c.source.bytes },
    status: statusOf(character, job),
    // (v1 said 'mesh' of a rigged import converted onto the Rigsmith rig)
    kind: s.converted === true ? 'mesh' : c.source.kind,
    rigPreset: c.source.rigPreset,
    stats: c.source.stats,
    joints: placed ? jointsOf(c) : undefined,
    autoJoints: s.imported ?? s.detected,
    jointsEdited: Object.keys(s.overrides).length > 0,
    scale: c.source.scale,
    markers: s.markers,
    fingers: s.fingerLevel,
    template: s.template,
    boneMap: s.boneMap,
    files: c.files,
    revision: c.revision,
    thumbVersion: c.thumbVersion,
    rigReport: c.skin.report === undefined
      ? { method: 'import', seconds: 0, warnings: c.source.warnings }
      : { method: c.skin.report.method, seconds: c.skin.report.seconds, warnings: c.skin.report.warnings },
    texture: textureOf(character),
    animations: c.clips.map(slot => entryOf(c, slot)),
    scripts: scriptsOf(c),
    handPoses: c.hands.poses,
    props: c.gear.filter(isProp).map(propOf),
    garments: c.gear.filter(isGarment).map(g => garmentOf(c, g)),
    mount: c.mount,
    skins: c.look.skins,
    error: c.error,
  }
  return JSON.parse(JSON.stringify(view)) as V1Character
}

/** What v1 said in `status`: v1 wrote a job's state there from the moment it was queued ('importing', 'rigging')
 * and 'error' when one failed, and its clients wait on it (import_new_units.py polls for 'rigged' after asking for a
 * rig). Schema 2 keeps `status` for the lifecycle and a failure in `error` alone (a failed re-rig leaves the old rig
 * 'rigged'), so the view lays the job over it. */
function statusOf (c: Character, job: Pick<Job, 'kind' | 'status'> | null | undefined): V1Character['status'] {
  const active = job !== undefined && job !== null && (job.status === 'queued' || job.status === 'running') ? job : null
  if (active?.kind === 'inspect' || active?.kind === 'reimport') return 'importing'
  if (active?.kind === 'rig') return 'rigging'
  if (active === null && (c.error ?? '') !== '') return 'error'
  return c.status
}

function entryOf (c: Viewed, s: V2Slot): V1AnimationEntry {
  const ground = enabled(s, 'ground')
  const keys = enabled(s, 'keys')
  const props: Record<string, V1ClipKey[]> = {}
  for (const [id, k] of Object.entries(keys?.gear ?? {})) {
    const g = c.gear.find(x => x.id === id)
    if (g !== undefined) props[g.name] ??= k
  }
  const bones = keys?.bones !== undefined && Object.keys(keys.bones).length > 0 ? keys.bones : undefined
  const hasProps = Object.keys(props).length > 0
  return {
    clipId: s.clip.id,
    url: s.clip.url,
    name: s.name,
    inPlace: s.inPlace,
    loop: s.loop,
    speed: s.speed,
    note: s.note,
    keys: bones !== undefined || hasProps ? { bones, props: hasProps ? props : undefined } : undefined,
    lift: ground !== undefined && ground.lift !== 0 ? ground.lift : undefined,
  }
}

function scriptsOf (c: Viewed): V1ClipScript[] {
  const out: V1ClipScript[] = []
  for (const side of SIDES) {
    const hold = c.hands.hold?.[side]
    if (hold === undefined) continue
    const open = windowsBySlot(c, a => a.kind === 'handPose' && a.hand === side && a.gear === undefined && a.pose === 'clip' ? a.windows : undefined)
    out.push({
      id: `hold-${side.toLowerCase()}`, kind: 'grip', enabled: true, side, clip: poseToV1(hold) ?? DEFAULT_FIST,
      open: Object.keys(open).length > 0 ? open : undefined,
    })
  }
  const names = new Map(c.clips.map(s => [s.id, s.name]))
  for (const s of c.clips) {
    for (const a of s.adjustments) {
      if (a.kind === 'blowTiming') {
        out.push({ id: a.id, kind: 'blow', enabled: a.enabled, note: a.note, clip: s.name, at: a.at, blowU: a.blowU, late: a.late, hand: a.hand, window: a.window })
      } else if (a.kind === 'pace' && names.has(a.like)) {
        out.push({ id: a.id, kind: 'pace', enabled: a.enabled, note: a.note, clip: s.name, like: names.get(a.like)! })
      }
    }
  }
  return out
}

function garmentOf (c: Viewed, g: Gear): V1Garment {
  const a = g.attach
  const carry = carryHandle(g)
  const sockets: V1GarmentSocket[] = []
  if (carry?.hand !== undefined && carry.place !== undefined) {
    sockets.push({ id: `${carry.hand.toLowerCase()}-hand`, name: `${carry.hand} hand`, position: carry.place.position, rotation: carry.place.rotation, placed: carry.exact })
  }
  for (const h of g.handles) {
    if (h.kind === 'grip' && h.place !== undefined) sockets.push({ id: h.id, name: h.name, position: h.place.position, rotation: h.place.rotation, placed: h.exact })
  }
  const pulls: V1PullSocket[] = g.handles.flatMap(h => h.kind !== 'pull' || h.pull === undefined ? [] : [{
    id: h.id,
    name: h.name,
    bone: h.pull.bone,
    grip: h.pull.grip,
    rest: h.pull.rest,
    holds: windowsBySlot(c, x => x.kind === 'handleHold' && x.gear === g.id && x.handle === h.id ? x.windows : undefined),
    pose: poseToV1(h.pose),
  }])
  const carryOpen = carry === undefined
    ? {}
    : windowsBySlot(c, x => x.kind === 'handPose' && x.gear === g.id && x.hand === carry.hand && x.pose === 'clip' ? x.windows : undefined)
  return {
    id: g.id,
    name: g.name,
    file: g.model,
    status: g.status,
    error: g.error,
    mode: a.kind === 'bone' ? 'rigid' : a.kind === 'skin' ? 'clothing' : 'part',
    policy: a.kind === 'skin' ? a.policy : 'body',
    // (v1 kept a bone on every garment: 'Head' on those that rode none)
    bone: a.kind === 'bone' ? a.bone : 'Head',
    position: a.place.position,
    rotation: a.place.rotation,
    scale: a.place.scale,
    hideBody: a.kind === 'skin' && a.hideBody === true,
    hidden: g.hidden === true,
    from: g.from,
    sockets: sockets.length > 0 ? sockets : undefined,
    group: g.swapSet,
    anchor: a.kind === 'spot' ? a.anchor : undefined,
    painted: g.painted,
    animation: a.kind === 'spot' ? a.animation : undefined,
    pulls: pulls.length > 0 ? pulls : undefined,
    carryPose: carry === undefined ? undefined : poseToV1(carry.pose),
    carryOpen: Object.keys(carryOpen).length > 0 ? carryOpen : undefined,
  }
}

function propOf (g: Gear): V1PropAttachment {
  const a = g.attach as Extract<Gear['attach'], { kind: 'bone' }>
  return { id: g.id, ref: `catalog:${g.catalog!}`, name: g.name, socket: a.bone, position: a.place.position, rotation: a.place.rotation, scale: a.place.scale }
}

function textureOf (c: Character): V1Character['texture'] {
  const l = c.look
  if (l.scan === undefined && l.layers.length === 0 && l.at === undefined) return undefined
  const shown = new Set(l.layers.filter(x => x.enabled).map(x => x.image))
  return {
    filled: l.layers.some(x => x.kind === 'fill' && x.enabled),
    images: (l.scan?.images ?? []).map(i => ({ image: i.image, coverage: i.coverage, file: shown.has(i.image) ? `${i.image}.png` : null })),
    at: l.at ?? l.scan?.at ?? 0,
    painted: l.layers.some(x => x.kind !== 'fill' && x.enabled),
  }
}

// ---- v1 PATCH as commands ---------------------------------------------------------------------------------------

/**
 * A v1 PATCH of whole fields as commands on `c` (one batch): garments and props diffed by id into gear commands,
 * scripts' grips into hands.hold, and the animations with the scripts and the garments' windows into one
 * clips.replace. Slots keep their ids by name, adjustments theirs by what they are; what the v1 view can't show of a
 * slot (switched off, a named hand pose, a whole-clip hand) stays while its clip does. Throws the reducers'
 * CommandError when the result would be refused.
 */
export function v1PatchToCommands (c: Character, patch: V1Patch, newId: () => string): Command[] {
  const out: Command[] = []
  // (each command is applied as it is made, so the next is made against what the batch will have by then)
  let work = c
  const run = (cmd: Command): void => {
    work = applyCommands(work, [cmd]).character
    out.push(cmd)
  }
  const poses = new Set(c.hands.poses.map(p => p.id))

  const now = (gid: string): Gear => work.gear.find(g => g.id === gid)!
  const syncHandles = (n: Gear): void => {
    for (const h of now(n.id).handles) {
      if (h.kind !== 'carry' && !n.handles.some(x => x.id === h.id && x.kind === h.kind)) run({ type: 'gear.handle.remove', gear: n.id, id: h.id })
    }
    for (const h of n.handles) {
      const old = h.kind === 'carry' ? carryHandle(now(n.id)) : now(n.id).handles.find(x => x.id === h.id)
      // (v1 kept a garment's sockets and pulls whatever its mode; off a bone a piece has none)
      if (old === undefined && now(n.id).attach.kind !== 'bone') continue
      if (old === undefined) { run({ type: 'gear.handle.add', gear: n.id, handle: h }); continue }
      const changed = handlePatch(old, h)
      if (changed !== null) run({ type: 'gear.handle.update', gear: n.id, id: old.id, patch: changed })
    }
  }
  // garments: everything v1 said of them; props: their name and placement (v1 gave them no handles, no switches)
  const syncGear = (have: Gear[], next: Gear[], props: boolean): void => {
    for (const g of have) if (!next.some(n => n.id === g.id)) run({ type: 'gear.remove', id: g.id })
    for (const n of next) {
      const was = work.gear.find(g => g.id === n.id)
      if (was !== undefined && was.catalog !== n.catalog) run({ type: 'gear.remove', id: n.id })
      if (was === undefined || was.catalog !== n.catalog) { run({ type: 'gear.add', gear: n }); continue }
      const changed: Extract<Command, { type: 'gear.update' }>['patch'] = {}
      if (n.name !== was.name) changed.name = n.name
      if (!props) {
        if ((n.hidden === true) !== (was.hidden === true)) changed.hidden = n.hidden === true
        if ((n.swapSet ?? null) !== (was.swapSet ?? null)) changed.swapSet = n.swapSet ?? null
        if (n.model !== undefined && n.model !== was.model) changed.model = n.model
      }
      // (the reducer takes `from` before a rename: with it a piece leaves the game's hands and can be renamed; a v1
      // client marking a piece as the game's names it in the same PATCH, so that rename goes first)
      const from = (n.from ?? null) !== (was.from ?? null)
      const fromGame = was.from?.startsWith('emberhold:') === true
      if (from && fromGame) changed.from = n.from ?? null
      if (Object.keys(changed).length > 0) run({ type: 'gear.update', id: n.id, patch: changed })
      if (from && !fromGame) run({ type: 'gear.update', id: n.id, patch: { from: n.from ?? null } })
      // (a place in the old grip frame goes through attach: gear.place would take it as rest space)
      const grip = n.attach.kind === 'bone' && n.attach.legacyFrame !== undefined
      if (!equal({ ...was.attach, place: undefined }, { ...n.attach, place: undefined }) || (grip && !equal(was.attach.place, n.attach.place))) {
        run({ type: 'gear.attach', id: n.id, attach: n.attach })
      } else if (!equal(was.attach.place, n.attach.place)) run({ type: 'gear.place', id: n.id, place: n.attach.place })
      if (!props) syncHandles(n)
      else {
        // (a carry handle this PATCH made, by moving it onto a hand: v1 never closed a hand round a catalog prop)
        const carry = carryHandle(now(n.id))
        if (carry !== undefined && carryHandle(was) === undefined) run({ type: 'gear.handle.update', gear: n.id, id: carry.id, patch: { pose: 'clip' } })
      }
    }
  }
  if (patch.garments !== undefined) syncGear(work.gear.filter(isGarment), patch.garments.map(g => gearFromV1(g, { poses })), false)
  if (patch.props !== undefined) syncGear(work.gear.filter(isProp), patch.props.flatMap(p => gearFromProp(p) ?? []), true)

  const before = work
  if (patch.scripts !== undefined) {
    const hold = holdsFromV1(patch.scripts, { poses })
    for (const side of SIDES) {
      if (!equal(hold[side], work.hands.hold?.[side])) run({ type: 'hands.hold', side, pose: hold[side] ?? null })
    }
  }
  if (patch.animations !== undefined || patch.scripts !== undefined || patch.garments !== undefined) {
    const v = toV1(before)
    // (keys name gear: garments first, as v1 found them, then the catalog's)
    const gearIdByName: Record<string, string> = {}
    for (const g of [...before.gear.filter(isGarment), ...before.gear.filter(g => !isGarment(g))]) gearIdByName[g.name] ??= g.id
    // (a pull the piece doesn't have, being off the bones, holds nothing)
    const garments = (patch.garments ?? v.garments)?.map(g => {
      const pulls = g.pulls?.filter(p => before.gear.find(x => x.id === g.id)?.handles.some(h => h.id === p.id && h.kind === 'pull') === true)
      return pulls?.length === g.pulls?.length ? g : { ...g, pulls }
    })
    const next = slotsFromV1(patch.animations ?? v.animations, patch.scripts ?? v.scripts, gearIdByName, c.id, { poses, garments })
    const slots = keepIds(viewed(before), next, newId).map((s, i) => carried(before, slotFromV2(s, { characterId: c.id, index: i })))
    if (!equal(slots, work.clips)) run({ type: 'clips.replace', slots })
  }
  return out
}

/** The fields of a handle v1 could say, changed (null clears one, as in JSON). A grip's hand v1 only told by its
 * name: unknown there is no change; a pull's hand is its bone's. Null: none changed. */
function handlePatch (old: Handle, h: Handle): Partial<Omit<Handle, 'id' | 'kind'>> | null {
  const fields: Array<keyof Omit<Handle, 'id' | 'kind'>> = h.kind === 'carry'
    ? ['pose', 'place', 'exact']
    : h.kind === 'grip' ? ['name', 'place', 'exact', ...(h.hand === undefined ? [] : ['hand' as const])] : ['name', 'pull', 'pose']
  const patch: Record<string, unknown> = {}
  for (const f of fields) {
    const was = f === 'pose' && h.kind === 'carry' ? old.pose ?? 'default' : old[f]
    if (!equal(was, h[f])) patch[f] = h[f] ?? null
  }
  return Object.keys(patch).length > 0 ? patch as Partial<Omit<Handle, 'id' | 'kind'>> : null
}

/** Slots made from v1 (stable ids) with the ids of what they stand for in `c`: a slot of the same name keeps its
 * id, an adjustment of the same kind (hand, gear, handle) keeps its; new ones get newId(). What the v1 view can't
 * show of a slot stays while its clip is the same and nothing from v1 takes its place. */
function keepIds (c: Viewed, next: V2Slot[], newId: () => string): V2Slot[] {
  const ids = new Map<string, string>()
  const out = next.map(s => {
    const old = c.clips.find(x => x.name === s.name)
    const id = old?.id ?? newId()
    ids.set(s.id, id)
    const pool = (old?.adjustments ?? []).filter(a => shownInV1(c, a))
    const adjustments: Adjustment[] = s.adjustments.map(a => {
      const i = pool.findIndex(b => identity(b) === identity(a))
      return { ...a, id: i >= 0 ? pool.splice(i, 1)[0].id : newId() }
    })
    if (old !== undefined && old.clip.id === s.clip.id && old.clip.url === s.clip.url) {
      for (const b of old.adjustments) if (!shownInV1(c, b) && !adjustments.some(a => clash(a, b))) adjustments.push({ ...b })
    }
    const rank = new Map((old?.adjustments ?? []).map((b, i) => [b.id, i]))
    adjustments.sort((a, b) => ((rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)) || 0)
    return { ...s, id, adjustments }
  })
  for (const s of out) for (const a of s.adjustments) if (a.kind === 'pace') a.like = ids.get(a.like) ?? a.like
  return out
}

/** A slot back from v1 with what v1 has no place for (retime markers, holds, events but the hit, who holds gear and
 * when it shows, the tracks switched off) from the slot it stands for, while that one plays the same clip. */
function carried (c: Character, s: Slot): Slot {
  const old = c.clips.find(x => x.id === s.id)
  if (old === undefined || old.clip.id !== s.clip.id || old.clip.url !== s.clip.url) return s
  const out: Slot = { ...s }
  const markers = old.time?.markers; const holds = old.time?.holds
  if (markers !== undefined || holds !== undefined) out.time = { ...out.time, ...(markers !== undefined ? { markers } : {}), ...(holds !== undefined ? { holds } : {}) }
  const events = (old.events ?? []).filter(e => !(e.name === 'hit' && e.to === undefined))
  if (events.length > 0) out.events = [...(out.events ?? []), ...events].sort((a, b) => a.u - b.u)
  for (const [g, t] of Object.entries(old.gear ?? {})) {
    if (t.heldBy === undefined && t.shown === undefined) continue
    out.gear = { ...out.gear, [g]: { ...out.gear?.[g], ...(t.heldBy !== undefined ? { heldBy: t.heldBy } : {}), ...(t.shown !== undefined ? { shown: t.shown } : {}) } }
  }
  if (old.muted !== undefined && out.muted === undefined) out.muted = old.muted
  return out
}

/** Whether the v1 view shows this adjustment (so a v1 PATCH that leaves it out means to take it out). */
function shownInV1 (c: Viewed, a: Adjustment): boolean {
  switch (a.kind) {
    case 'ground': return a.enabled && a.lift !== 0
    case 'keys': return a.enabled
    case 'blowTiming': return true
    case 'pace': return c.clips.some(s => s.id === a.like)
    case 'handleHold': {
      const g = c.gear.find(x => x.id === a.gear)
      const h = g !== undefined && isGarment(g) ? g.handles.find(x => x.id === a.handle) : undefined
      return a.enabled && a.windows.length > 0 && h?.kind === 'pull' && h.pull !== undefined
    }
    case 'handPose': {
      if (!a.enabled || a.pose !== 'clip' || (a.windows?.length ?? 0) === 0) return false
      if (a.gear === undefined) return c.hands.hold?.[a.hand] !== undefined
      const g = c.gear.find(x => x.id === a.gear)
      return g !== undefined && isGarment(g) && g.attach.kind === 'bone' && handSide(g.attach.bone) === a.hand
    }
  }
}

/** What an adjustment is for: two with the same identity are the same adjustment in two versions. */
function identity (a: Adjustment): string {
  if (a.kind === 'handPose') return `handPose:${a.hand}:${a.gear ?? ''}`
  if (a.kind === 'handleHold') return `handleHold:${a.gear}:${a.handle}`
  return a.kind
}

/** Whether two adjustments can't both be on a slot (commands' cardinality rules). */
function clash (a: Adjustment, b: Adjustment): boolean {
  if (a.kind === 'handleHold' && b.kind === 'handleHold') return a.gear === b.gear && a.handle === b.handle
  if (a.kind === 'handPose' && b.kind === 'handPose') {
    return a.hand === b.hand && (a.windows === undefined || b.windows === undefined ||
      a.windows.some(x => b.windows!.some(y => x[0] < y[1] && y[0] < x[1])))
  }
  return a.kind === b.kind && a.kind !== 'handleHold' && a.kind !== 'handPose'
}

/** Deep equality of JSON values, a key whose value is undefined counting as absent. */
function equal (a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = Object.keys(x).filter(k => x[k] !== undefined)
  return keys.length === Object.keys(y).filter(k => y[k] !== undefined).length && keys.every(k => equal(x[k], y[k]))
}
