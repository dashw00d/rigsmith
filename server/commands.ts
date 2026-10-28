// The one way the app and the tools change a character's document: commands (src/model/command-types.ts) applied by
// the model's pure reducer (src/model/commands.ts) under the store lock, as one journal entry per request (a batch is
// all or nothing) that keeps what undo needs. Undo takes an entry back by restoring the entities it touched, and
// refuses (409 { conflicts }) when a later write changed them since; an undo can itself be undone (a redo).
import type { Command } from '../src/model/command-types.ts'
import { applyCommands } from '../src/model/commands.ts'
import { restoreEntities, undoConflicts } from '../src/model/entities.ts'
import type { Character, Vec3 } from '../src/model/types.ts'
import { by, HttpError, readJsonBody, route, send } from './http.ts'
import { readJournal } from './journal.ts'
import { afterChange, type Change, commit, getCharacter, listCharacters, type WriteMeta } from './store.ts'

export { afterChange }

export interface CommandOptions {
  by?: string
  /** The client's id for its optimistic copy. */
  cid?: string
  /** What the journal calls it; default the command type ('batch' for mixed ones). */
  what?: string
  /** Lines added after the reducer's. */
  changes?: string[]
}

const whatOf = (list: Command[]): string => new Set(list.map(c => c.type)).size === 1 ? list[0].type : 'batch'

function check (list: unknown): asserts list is Command[] {
  if (!Array.isArray(list) || !list.every(c => typeof c === 'object' && c !== null && typeof (c as { type?: unknown }).type === 'string')) {
    throw new HttpError(400, 'Commands are objects with a type')
  }
}

/** Apply `commands` to a character as one undoable journal entry. Given as a function, they are worked out from the
 * document as it is under the lock (the v1 layer's patches). Then what follows on other characters: gear removed from a
 * horse comes off every rider's mount that wore it (journaled on the rider). */
export async function runCommands (id: string, commands: Command[] | ((c: Character) => Command[]), o: CommandOptions = {}): Promise<Change> {
  const meta: WriteMeta = { by: o.by, what: o.what ?? '', undoable: true, cid: o.cid }
  let removed: Array<{ id: string, name: string }> = []
  const done = await commit(id, c => {
    const list = typeof commands === 'function' ? commands(c) : commands
    check(list)
    if (meta.what === '') meta.what = list.length === 0 ? 'none' : whatOf(list)
    removed = list.flatMap(x => x.type === 'gear.remove' ? c.gear.filter(g => g.id === x.id).map(g => ({ id: g.id, name: g.name })) : [])
    const applied = applyCommands(c, list)
    // (the extra lines explain a change; with none, nothing is journaled)
    meta.changes = applied.changes.length > 0 ? [...applied.changes, ...(o.changes ?? [])] : []
    return applied.character
  }, meta)
  if (removed.length > 0 && done.entry !== null) await ridersFollow(done.character, removed, o.by)
  return done
}

/** A change made on a horse carried over to its riders: `commands` (worked out under each rider's lock) run on every
 * character `affected` picks, journaled on it with `line`. One rider's failure is logged and doesn't stop the others
 * (the horse's change is already written). */
async function onRiders (affected: (c: Character) => boolean, commands: (c: Character) => Command[], line: string, who: string | undefined): Promise<void> {
  for (const rider of await listCharacters()) {
    if (!affected(rider)) continue
    try {
      await runCommands(rider.id, c => affected(c) ? commands(c) : [], { by: who, what: 'mount.update', changes: [line] })
    } catch (error) {
      console.error(`rigsmith: could not update ${rider.id}'s mount:`, error)
    }
  }
}

async function ridersFollow (horse: Character, removed: Array<{ id: string, name: string }>, who: string | undefined): Promise<void> {
  const gone = new Set(removed.map(g => g.id))
  const wears = (c: Character): boolean => c.mount?.character === horse.id && (c.mount.gear ?? []).some(g => gone.has(g))
  await onRiders(wears, c => [{ type: 'mount.update', patch: { gear: c.mount!.gear!.filter(g => !gone.has(g)) } }],
    `${horse.name}'s ${removed.map(g => g.name).join(', ')} removed, so no longer worn`, who)
}

