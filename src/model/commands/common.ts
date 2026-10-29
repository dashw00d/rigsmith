// What every section's reducer shares: the error a command fails with, the checks of what a command carries (written
// by hand: the model has no schema library), and the words its changes are told in (the journal's lines).
import { stableJson } from '../entities.ts'
import { hierarchyOf } from '../skeletons.ts'
import { EASES, MAX_U, type Character, type ClipKey, type ClipRef, type HandPoseRef, type Placement, type Quat, type Side, type Vec3, type Window } from '../types.ts'

/** 400: the command is malformed or asks for something impossible; 404: it names something that isn't there; 409:
 * it clashes with the character as it is now (a name taken, a lock, a rule a later change would break). */
export class CommandError extends Error {
  status: 400 | 404 | 409
  constructor (status: 400 | 404 | 409, message: string) {
    super(message)
    this.name = 'CommandError'
    this.status = status
  }
}

export const bad = (message: string): never => { throw new CommandError(400, message) }
export const missing = (message: string): never => { throw new CommandError(404, message) }
export const conflict = (message: string): never => { throw new CommandError(409, message) }

/** A command whose type its section doesn't know. */
export const unknown = (cmd: { type: string }): never => bad(`Unknown command ${cmd.type}`)

export const same = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b)

// ---- checks: each returns a clean copy of what it was given (keys it doesn't know left out), or throws a 400 ------

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export const obj = (v: unknown, what: string): Obj => (isObj(v) ? v : bad(`${what} must be an object`))
export const str = (v: unknown, what: string): string => (typeof v === 'string' && v !== '' ? v : bad(`${what} must be text`))
export const bool = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : bad(`${what} must be true or false`))

/** A name: trimmed, not empty. */
export function name (v: unknown, what: string): string {
  const s = typeof v === 'string' ? v.trim() : ''
  return s !== '' ? s : bad(`${what} must be a name`)
}

/** An id: letters, digits, _ and - (gear ids are folder names too). */
export function id (v: unknown, what: string): string {
  return typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : bad(`${what} must be an id (letters, digits, _ and -)`)
}

export function num (v: unknown, what: string, range: { min?: number, max?: number, above?: number } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return bad(`${what} must be a number`)
  if (range.min !== undefined && v < range.min) return bad(`${what} must be at least ${range.min}`)
  if (range.max !== undefined && v > range.max) return bad(`${what} must be at most ${range.max}`)
  if (range.above !== undefined && !(v > range.above)) return bad(`${what} must be above ${range.above}`)
  return v
}

export function oneOf<T extends string> (v: unknown, values: readonly T[], what: string): T {
  return values.includes(v as T) ? v as T : bad(`${what} must be one of ${values.join(', ')}`)
}

export function list<T> (v: unknown, what: string, each: (x: unknown, what: string) => T): T[] {
  return Array.isArray(v) ? v.map((x, i) => each(x, `${what}[${i}]`)) : bad(`${what} must be a list`)
}

export function record<T> (v: unknown, what: string, each: (x: unknown, what: string) => T): Record<string, T> {
  const o = obj(v, what)
  const out: Record<string, T> = {}
  for (const [k, x] of Object.entries(o)) if (x !== undefined) out[k] = each(x, `${what}.${k}`)
  return out
}

/** An optional field: undefined, and null (what JSON says for "unset"), read as not given. */
export function opt<T> (v: unknown, read: (v: unknown) => T): T | undefined {
  return v === undefined || v === null ? undefined : read(v)
}

/** A note: text, or nothing when empty (or null). */
export function note (v: unknown, what: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  return typeof v === 'string' ? v : bad(`${what} must be text`)
}

/** A patch's keys must all be ones it may change. */
export function patchOf (v: unknown, allowed: readonly string[], what = 'patch'): Obj {
  const p = obj(v, what)
  for (const k of Object.keys(p)) if (!allowed.includes(k)) bad(`${what} can't change ${k} (only ${allowed.join(', ')})`)
  return p
}

function numbers (v: unknown, n: number, what: string): number[] {
  if (!Array.isArray(v) || v.length !== n || !v.every(x => typeof x === 'number' && Number.isFinite(x))) return bad(`${what} must be ${n} numbers`)
  return [...v] as number[]
}
export const vec3 = (v: unknown, what: string): Vec3 => numbers(v, 3, what) as Vec3
export const quat = (v: unknown, what: string): Quat => numbers(v, 4, what) as Quat
export const side = (v: unknown, what: string): Side => oneOf(v, ['Left', 'Right'] as const, what)

export function placement (v: unknown, what: string): Placement {
  const p = obj(v, what)
  return { position: vec3(p.position, `${what}.position`), rotation: vec3(p.rotation, `${what}.rotation`), scale: num(p.scale, `${what}.scale`, { above: 0 }) }
}

export function clipRef (v: unknown, what: string): ClipRef {
  const r = obj(v, what)
  const url = opt(r.url, x => str(x, `${what}.url`))
  return { id: str(r.id, `${what}.id`), ...(url !== undefined ? { url } : {}) }
}

