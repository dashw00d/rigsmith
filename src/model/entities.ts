// Generic undo. A character is cut into entities (the keys are documented on types.ts UndoRecord); a write's journal
// entry lists the ones it changed (`touched`) and, when it can be undone, keeps them as they were before plus a hash
// of each right after. Undo puts the before values back, unless a later write moved one of them on (a conflict).
// Job-owned fields (source, files, status, the rig report, look.scan...) are no entities: undo never rolls them back.
import { fnv1a, hex8 } from './ids.ts'
import type { Character, Gear, SkinSection, UndoRecord } from './types.ts'

/** JSON with every object's keys sorted (undefined left out, as JSON does), so equal values read the same. */
export function stableJson (v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? 'null' : stableJson(x))).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
}

export const hashOf = (v: unknown): string => hex8(fnv1a(stableJson(v ?? null)))

const ORDERS = { gearOrder: 'gear', slotOrder: 'clips', layerOrder: 'layers' } as const
const isOrder = (key: string): key is keyof typeof ORDERS => key in ORDERS

/** What the gear's jobs write (an import's status and model, its painted weights): not part of its entity. */
const GEAR_JOB_FIELDS = ['status', 'error', 'painted', 'model'] as const

function gearEntity (g: Gear): Partial<Gear> {
  const e: Partial<Gear> = { ...g }
  for (const k of GEAR_JOB_FIELDS) delete e[k]
  return e
}

/** Every entity of the character by key; an entity that doesn't exist (no mount) is absent. */
export function entitiesOf (c: Character): Map<string, unknown> {
  const m = new Map<string, unknown>()
  m.set('name', c.name)
  m.set('skeleton', c.skeleton)
  m.set('skinLock', c.skin.lockReason === undefined ? { locked: c.skin.locked } : { locked: c.skin.locked, lockReason: c.skin.lockReason })
  m.set('hands', c.hands)
  if (c.mount !== undefined) m.set('mount', c.mount)
  m.set('gearOrder', c.gear.map(g => g.id))
  for (const g of c.gear) m.set(`gear:${g.id}`, gearEntity(g))
  m.set('slotOrder', c.clips.map(s => s.id))
  for (const s of c.clips) m.set(`slot:${s.id}`, s)
  m.set('layerOrder', c.look.layers.map(l => l.id))
  for (const l of c.look.layers) m.set(`layer:${l.id}`, l)
  return m
}

/** The keys of the entities that differ between the two. */
export function touchedBy (before: Character, after: Character): string[] {
  const b = entitiesOf(before)
  const a = entitiesOf(after)
  const out: string[] = []
  for (const [key, v] of a) if (!b.has(key) || stableJson(b.get(key)) !== stableJson(v)) out.push(key)
  for (const key of b.keys()) if (!a.has(key)) out.push(key)
  return out
}

/** How to take a write back: each entity it touched as it was before (null: it didn't exist) and a hash of it after.
 * A gear's before value is the whole piece (its model and status too), so a removed piece comes back as it was: its
 * files are never deleted with it. */
export function undoRecord (before: Character, after: Character): UndoRecord {
  const b = entitiesOf(before)
  const a = entitiesOf(after)
  return {
    entities: touchedBy(before, after).map(key => {
      const was = key.startsWith('gear:') ? before.gear.find(g => `gear:${g.id}` === key) : b.get(key)
      return { key, before: was === undefined ? null : structuredClone(was), after: hashOf(a.get(key)) }
    }),
  }
}

/** The character with the record's entities put back. Orders merge: the old order of the items there are now, then
 * any added since in their current order. A gear piece still there keeps its job-owned fields as they are now. */
export function restoreEntities (c: Character, undo: UndoRecord): Character {
  const out = structuredClone(c)
  const orders: Array<{ key: keyof typeof ORDERS, ids: string[] }> = []
  for (const { key, before } of undo.entities) {
    const was = structuredClone(before)
    if (isOrder(key)) { orders.push({ key, ids: was as string[] }); continue }
    const colon = key.indexOf(':')
    const kind = colon < 0 ? key : key.slice(0, colon)
    const itemId = key.slice(colon + 1)
    switch (kind) {
      case 'name': out.name = was as string; break
      case 'skeleton': out.skeleton = was as Character['skeleton']; break
      case 'hands': out.hands = was as Character['hands']; break
      case 'skinLock': {
        const lock = was as Pick<SkinSection, 'locked' | 'lockReason'>
        out.skin.locked = lock.locked
        if (lock.lockReason === undefined) delete out.skin.lockReason
        else out.skin.lockReason = lock.lockReason
        break
      }
      case 'mount':
        if (was === null) delete out.mount
        else out.mount = was as Character['mount']
        break
      case 'gear': {
        const g = was as Gear | null
        const now = out.gear.find(x => x.id === itemId)
        if (g !== null && now !== undefined) {
          const fields = g as unknown as Record<string, unknown>
          for (const k of GEAR_JOB_FIELDS) {
            if (now[k] === undefined) delete fields[k]
            else fields[k] = now[k]
          }
        }
        out.gear = put(out.gear, itemId, g)
        break
      }
      case 'slot': out.clips = put(out.clips, itemId, was as Character['clips'][number] | null); break
      case 'layer': out.look.layers = put(out.look.layers, itemId, was as Character['look']['layers'][number] | null); break
      default: throw new Error(`Unknown entity ${key}`)
    }
  }
  for (const { key, ids } of orders) {
    const field = ORDERS[key]
    const items: Array<{ id: string }> = field === 'layers' ? out.look.layers : out[field]
    const byId = new Map(items.map(x => [x.id, x]))
    const old = ids.filter(i => byId.has(i))
    const kept = new Set(old)
    const merged = [...old.map(i => byId.get(i)!), ...items.filter(x => !kept.has(x.id))]
    if (field === 'layers') out.look.layers = merged as Character['look']['layers']
    else if (field === 'gear') out.gear = merged as Gear[]
    else out.clips = merged as Character['clips']
  }
  return out
}

/** An item replaced in place, added at the end, or (null) taken out. */
function put<T extends { id: string }> (items: T[], itemId: string, value: T | null): T[] {
  const i = items.findIndex(x => x.id === itemId)
  if (value === null) return i < 0 ? items : items.filter(x => x.id !== itemId)
  if (i < 0) return [...items, value]
  const next = [...items]
  next[i] = value
  return next
}

/** The entities of the record a later write has changed since (their hash moved on). Orders never conflict. */
export function undoConflicts (current: Character, undo: UndoRecord): string[] {
  const now = entitiesOf(current)
  return undo.entities.filter(e => !isOrder(e.key) && hashOf(now.get(e.key)) !== e.after).map(e => e.key)
}