/** A horse resized by `s` (Import → Size, server/routes/import.ts): its bones kept their turn and their offsets were
 * scaled, so a seat (`mount.position`, in the horse bone's rest space) is scaled the same on every rider, who then sits
 * where he sat. Call it after the resize is written. */
export async function ridersFollowResize (horseId: string, s: number, who?: string): Promise<void> {
  if (!(s > 0) || !Number.isFinite(s) || s === 1) return
  const horse = await getCharacter(horseId)
  if (horse === null) return
  const rides = (c: Character): boolean => c.mount?.character === horseId
  // (rounded as the seat editor writes it, finer)
  const scaled = (p: Vec3): Vec3 => p.map(v => Math.round(v * s * 1e6) / 1e6) as Vec3
  await onRiders(rides, c => [{ type: 'mount.update', patch: { position: scaled(c.mount!.position) } }],
    `${horse.name} resized (×${Math.round(s * 1000) / 1000}), so the seat moved with it`, who)
}

/** Take back the journal entry `seq` (default: the newest undoable entry that isn't an undo and isn't undone). */
export async function undo (id: string, seq?: number, who?: string): Promise<Change> {
  const meta: WriteMeta = { by: who, what: 'undo', undoable: true }
  return await commit(id, async c => {
    // (read under the lock, so nothing is journaled between choosing the entry and restoring it)
    const entries = await readJournal(id)
    const target = seq === undefined
      ? entries.findLast(e => e.undo !== undefined && e.undoes === undefined && e.undoneBy === undefined)
      : entries.find(e => e.seq === seq)
    if (target === undefined) throw new HttpError(seq === undefined ? 409 : 404, seq === undefined ? 'Nothing to undo' : `No journal entry ${seq}`)
    if (target.undo === undefined) throw new HttpError(400, `That change (${target.what}) can't be undone`)
    if (target.undoneBy !== undefined) throw new HttpError(409, `Already undone (entry ${target.undoneBy})`)
    const conflicts = undoConflicts(c, target.undo)
    if (conflicts.length > 0) throw new HttpError(409, 'Changed again since; undoing it would lose those changes', { conflicts })
    const redo = target.undoes !== undefined
    meta.what = redo ? 'redo' : 'undo'
    meta.undoes = target.seq
    meta.changes = target.changes.length === 0
      ? [`${meta.what}: ${target.what}`]
      : target.changes.map(line => redo ? line.replace(/^undone: /, 'redone: ') : `undone: ${line}`)
    return restoreEntities(c, target.undo)
  }, meta)
}

const reply = ({ character, entry }: Change): { character: Character, entry: Change['entry'] } => ({ character, entry })

route('POST', /^\/api\/characters\/([a-z0-9-]+)\/commands$/, async (req, res, [id]) => {
  const body = await readJsonBody<{ command?: unknown, commands?: unknown, cid?: unknown, what?: unknown }>(req)
  const list = body.commands !== undefined ? body.commands : body.command !== undefined ? [body.command] : undefined
  check(list)
  if (list.length === 0) throw new HttpError(400, 'No commands')
  const cid = typeof body.cid === 'string' && body.cid.length <= 64 ? body.cid : undefined
  const what = typeof body.what === 'string' && body.what.trim() !== '' ? body.what.trim().slice(0, 60) : undefined
  send(res, 200, reply(await runCommands(id, list, { by: by(req), cid, what })))
})

route('POST', /^\/api\/characters\/([a-z0-9-]+)\/undo$/, async (req, res, [id]) => {
  const { seq } = await readJsonBody<{ seq?: unknown }>(req)
  if (seq !== undefined && !Number.isInteger(seq)) throw new HttpError(400, 'seq is a journal entry number')
  send(res, 200, reply(await undo(id, seq as number | undefined, by(req))))
})
