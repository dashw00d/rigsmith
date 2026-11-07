import path from 'node:path'
import { readJson, WORKSPACE, writeJson } from '../store.ts'
import { readJournal } from '../journal.ts'
export interface IncomingRecord { status: 'accepted' | 'rejected', sha: string, at: string, character?: string, gear?: string, seq?: number }
export type IncomingState = Record<string, IncomingRecord>
const file = path.join(WORKSPACE, 'incoming-state.json')
export async function readState (): Promise<IncomingState> { return await readJson<IncomingState>(file, {}) }
let queue: Promise<unknown> = Promise.resolve()
/** Acceptance follows its journal entry through undo and redo. Legacy records without a sequence remain accepted. */
export async function statusOf (record: IncomingRecord | undefined, sha: string, journals = new Map<string, ReturnType<typeof readJournal>>()): Promise<'pending' | 'accepted' | 'rejected'> {
  if (!record || record.sha !== sha) return 'pending'
  if (record.status !== 'accepted' || record.seq === undefined || !record.character) return record.status
  let journal = journals.get(record.character)
  if (!journal) { journal = readJournal(record.character); journals.set(record.character, journal) }
  const entry = (await journal).find(e => e.seq === record.seq)
  return entry?.undoneBy !== undefined ? 'pending' : 'accepted'
}
export async function changeState (fn: (state: IncomingState) => void | Promise<void>): Promise<void> {
  const turn = queue.then(async () => { const state = await readState(); await fn(state); await writeJson(file, state) })
  queue = turn.catch(() => {}); await turn
}
