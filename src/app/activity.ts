// The words of the activity drawer and the delete check: how long ago, who, what a journal entry can be taken back
// with, what an undo's conflicts were, and why the server would not delete a character. Pure, for ActivityDrawer,
// CharacterList and the Import step.
import type { Character, JournalEntry } from '../model/types.ts'

/** How long ago `t` (ms) was at `now`, short: 'just now', '12s ago', '3m ago', '2h ago', '4d ago'. */
export function ago (t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** A journal time: the clock today, else the day too. */
export function clock (at: string, now: Date): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

/** Who made an entry: 'you' for this app, else the tool's own name ('agent', 'game_import', 'server'). */
export const who = (by: string): string => (by === 'app' ? 'you' : by)

/** What taking an entry back would be: an undo, a redo (an undo taken back), or nothing (it can't be, or it was). */
export function reversal (e: Pick<JournalEntry, 'undo' | 'undoes' | 'undoneBy'>): 'undo' | 'redo' | null {
  if (e.undo === undefined || e.undoneBy !== undefined) return null
  return e.undoes !== undefined ? 'redo' : 'undo'
}

const PLAIN: Record<string, string> = {
  name: 'its name',
  skeleton: 'the skeleton',
  skinLock: 'the weight lock',
  hands: 'the hand poses',
  mount: 'the mount',
  gearOrder: 'the order of its gear',
  slotOrder: 'the order of its clips',
  layerOrder: 'the order of its texture layers',
}

/** An undo record's entity key (src/model/types.ts UndoRecord) in words, naming the gear, slot or layer it is. */
export function entityLabel (c: Pick<Character, 'gear' | 'clips' | 'look'> | null, key: string): string {
  if (PLAIN[key] !== undefined) return PLAIN[key]
  const at = key.indexOf(':')
  if (at < 0) return key
  const kind = key.slice(0, at)
  const id = key.slice(at + 1)
  if (kind === 'gear') return `gear ${c?.gear.find(g => g.id === id)?.name ?? id}`
  if (kind === 'slot') return `clip ${c?.clips.find(s => s.id === id)?.name ?? id}`
  if (kind === 'layer') {
    const layer = c?.look.layers.find(l => l.id === id)
    return layer === undefined ? `texture layer ${id}` : `${layer.kind} layer on ${layer.image}`
  }
  return key
}

/** Why the server refused a delete (its 409 body): who rides it, which game units name it, the job working on it. */
export interface Refusal { riders: string[], units: string[], busy: string | null }

export function refusal (body: unknown): Refusal | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as { riders?: unknown, units?: unknown, busy?: unknown }
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const job = b.busy as { label?: unknown } | null | undefined
  const out: Refusal = { riders: strings(b.riders), units: strings(b.units), busy: typeof job?.label === 'string' ? job.label : null }
  return out.riders.length > 0 || out.units.length > 0 || out.busy !== null ? out : null
}

/** The refusal as the question to delete anyway: what it leaves behind, one line each. */
export function refusalText (r: Refusal, nameOf: (id: string) => string): string {
  const lines: string[] = []
  if (r.riders.length > 0) lines.push(`${r.riders.map(nameOf).join(', ')} ${r.riders.length === 1 ? 'rides' : 'ride'} it: they get off.`)
  if (r.units.length > 0) lines.push(`Game ${r.units.length === 1 ? 'unit' : 'units'} ${r.units.join(', ')} ${r.units.length === 1 ? 'names' : 'name'} it: ${r.units.length === 1 ? 'it' : 'they'} will point at nothing until changed in Ship.`)
  if (r.busy !== null) lines.push(`${r.busy} is working on it: it is cancelled.`)
  return lines.join('\n')
}
