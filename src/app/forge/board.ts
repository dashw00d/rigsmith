// The Forge board's pure parts: what a card shows (its state, its picture), where the keyboard's focus goes, how
// long is left. The components and src/state/forge.svelte.ts read these.
import type { AttemptView, ForgeStage, QueueJob, StageView } from '../../../server/forge/types.ts'

export type CardState = 'running' | 'queued' | 'pick' | 'approve' | 'ready' | 'stale' | 'failed' | 'blocked' | 'empty'

/** What a card says, first match wins: running or queued here; a gate waiting for a person; picked and current;
 * picked but no longer following from upstream or its code; the last attempt failed; its inputs not ready; nothing. */
export function cardState (stage: ForgeStage, view: StageView, jobs: QueueJob[]): CardState {
  if (jobs.some(j => j.status === 'running')) return 'running'
  if (jobs.some(j => j.status === 'queued')) return 'queued'
  const done = view.attempts.filter(a => a.status === 'done')
  const picked = view.selected === null ? undefined : view.attempts.find(a => a.id === view.selected!.attempt)
  if (view.ready && picked !== undefined) return picked.stale.length > 0 ? 'stale' : 'ready'
  if (stage.gate === 'pick' && done.length > 0) return 'pick'
  if (picked !== undefined && stage.gate !== undefined && stage.gate !== 'pick') return 'approve'
  if (view.attempts.at(-1)?.status === 'failed') return 'failed'
  if (view.blocked !== null) return 'blocked'
  return 'empty'
}

export const STATE_LABEL: Record<CardState, string> = {
  running: 'Running', queued: 'Queued', pick: 'Pick one', approve: 'Approve', ready: 'Done', stale: 'Stale', failed: 'Failed', blocked: 'Waiting', empty: 'Not run',
}

export const STATE_TONE: Record<CardState, 'muted' | 'accent' | 'ok' | 'warn' | 'error' | 'busy'> = {
  running: 'busy', queued: 'muted', pick: 'accent', approve: 'accent', ready: 'ok', stale: 'warn', failed: 'error', blocked: 'muted', empty: 'muted',
}

const IMAGE = /\.(png|jpe?g|webp)$/i

/** The picture an attempt is shown by: a review image, else the sheet, else a front view, else any image it wrote. */
export function thumbOf (a: AttemptView): string | null {
  const images = a.outputs.filter(o => IMAGE.test(o))
  return images.find(o => /(^|\/)review\.png$/i.test(o)) ?? images.find(o => /(^|\/)sheet\.png$/i.test(o)) ??
    images.find(o => /(^|\/)front\.png$/i.test(o)) ?? images[0] ?? null
}

/** The attempt a card shows: the one picked, else the newest that finished, else the newest. */
export function shownAttempt (view: StageView): AttemptView | null {
  const picked = view.selected === null ? undefined : view.attempts.find(a => a.id === view.selected!.attempt)
  return picked ?? [...view.attempts].reverse().find(a => a.status === 'done') ?? view.attempts.at(-1) ?? null
}

export interface Focus { item: number, stage: number }

/** The focus moved by (items, stages), kept on the board. */
export function moveFocus (f: Focus | null, items: number, stages: number, dItem: number, dStage: number): Focus | null {
  if (items === 0 || stages === 0) return null
  if (f === null) return { item: 0, stage: 0 }
  return { item: Math.max(0, Math.min(items - 1, f.item + dItem)), stage: Math.max(0, Math.min(stages - 1, f.stage + dStage)) }
}

/** '45 s', '3 min', '1 h 20 min'; null when unknown. */
export function formatEta (seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  const m = Math.round(seconds / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 === 0 ? '' : ` ${m % 60} min`}`
}

/** The queue as the drawer lists it: running, then queued in order, then the finished ones newest first. */
export function queueOrder (jobs: QueueJob[]): QueueJob[] {
  const rank = (j: QueueJob): number => (j.status === 'running' ? 0 : j.status === 'queued' ? 1 : 2)
  return jobs.map((j, i) => ({ j, i })).sort((a, b) => rank(a.j) - rank(b.j) || (rank(a.j) === 2 ? (b.j.finishedAt ?? 0) - (a.j.finishedAt ?? 0) : a.i - b.i)).map(x => x.j)
}

/** The queued ids with one moved by `by` places (the order reorder sends). */
export function moved (jobs: QueueJob[], id: string, by: number): string[] {
  const ids = jobs.filter(j => j.status === 'queued').map(j => j.id)
  const i = ids.indexOf(id)
  if (i < 0) return ids
  const to = Math.max(0, Math.min(ids.length - 1, i + by))
  ids.splice(i, 1)
  ids.splice(to, 0, id)
  return ids
}