export function handPoseRef (v: unknown, what: string): HandPoseRef {
  if (v === 'default' || v === 'clip') return v
  if (isObj(v) && Object.keys(v).length === 1) {
    if ('pose' in v) return { pose: id(v.pose, `${what}.pose`) }
    if ('fist' in v) return { fist: str(v.fist, `${what}.fist`) }
  }
  return bad(`${what} must be 'default', 'clip', {pose} or {fist}`)
}

/** A moment of a slot's source (types.ts SourceU): 0..MAX_U. */
export const sourceU = (v: unknown, what: string): number => num(v, what, { min: 0, max: MAX_U })

/** Parts of a slot's source, sorted: source time (0..MAX_U), each starting before it ends. */
export function windows (v: unknown, what: string): Window[] {
  return list(v, what, (w, at) => {
    const [a, b] = numbers(w, 2, at)
    if (!(a >= 0 && b <= MAX_U && a < b)) return bad(`${at} must run forward within 0..${MAX_U}`)
    return [a, b] as Window
  }).sort((x, y) => x[0] - y[0])
}

/** Two keys closer than this are at the same moment. */
export const SAME_MOMENT = 1e-6

/** A track's keys: sorted by moment, no two at the same one, each span's ease one of types.ts EASES ('smooth' is left
 * unset, as every key before eases was). */
export function clipKeys (v: unknown, what: string): ClipKey[] {
  const keys = list(v, what, (k, at) => {
    const o = obj(k, at)
    const p = opt(o.p, x => vec3(x, `${at}.p`))
    const ease = opt(o.ease, x => oneOf(x, EASES, `${at}.ease`))
    return { u: sourceU(o.u, `${at}.u`), q: quat(o.q, `${at}.q`), ...(p !== undefined ? { p } : {}), ...(ease !== undefined && ease !== 'smooth' ? { ease } : {}) }
  }).sort((a, b) => a.u - b.u)
  for (let i = 1; i < keys.length; i++) if (keys[i].u - keys[i - 1].u < SAME_MOMENT) bad(`${what}: two keys at the same moment (${pct(keys[i].u)})`)
  return keys
}

/** A bone or joint of the character's skeleton (src/model/skeletons.ts). */
export function joint (c: Character, v: unknown, what: string): string {
  const j = str(v, what)
  return hierarchyOf(c).some(([n]) => n === j) ? j : bad(`${j} isn't a bone of this skeleton`)
}

/** A path under a folder of the character (no way out of it). */
export function under (v: unknown, folder: string, what: string): string {
  const p = str(v, what)
  const parts = p.split('/')
  if (!p.startsWith(folder) || p.includes('\\') || parts.some(x => x === '..' || x === '.' || x === '')) {
    return bad(folder === '' ? `${what} must be a plain relative path` : `${what} must lie under ${folder}`)
  }
  return p
}

export const overlaps = (a: Window, b: Window): boolean => a[0] < b[1] && b[0] < a[1]

export function uniqueName (base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base
  for (let i = 2; ; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`
}

/** Items in the order of `ids` (every id one of theirs, none twice); items it doesn't name keep their order after. */
export function reorder<T extends { id: string }> (items: T[], ids: unknown, what: string): T[] {
  const order = list(ids, 'ids', id)
  if (new Set(order).size !== order.length) bad('ids repeat')
  const byId = new Map(items.map(x => [x.id, x]))
  for (const i of order) if (!byId.has(i)) missing(`No ${what} ${i}`)
  const named = new Set(order)
  return [...order.map(i => byId.get(i)!), ...items.filter(x => !named.has(x.id))]
}

// ---- words ---------------------------------------------------------------------------------------------------------

export const r3 = (x: number): number => Math.round(x * 1000) / 1000
export const vecText = (v: readonly number[]): string => `[${v.map(r3).join(', ')}]`
export const pct = (u: number): string => `${Math.round(u * 100)}%`
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** "a, b and c", or the first few "and 4 more". */
export function names (items: string[], max = 6): string {
  const shown = items.slice(0, items.length > max ? max - 1 : max)
  const rest = items.length - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`
  return shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

/** How a hand is posed, as a phrase: "in the default fist", "as the clip has it", "in Bow grip". */
export function refText (c: Character, ref: HandPoseRef | undefined): string {
  if (ref === undefined || ref === 'default') return 'in the default fist'
  if (ref === 'clip') return 'as the clip has it'
  if ('pose' in ref) return `in ${c.hands.poses.find(p => p.id === ref.pose)?.name ?? `pose ${ref.pose}`}`
  return `in the fist of ${ref.fist}`
}

export function windowsText (w: Window[] | undefined): string {
  return w === undefined ? 'the whole clip' : w.map(([a, b]) => `${pct(a)}-${pct(b)}`).join(', ')
}

export const placeText = (p: Placement): string => `placed at ${vecText(p.position)}, turned ${vecText(p.rotation)}, size ${r3(p.scale)}`
