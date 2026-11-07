import { describe, expect, it } from 'vitest'
import type { AttemptView, ForgeStage, QueueJob, StageView } from '../../../server/forge/types.ts'
import { cardState, formatEta, moved, moveFocus, queueOrder, shownAttempt, thumbOf } from './board.ts'

const stage = (gate?: ForgeStage['gate']): ForgeStage => ({ id: 's', label: 'S', cmd: ['x'], outputs: ['y'], ...(gate !== undefined ? { gate } : {}) })
const attempt = (id: string, o: Partial<AttemptView> = {}): AttemptView => ({ id, status: 'done', startedAt: 0, outputs: [], stale: [], ...o })
const view = (o: Partial<StageView> = {}): StageView => ({ id: 's', attempts: [], selected: null, ready: false, blocked: null, ...o })
const job = (id: string, status: QueueJob['status'], o: Partial<QueueJob> = {}): QueueJob =>
  ({ id, set: 'a', item: 'i', stage: 's', label: id, lane: 'cpu', params: {}, variant: 0, status, createdAt: 0, progress: 0, message: '', ...o })
const pick = (attempt: string, approved?: boolean): StageView['selected'] => ({ attempt, at: 0, by: 'app', ...(approved === true ? { approved } : {}) })

describe('the forge board', () => {
  it("says what a card's stage is waiting for", () => {
    expect(cardState(stage(), view(), [job('j', 'running')])).toBe('running')
    expect(cardState(stage(), view(), [job('j', 'queued')])).toBe('queued')
    expect(cardState(stage('pick'), view({ attempts: [attempt('a001'), attempt('a002')] }), [])).toBe('pick')
    expect(cardState(stage('approve'), view({ attempts: [attempt('a001')], selected: pick('a001') }), [])).toBe('approve')
    expect(cardState(stage('approve'), view({ attempts: [attempt('a001')], selected: pick('a001', true), ready: true }), [])).toBe('ready')
    expect(cardState(stage(), view({ attempts: [attempt('a001', { stale: ['x changed'] })], selected: pick('a001'), ready: true }), [])).toBe('stale')
    expect(cardState(stage(), view({ attempts: [attempt('a001', { status: 'failed' })] }), [])).toBe('failed')
    expect(cardState(stage(), view({ blocked: 'Sheet: nothing picked yet' }), [])).toBe('blocked')
    expect(cardState(stage(), view(), [job('j', 'done')])).toBe('empty')
  })

  it('shows an attempt by its review, its sheet, its front view or any image', () => {
    expect(thumbOf(attempt('a', { outputs: ['x/pieces/head.glb', 'x/pieces/review.png'] }))).toBe('x/pieces/review.png')
    expect(thumbOf(attempt('a', { outputs: ['x/sheet.json', 'x/sheet.png'] }))).toBe('x/sheet.png')
    expect(thumbOf(attempt('a', { outputs: ['x/views/back.png', 'x/views/front.png'] }))).toBe('x/views/front.png')
    expect(thumbOf(attempt('a', { outputs: ['x/a.webp'] }))).toBe('x/a.webp')
    expect(thumbOf(attempt('a', { outputs: ['x/a.glb'] }))).toBeNull()
  })

  it('shows the picked attempt, else the newest done one', () => {
    const attempts = [attempt('a001'), attempt('a002'), attempt('a003', { status: 'failed' })]
    expect(shownAttempt(view({ attempts, selected: pick('a001') }))?.id).toBe('a001')
    expect(shownAttempt(view({ attempts }))?.id).toBe('a002')
    expect(shownAttempt(view())).toBeNull()
  })

  it('keeps the focus on the board', () => {
    expect(moveFocus(null, 3, 4, 1, 0)).toEqual({ item: 0, stage: 0 })
    expect(moveFocus({ item: 2, stage: 3 }, 3, 4, 1, 1)).toEqual({ item: 2, stage: 3 })
    expect(moveFocus({ item: 1, stage: 0 }, 3, 4, -1, -1)).toEqual({ item: 0, stage: 0 })
    expect(moveFocus({ item: 1, stage: 0 }, 0, 4, 1, 0)).toBeNull()
  })

  it('says how long is left', () => {
    expect(formatEta(null)).toBeNull()
    expect(formatEta(12.4)).toBe('12 s')
    expect(formatEta(185)).toBe('3 min')
    expect(formatEta(3600)).toBe('1 h')
    expect(formatEta(4800)).toBe('1 h 20 min')
  })

  it('lists the queue running first, then in order, then the finished newest first, and moves a queued job', () => {
    const jobs = [job('d1', 'done', { finishedAt: 1 }), job('q1', 'queued'), job('r', 'running'), job('q2', 'queued'), job('d2', 'failed', { finishedAt: 5 })]
    expect(queueOrder(jobs).map(j => j.id)).toEqual(['r', 'q1', 'q2', 'd2', 'd1'])
    expect(moved(jobs, 'q2', -1)).toEqual(['q2', 'q1'])
    expect(moved(jobs, 'q1', 5)).toEqual(['q2', 'q1'])
    expect(moved(jobs, 'r', 1)).toEqual(['q1', 'q2'])
  })
})
