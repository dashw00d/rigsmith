import path from 'node:path'
import { readJson, WORKSPACE, writeJson } from '../store.ts'
export interface IncomingRecord { status: 'accepted' | 'rejected', sha: string, at: string, character?: string, gear?: string }
export type IncomingState = Record<string, IncomingRecord>
const file = path.join(WORKSPACE, 'incoming-state.json')
export async function readState (): Promise<IncomingState> { return await readJson<IncomingState>(file, {}) }
let queue: Promise<unknown> = Promise.resolve()
export async function changeState (fn: (state: IncomingState) => void): Promise<void> {
  const turn = queue.then(async () => { const state = await readState(); fn(state); await writeJson(file, state) })
  queue = turn.catch(() => {}); await turn
}
