// The Ship step's checks: the game's rules for a unit (src/engine/contract.ts) that can be told without exporting it,
// each passed or failed in words, so a unit is fixed before its export stops on it. What only the export can measure
// (a clip's feet and hips, the budget after the gear's own triangles) is said as such. Pure: a unit's entry (with the
// game's defaults under it) and its characters in, the list out.
import { hierarchyOf, phaseOf, safeName, slotByName } from '../model/select.ts'
import type { Adjustment, Character, Gear } from '../model/types.ts'
import type { UnitSpec } from '../model/unit.ts'
import { DEFAULT_LODS, gearLeftOut, HIT_AT, meshNameOf, STANDS, STEPS } from './contract.ts'

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'info'

export interface Check {
  /** Which rule (stable, for keys and tests). */
  rule: string
  status: CheckStatus
  text: string
}

export interface UnitCheckInput {
  unit: string
  /** The unit's entry with the game's defaults under it. */
  spec: UnitSpec
  /** Its character (null: gone). */
  character: Character | null
  /** Its companion's character, when it has one (null: gone). */
  companion?: Character | null
}

/** Why a piece of gear stays out of the unit, as the export decides it, or null when it goes in. */
export function leftOut (g: Gear): string | null {
  return gearLeftOut(g) ?? (g.model === undefined ? 'no model of its own'
    : g.attach.kind === 'bone' && g.attach.legacyFrame !== undefined ? 'still placed in the old catalog frame (place it in Gear)' : null)
}

/** The gear ids the unit's clips key (their enabled keys adjustments): each gets a Prop_ bone of its own. */
export function keyedGear (c: Character, clips: string[]): Set<string> {
  const out = new Set<string>()
  for (const name of clips) {
    const slot = slotByName(c, name)
    for (const a of slot?.adjustments ?? []) if (a.enabled && a.kind === 'keys') for (const id of Object.keys(a.gear ?? {})) out.add(id)
  }
  return out
}

/** The bones the export adds for gear, by name: Prop_<gear> for a keyed piece on a bone, Prop_<gear>_<handle> for each
 * pull handle of a piece on a bone, with the piece each is for. */
