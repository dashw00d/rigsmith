// Every change to a character, by whoever made it (the app, or a tool naming itself in the x-rigsmith-by header), in
// plain words: characters/<id>/journal.jsonl, one JournalEntry (src/model/types.ts) a line, append-only. So the designer
// and an agent can each read what the other did, and undo can find what a command changed.
//
// The change lines come from whoever wrote: the model's reducers for commands, the jobs for their results. An entry's
// seq is given under the store's per-character lock (server/store.ts), so it is increasing in file order. Lines from
// before schema 2 have no seq: they read as -(line + 1), what 'legacy'. `undoneBy` is never written; it is derived here.
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Character, JournalEntry } from '../src/model/types.ts'
import { touchedBy } from '../src/model/entities.ts'
import { characterDir, events, locked } from './store.ts'

export type { JournalEntry }

const fileOf = (id: string): string => path.join(characterDir(id), 'journal.jsonl')

/** The next seq per character, learnt from the file the first time it is appended to. */
const nextSeq = new Map<string, number>()

/** Every entry, oldest first, with `undoneBy` derived. */
export async function readJournal (id: string): Promise<JournalEntry[]> {
  let text: string
  try { text = await readFile(fileOf(id), 'utf8') } catch { return [] }
  const out: JournalEntry[] = []
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    let raw: Partial<JournalEntry>
    // (a line cut short by a crash is skipped, not the whole journal)
    try { raw = JSON.parse(line) as Partial<JournalEntry> } catch { return }
    if (typeof raw.seq === 'number') out.push({ ...raw, what: raw.what ?? 'legacy', changes: raw.changes ?? [] } as JournalEntry)
    else out.push({ seq: -(i + 1), at: raw.at ?? '', by: raw.by ?? 'app', changes: raw.changes ?? [], what: 'legacy', ...(raw.note === true ? { note: true as const } : {}) })
  })
  return withUndone(out)
}

/** An entry is undone when an entry that undoes it is not itself undone (an undo taken back is a redo); its undoneBy is
 * the newest such entry. */
export function withUndone (entries: JournalEntry[]): JournalEntry[] {
  const bySeq = new Map(entries.map(e => [e.seq, e]))
  const undoers = new Map<number, number[]>()
  for (const e of entries) if (e.undoes !== undefined) undoers.set(e.undoes, [...(undoers.get(e.undoes) ?? []), e.seq])
  const memo = new Map<number, number | null>()
  const undoneBy = (seq: number): number | null => {
    if (memo.has(seq)) return memo.get(seq)!
    memo.set(seq, null)
    // (newest first: an undoer always comes after what it undoes, so this ends)
    const by = [...(undoers.get(seq) ?? [])].reverse().find(u => bySeq.has(u) && undoneBy(u) === null) ?? null
    memo.set(seq, by)
    return by
  }
  return entries.map(e => {
    const out = { ...e }
    delete out.undoneBy
    const by = undoneBy(e.seq)
    if (by !== null) out.undoneBy = by
    return out
  })
}

/** The last `last` entries, oldest first. */
export async function journal (id: string, last = 200): Promise<JournalEntry[]> {
  const all = await readJournal(id)
  return Number.isFinite(last) && last > 0 ? all.slice(-last) : all
}

/** Append an entry, giving it the next seq. The caller holds the character's store lock. */
export async function append (id: string, entry: Omit<JournalEntry, 'seq' | 'undoneBy'>): Promise<JournalEntry> {
  let seq = nextSeq.get(id)
  if (seq === undefined) seq = Math.max(0, ...(await readJournal(id)).map(e => e.seq)) + 1
  const out: JournalEntry = { seq, ...entry }
  await appendFile(fileOf(id), JSON.stringify(out) + '\n')
  nextSeq.set(id, seq + 1)
  return out
}

/** Forget what is cached about a character's journal (it was deleted or its file replaced). */
export function forgetJournal (id: string): void { nextSeq.delete(id) }

/** A line of its own: a note someone wrote (`written`), or a change made outside the document (weights painted, a
 * unit exported). Never undoable. */
export async function note (id: string, by: string, text: string, written = false): Promise<JournalEntry> {
  const entry = await locked(id, async () => await append(id, {
    at: new Date().toISOString(), by, changes: [text], what: 'note', ...(written ? { note: true as const } : {}),
  }))
  events.emit('journal', id)
  return entry
}

/** What changed from `before` to `after` by entity, in plain words: for writers that have no change lines of their own. */
export function describe (before: Character | null, after: Character): string[] {
  if (before === null) return ['created']
  const named = (list: Array<{ id: string, name?: string }>, id: string): string | undefined => list.find(x => x.id === id)?.name
  return touchedBy(before, after).map(key => {
    const [kind, id] = key.split(':')
    if (key === 'name') return `name: ${before.name} -> ${after.name}`
    if (id === undefined) return `${kind.replace(/([A-Z])/g, ' $1').toLowerCase()} changed`
    const of = (c: Character): Array<{ id: string, name?: string }> =>
      kind === 'gear' ? c.gear : kind === 'slot' ? c.clips : kind === 'cloth' ? c.look.cloth ?? []
        : kind === 'set' ? c.folk?.sets ?? [] : kind === 'pool' ? c.folk?.pools ?? [] : kind === 'kind' ? c.folk?.kinds ?? []
          : kind === 'stance' ? c.folk?.stances ?? [] : c.look.layers.map(l => ({ id: l.id, name: l.image }))
    const was = named(of(before), id)
    const now = named(of(after), id)
    return `${kind} ${now ?? was ?? id}: ${was === undefined ? 'added' : now === undefined ? 'removed' : 'changed'}`
  })
}

/** Journal the change from `before` to `after` (plus `extra` lines) when there is one. For writers not yet using
 * updateCharacter's meta, which journals as it writes. */
export async function record (id: string, by: string, before: Character | null, after: Character, extra: string[] = []): Promise<void> {
  const changes = [...describe(before, after), ...extra]
  if (changes.length === 0) return
  await locked(id, async () => await append(id, { at: new Date().toISOString(), by, changes, what: 'update' }))
  events.emit('journal', id)
}