export function gearBones (c: Character, clips: string[]): Array<{ bone: string, gear: Gear }> {
  const keyed = keyedGear(c, clips)
  const out: Array<{ bone: string, gear: Gear }> = []
  for (const g of c.gear) {
    if (leftOut(g) !== null || g.attach.kind !== 'bone') continue
    if (keyed.has(g.id)) out.push({ bone: `Prop_${safeName(g.name)}`, gear: g })
    for (const h of g.handles) if (h.kind === 'pull' && h.pull !== undefined) out.push({ bone: `Prop_${safeName(g.name)}_${safeName(h.name)}`, gear: g })
  }
  return out
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const list = (names: string[]): string => names.join(', ')

/** Every check of a unit, in order: the character, its sizes, its clips, its gear, its companion and seat. */
export function unitChecks (i: UnitCheckInput): Check[] {
  const out: Check[] = []
  const add = (rule: string, status: CheckStatus, text: string): void => { out.push({ rule, status, text }) }
  const { spec, unit } = i
  const c = i.character

  // its character, rigged for the skeleton it has now
  if (c === null) {
    add('character', 'fail', `Its character ${spec.character} is gone`)
    return out
  }
  const phase = phaseOf(c)
  if (phase.phase !== 'rigged' || c.files.rigged === undefined) add('rigged', 'fail', `${c.name} isn't rigged (${phase.label.toLowerCase()}): rig it in Skin`)
  else add('rigged', 'pass', `${c.name} is rigged`)

  // sizes
  if (typeof spec.height === 'number' && spec.height > 0) add('height', 'pass', `${spec.height} tall in the game`)
  else add('height', 'fail', 'Its height must be above 0')
  const tris = c.source.stats?.triangles
  if (typeof spec.budget !== 'number' || !(spec.budget > 0)) add('budget', 'fail', 'Its triangle budget must be above 0')
  else if (tris !== undefined && tris > spec.budget) add('budget', 'info', `The body's ${tris.toLocaleString('en')} triangles are simplified to fit ${spec.budget.toLocaleString('en')}, less what its gear takes`)
  else add('budget', 'pass', `${tris !== undefined ? `${tris.toLocaleString('en')} triangles, ` : ''}within its budget of ${spec.budget.toLocaleString('en')} (its gear counts too)`)
  const lods = spec.lods ?? DEFAULT_LODS
  if (!Array.isArray(lods) || !lods.every(r => typeof r === 'number' && r > 0 && r < 1) || lods.some((r, k) => k > 0 && r >= lods[k - 1])) {
    add('lods', 'fail', 'Its levels must be shares of LOD0 between 0 and 1, each smaller than the one before')
  } else {
    add('lods', 'pass', lods.length === 0 ? 'No levels of detail' : `Levels ${lods.map((r, k) => `${unit}_LOD${k + 1} at ${Math.round(r * 100)} %`).join(', ')}`)
  }

  // clips: each a slot of the character
  const clips = Array.isArray(spec.clips) ? spec.clips : []
  const missing = clips.filter(n => slotByName(c, n) === undefined)
  const twice = clips.filter((n, k) => clips.indexOf(n) !== k)
  if (twice.length > 0) add('clips', 'fail', `Listed twice: ${list([...new Set(twice)])}`)
  if (missing.length > 0) add('clips', 'fail', `No slot named ${list(missing)}: fill ${missing.length === 1 ? 'it' : 'them'} in Motion (the export stops on ${missing.length === 1 ? 'it' : 'them'})`)
  else if (clips.length === 0) add('clips', 'warn', 'It plays no clips')
  else if (twice.length === 0) add('clips', 'pass', `Plays ${list(clips)}`)
  const ridden = spec.companion?.ridden === true
  const steps = clips.filter(n => STEPS.has(n)); const stands = clips.filter(n => STANDS.has(n))
  if (!ridden && (steps.length > 0 || stands.length > 0)) {
    add('motion', 'info', `Checked when exported: ${[steps.length > 0 ? `${list(steps)} must step` : '', stands.length > 0 ? `${list(stands)} must stand` : ''].filter(Boolean).join('; ')}`)
  }
  const attack = slotByName(c, 'Attack')
  if (clips.includes('Attack') && attack !== undefined && !attack.adjustments.some((a: Adjustment) => a.enabled && a.kind === 'blowTiming')) {
    add('blow', 'warn', `Attack has no blow timing: the game lands each hit at ${Math.round(HIT_AT * 100)} % of the clip`)
  }

  // gear: what goes in, under the names the game knows
  const inGear = c.gear.filter(g => leftOut(g) === null)
  for (const g of c.gear) {
    const why = leftOut(g)
    if (why !== null && why !== 'hidden') add('gear', 'warn', `${g.name} is left out: ${why}`)
  }
  if (inGear.length > 0) add('gear', 'pass', `${plural(inGear.length, 'piece')} of gear go${inGear.length === 1 ? 'es' : ''} in: ${list(inGear.map(meshNameOf))}`)
  const bones = new Set([...hierarchyOf(c).map(([b]) => b), ...Object.keys(c.skin.rigJoints ?? {})])
  for (const g of inGear) {
    const mesh = meshNameOf(g)
    if (mesh !== g.name) add('gear-name', 'warn', `${g.name} goes in as ${mesh}, the game's name for it`)
    const weapon = /^Weapons_(.+)$/.exec(mesh)
    if (weapon !== null && (g.attach.kind !== 'bone' || g.attach.bone !== weapon[1])) {
      add('weapons', 'fail', `${mesh} ${g.attach.kind === 'bone' ? `rides ${g.attach.bone}` : 'is not on a bone'}: the game hangs it from ${weapon[1]}`)
    }
    if (g.attach.kind === 'bone' && !bones.has(g.attach.bone)) add('gear-bone', 'fail', `${g.name} rides ${g.attach.bone}, which its skeleton has no longer`)
    for (const h of g.handles) {
      if (h.kind === 'pull' && h.pull !== undefined && !bones.has(h.pull.bone)) add('gear-bone', 'fail', `${g.name}'s ${h.name} is drawn by ${h.pull.bone}, which its skeleton has no longer`)
    }
  }
  const meshes = new Map<string, string[]>()
  for (const g of inGear) meshes.set(meshNameOf(g), [...(meshes.get(meshNameOf(g)) ?? []), g.name])
  for (const [mesh, of] of meshes) {
    if (of.length > 1) add('mesh-names', 'fail', `${list(of)} would all be meshes named ${mesh}: rename one`)
    if (mesh === unit) add('mesh-names', 'fail', `${of[0]} would be named ${unit}, the body's name`)
  }
  const extra = gearBones(c, clips)
  const taken = new Map<string, string>([...bones, 'root'].map(b => [b, 'a bone of the skeleton']))
  let clash = false
  for (const { bone, gear } of extra) {
    const was = taken.get(bone)
    if (was !== undefined) { add('bone-names', 'fail', `Two bones would be named ${bone} (${gear.name}'s and ${was}): rename one`); clash = true }
    taken.set(bone, `${gear.name}'s`)
  }
  if (extra.length > 0 && !clash) add('bone-names', 'pass', `Gear bones: ${list(extra.map(x => x.bone))}`)

  // the companion, and his seat when he rides it
  const comp = spec.companion
  if (comp !== undefined) {
    const h = i.companion ?? null
    if (h === null) add('companion', 'fail', `Its companion ${comp.character} is gone`)
    else {
      const hp = phaseOf(h)
      if (hp.phase !== 'rigged') add('companion', 'fail', `${h.name} isn't rigged (${hp.label.toLowerCase()})`)
      else if (!(comp.height > 0)) add('companion', 'fail', `${h.name}'s height must be above 0`)
      else add('companion', 'pass', `${ridden ? 'Rides' : 'Leads'} ${h.name}, ${comp.height} tall`)
    }
  }
  const m = c.mount
  if (ridden) {
    if (m === undefined) add('mount', 'fail', `Rides ${i.companion?.name ?? comp!.character} in the game but has no seat here: pick it under Mount`)
    else if (m.character !== comp!.character) add('mount', 'fail', `Sits on ${m.character} here but the unit's companion is ${comp!.character}: pick the same horse`)
    else {
      const horseBones = i.companion != null ? new Set(hierarchyOf(i.companion).map(([b]) => b)) : null
      if (horseBones !== null && !horseBones.has(m.bone)) add('mount', 'fail', `Sits on ${m.bone}, which ${i.companion!.name} has no longer`)
      else add('mount', 'pass', `Sits on ${i.companion?.name ?? m.character}'s ${m.bone}${m.freeze.length > 0 ? `, ${plural(m.freeze.length, 'bone')} held` : ''}`)
      const skins = i.companion?.look.skins ?? []
      if (m.skin !== undefined && i.companion != null && !skins.some(s => s.name === m.skin)) add('mount-skin', 'warn', `${i.companion.name} has no skin ${m.skin}: it wears its own`)
    }
  } else if (m !== undefined) {
    add('mount', 'info', `Rides ${m.character} here, but the unit doesn't ride: the game gets him on foot`)
  }
  if (m !== undefined && (m.gear ?? []).length > 0) add('mount-gear', 'info', `The horse's gear (${plural(m.gear!.length, 'piece')}) isn't exported: the game has never had it`)

  if (spec.draft === true) add('draft', 'info', "A draft: the game's build skips it unless it is named (Export names it, and it stops being a draft)")
  return out
}

/** The checks that stop an export. */
export const failing = (checks: Check[]): Check[] => checks.filter(x => x.status === 'fail')
