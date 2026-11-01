// @vitest-environment node
// Exercise the actual Svelte module's load/cleanup methods with delayed API replies. Server compilation removes
// reactivity only; no copy of the lifecycle implementation lives in this fixture.
import { readFileSync } from 'node:fs'
import { compileModule } from 'svelte/compiler'
import ts from 'typescript'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { BrushStroke } from '../engine/brushstroke.ts'

const input = ts.transpileModule(readFileSync('src/state/paint.svelte.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText
const compiled = compileModule(input, { filename: 'paint.svelte.js', generate: 'server' }).js.code
const create = new Function('api', 'app', 'viewer', 'WeightPainter', 'THREE', 'BrushStroke', 'animator', 'window', 'PointerEvent', compiled
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '') + '\nreturn paint;')

function deferred<T> (): { promise: Promise<T>, resolve: (value: T) => void, reject: (error: Error) => void } {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

interface View {
  height: number
  root: THREE.Group
  bodySkinned: object[]
  paintMasks: Map<object, object>
  setHighlightBone: ReturnType<typeof vi.fn>
  refreshWeights: ReturnType<typeof vi.fn>
}
interface PaintHarness {
  active: boolean
  characterId: string | null
  gear: string | null
  view: View | null
  painter: object | null
  waiting: boolean
  edited: number
  limited: number
  protectedCount: number
  tool: string
  busy: boolean
  validating: boolean
  stroking: boolean
  mirror: boolean
  revision: number | null
  shapeReference: object[]
  editable: Set<object>
  loaded: (view: View, c: { id: string }) => Promise<(() => void) | void>
  stop: () => void
  attach: () => void
  detach: () => void
  target: () => object
  bonesOf: () => object[]
  refreshView: () => void
  listen: (stage?: object, view?: View) => void
  save: () => Promise<void>
  startOver: (c: { id: string }) => Promise<boolean>
  heal: () => Promise<void>
  copySide: (from: 1 | -1) => Promise<void>
  clearArea: () => void
  clearProtection: () => void
  undo: () => void
  setMirror: (on: boolean) => void
  discardAsked: () => Promise<boolean>
  checkStroke: (painter: object) => Promise<void>
  cancelStroke: () => void
  redraw: () => void
  editsToSave: () => object[]
  working: <T>(label: string, fn: () => T | Promise<T>) => Promise<T>
}
const view = (): View => ({ height: 1, root: new THREE.Group(), bodySkinned: [], paintMasks: new Map(), setHighlightBone: vi.fn(), refreshWeights: vi.fn() })

class TestPointerEvent extends Event {
  button = 0
  pointerId = 3
  clientX = 50
  clientY = 50
  altKey = false
}

function setup (): {
  paint: PaintHarness
  api: Record<'shapeEdits' | 'savePainting' | 'saveGearWeights' | 'saveWeights' | 'saveShape' | 'forgetWeights' | 'forgetShape', ReturnType<typeof vi.fn>>
  app: Record<'toast' | 'byId' | 'jobDone' | 'rig' | 'setBusy' | 'confirm', ReturnType<typeof vi.fn>>
  viewer: { character: View | null, stage: object, setMode: ReturnType<typeof vi.fn> }
  construct: ReturnType<typeof vi.fn>
  inputWindow: EventTarget
  animator: { setPlaying: ReturnType<typeof vi.fn>, clip: null }
} {
  const api = { shapeEdits: vi.fn(), savePainting: vi.fn().mockResolvedValue({ id: 'paint-job' }), saveGearWeights: vi.fn().mockResolvedValue({ id: 'gear-job' }), saveWeights: vi.fn(), saveShape: vi.fn(), forgetWeights: vi.fn(), forgetShape: vi.fn() }
  const app = { toast: vi.fn(), byId: vi.fn().mockReturnValue({ id: 'healer' }), jobDone: vi.fn().mockResolvedValue({ status: 'done' }), rig: vi.fn(), setBusy: vi.fn(), confirm: vi.fn().mockResolvedValue(true) }
  const viewer = { character: null as View | null, stage: { onFrame: vi.fn(() => vi.fn()), controls: { enabled: true } }, setMode: vi.fn() }
  const construct = vi.fn()
  class Painter { constructor (...args: unknown[]) { construct(...args) } }
  const inputWindow = new EventTarget(); const animator = { setPlaying: vi.fn(), clip: null }
  const paint = create(api, app, viewer, Painter, THREE, BrushStroke, animator, inputWindow, TestPointerEvent) as PaintHarness
  paint.active = true; paint.characterId = 'healer'
  return { paint, api, app, viewer, construct, inputWindow, animator }
}

describe('painting saved-reference load lifecycle', () => {
  it('drops a late reference reply after painting stops', async () => {
    const { paint, api, viewer } = setup(); const request = deferred<object[]>()
    const stageView = view(); viewer.character = stageView; api.shapeEdits.mockReturnValue(request.promise)
    paint.attach = vi.fn()
    const pending = paint.loaded(stageView, { id: 'healer' })
    paint.stop(); request.resolve([{ mesh: 0 }])
    expect(await pending).toBeUndefined()
    expect(paint.attach).not.toHaveBeenCalled()
    expect(paint.active).toBe(false)
    expect(paint.shapeReference).toEqual([])
  })

  it('keeps the new session when the old reply or cleanup arrives later', async () => {
    const { paint, api, viewer } = setup()
    const first = deferred<object[]>(); const second = deferred<object[]>()
    api.shapeEdits.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = view(); const b = view(); const attach = vi.fn(); paint.attach = attach
    viewer.character = a; const old = paint.loaded(a, { id: 'healer' })
    paint.stop(); paint.active = true; paint.characterId = 'healer'
    viewer.character = b; const next = paint.loaded(b, { id: 'healer' })
    const references = [{ mesh: 1 }]; second.resolve(references)
    const cleanup = await next
    first.resolve([{ mesh: 0 }]); expect(await old).toBeUndefined()
    expect(attach).toHaveBeenCalledTimes(1)
    expect(paint.view).toBe(b)
    expect(paint.shapeReference).toBe(references)
    const detach = vi.fn(); paint.detach = detach
    // A fully attached session's cleanup can also be overtaken by a new view.
    api.shapeEdits.mockResolvedValue([])
    const c = view(); viewer.character = c; await paint.loaded(c, { id: 'healer' })
    cleanup?.()
    expect(detach).not.toHaveBeenCalled()
    expect(paint.view).toBe(c)
  })

  it('does not attach a disposed view or report an obsolete request failure', async () => {
    const { paint, api, app, viewer } = setup(); paint.attach = vi.fn()
    const first = deferred<object[]>(); api.shapeEdits.mockReturnValueOnce(first.promise)
    const a = view(); viewer.character = a
    const pending = paint.loaded(a, { id: 'healer' }); viewer.character = view()
    first.resolve([]); await pending
    expect(paint.attach).not.toHaveBeenCalled()
    const failed = deferred<object[]>(); api.shapeEdits.mockReturnValueOnce(failed.promise)
    const b = view(); viewer.character = b; const obsolete = paint.loaded(b, { id: 'healer' })
    paint.stop(); failed.reject(new Error('old request')); await obsolete
    expect(app.toast).not.toHaveBeenCalled()
  })

  it('stops painting with an error when the current reference cannot be loaded', async () => {
    const { paint, api, app, viewer } = setup(); paint.attach = vi.fn()
    const a = view(); viewer.character = a; api.shapeEdits.mockRejectedValue(new Error('offline'))
    await paint.loaded(a, { id: 'healer' })
    expect(paint.active).toBe(false)
    expect(paint.attach).not.toHaveBeenCalled()
    expect(app.toast).toHaveBeenCalledWith('error', 'Could not load saved lifts: offline')
  })

  it('discards unsaved transactions on the reusable live view before starting another painter', () => {
    const { paint } = setup(); const stageView = view(); paint.view = stageView
    const stepBack = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false)
    paint.painter = { stepBack }
    paint.stop()
    expect(stepBack).toHaveBeenCalledTimes(3)
    expect(stageView.refreshWeights).toHaveBeenCalledTimes(1)
    expect(paint.painter).toBeNull()
  })

  it('maps body references to their actual primitive indices when gear precedes the body', () => {
    const { paint, viewer, construct } = setup()
    const body = {}; const gear = {}; const stageView = view(); stageView.bodySkinned = [body]
    paint.view = stageView; viewer.character = stageView
    const edit = { mesh: 0, vertex: 5, from: [0, 0, 0], to: [0, 0, 1] }
    paint.shapeReference = [edit]
    paint.target = () => ({ meshes: [gear, body], editable: [gear], gear: null })
    paint.bonesOf = () => []; paint.refreshView = vi.fn(); paint.listen = vi.fn()
    paint.attach()
    expect(construct).toHaveBeenCalledWith([gear, body], expect.any(Function), paint.editable, [{ ...edit, mesh: 1 }])
    expect(paint.shapeReference).toEqual([edit])
  })
})

describe('cooperative stroke validation lifecycle', () => {
  it('does not silently discard earlier unsaved strokes when navigating during validation', async () => {
    const { paint, app } = setup(); paint.edited = 4; paint.busy = true; paint.validating = true
    app.confirm.mockResolvedValue(false)
    expect(await paint.discardAsked()).toBe(false)
    expect(app.confirm).toHaveBeenCalledOnce()
    expect(paint.active).toBe(true); expect(paint.edited).toBe(4)
    paint.validating = false // a save job keeps its existing navigation behavior
    expect(await paint.discardAsked()).toBe(true)
    expect(app.confirm).toHaveBeenCalledTimes(1)
  })
  it('holds Save until completion and lets Cancel undo only the pending stroke', async () => {
    const { paint, api } = setup(); const done = deferred<boolean>()
    const painter = { endAsync: vi.fn(() => done.promise), stepBack: vi.fn(() => true) }
    paint.painter = painter; paint.redraw = vi.fn()
    const checking = paint.checkStroke(painter)
    expect(paint.validating).toBe(true); expect(paint.busy).toBe(true)
    await paint.save(); expect(api.savePainting).not.toHaveBeenCalled()
    paint.cancelStroke(); expect(painter.stepBack).toHaveBeenCalledTimes(1)
    expect(paint.validating).toBe(false); expect(paint.busy).toBe(false)
    paint.cancelStroke(); paint.detach()
    expect(painter.stepBack).toHaveBeenCalledTimes(1)
    done.resolve(false); await checking
    expect(paint.busy).toBe(false); expect(paint.validating).toBe(false)
    expect(paint.redraw).toHaveBeenCalledTimes(1)
  })

  it('redraws the accepted release result after the engine commits', async () => {
    const { paint } = setup(); const done = deferred<boolean>()
    const painter = { endAsync: () => done.promise }; paint.painter = painter; paint.redraw = vi.fn()
    const checking = paint.checkStroke(painter)
    expect(paint.redraw).not.toHaveBeenCalled()
    done.resolve(true); await checking
    expect(paint.redraw).toHaveBeenCalledOnce()
    expect(paint.busy).toBe(false); expect(paint.validating).toBe(false)
  })

  it('does not undo earlier painting again after an engine check has failed and restored its stroke', async () => {
    const { paint, app } = setup()
    const painter = { endAsync: vi.fn().mockRejectedValue(new Error('bad clip')), stepBack: vi.fn() }
    paint.painter = painter; paint.redraw = vi.fn()
    await paint.checkStroke(painter)
    expect(painter.stepBack).not.toHaveBeenCalled()
    expect(paint.redraw).toHaveBeenCalledOnce()
    expect(app.toast).toHaveBeenCalledWith('error', 'Stroke check failed: bad clip')
    expect(paint.busy).toBe(false)
  })

  it('cancels a pending check when its canvas is detached', async () => {
    const { paint, app } = setup(); const done = deferred<boolean>()
    const painter = { endAsync: () => done.promise, stepBack: vi.fn(() => true) }
    paint.painter = painter; paint.redraw = vi.fn()
    const checking = paint.checkStroke(painter)
    paint.detach()
    expect(painter.stepBack).toHaveBeenCalledOnce()
    expect(paint.busy).toBe(false); expect(paint.validating).toBe(false)
    expect(app.setBusy).toHaveBeenLastCalledWith('paint', null)
    done.resolve(false); await checking
    expect(paint.redraw).not.toHaveBeenCalled()
  })

  it('keeps a newer operation busy when a discarded painter replies late', async () => {
    const { paint, app } = setup(); const old = deferred<boolean>(); const next = deferred<void>()
    const painter = { endAsync: () => old.promise, stepBack: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) }
    paint.painter = painter; paint.redraw = vi.fn()
    const checking = paint.checkStroke(painter)
    paint.stop(); paint.painter = {}; paint.active = true
    const newer = paint.working('new operation', async () => await next.promise)
    old.resolve(true); await checking
    expect(paint.busy).toBe(true)
    expect(paint.redraw).not.toHaveBeenCalled()
    expect(app.setBusy).toHaveBeenLastCalledWith('paint', 'new operation')
    next.resolve(); await newer
    expect(paint.busy).toBe(false)
    expect(app.setBusy).toHaveBeenLastCalledWith('paint', null)
  })

  it('keeps a newer check on the same painter when a cancelled check replies late', async () => {
    const { paint, app } = setup(); const old = deferred<boolean>(); const next = deferred<boolean>()
    const painter = { endAsync: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise), stepBack: vi.fn(() => true) }
    paint.painter = painter; paint.redraw = vi.fn()
    const checking = paint.checkStroke(painter)
    paint.cancelStroke(); expect(painter.stepBack).toHaveBeenCalledOnce()
    const newer = paint.checkStroke(painter); vi.mocked(paint.redraw).mockClear()
    old.resolve(true); await checking
    expect(paint.busy).toBe(true); expect(paint.validating).toBe(true)
    expect(paint.redraw).not.toHaveBeenCalled(); expect(app.toast).not.toHaveBeenCalled()
    next.resolve(true); await newer
    expect(paint.redraw).toHaveBeenCalledOnce()
    expect(paint.busy).toBe(false); expect(paint.validating).toBe(false)
  })
})

describe('saving the current painter', () => {
  function ready () {
    const context = setup(); const { paint } = context
    const edits = [{ mesh: 0, vertex: 1, weights: [['Hips', 1]] }]
    const lifts = [{ mesh: 0, vertex: 1, from: [0,0,0], to: [0,0,.01] }]
    const painter = { saved: vi.fn(), shapeEdits: () => lifts }
    paint.painter = painter; paint.edited = 2; paint.limited = 3; paint.revision = 7
    paint.editsToSave = () => edits
    paint.working = async (_label, fn) => await fn()
    return { ...context, painter, edits, lifts }
  }

  it('cannot publish or checkpoint a provisional drag through Save', async () => {
    const { paint, api, app, painter } = ready(); paint.stroking = true
    const serialize = vi.fn(() => { throw new Error('Provisional painting must not be read for saving') })
    paint.editsToSave = serialize
    await paint.save()
    expect(serialize).not.toHaveBeenCalled()
    expect(api.savePainting).not.toHaveBeenCalled()
    expect(api.saveGearWeights).not.toHaveBeenCalled()
    expect(app.jobDone).not.toHaveBeenCalled()
    expect(painter.saved).not.toHaveBeenCalled()
    expect(paint.edited).toBe(2)
  })

  it('keeps Undo, repair commands and mirror settings from replacing the in-progress stroke', async () => {
    const { paint } = setup(); paint.stroking = true
    const painter = { heal: vi.fn(), copySide: vi.fn(), clearArea: vi.fn(), stepBack: vi.fn(), mirror: true }
    paint.painter = painter
    await paint.heal(); await paint.copySide(1); paint.clearArea(); paint.undo(); paint.setMirror(false)
    for (const command of [painter.heal, painter.copySide, painter.clearArea, painter.stepBack]) expect(command).not.toHaveBeenCalled()
    expect(painter.mirror).toBe(true)
    expect(paint.mirror).toBe(true)
  })

  it('clears protection as an Undoable engine command only when painting is idle', () => {
    const { paint } = setup()
    const painter = { clearProtection: vi.fn() }; paint.painter = painter; paint.redraw = vi.fn()
    paint.stroking = true; paint.clearProtection()
    paint.stroking = false; paint.busy = true; paint.clearProtection()
    expect(painter.clearProtection).not.toHaveBeenCalled()
    paint.busy = false; paint.clearProtection()
    expect(painter.clearProtection).toHaveBeenCalledOnce()
    expect(paint.redraw).toHaveBeenCalledOnce()
  })

  it('routes Protect and Alt through mask-only pointer transactions with synchronous release', () => {
    const { paint, inputWindow, animator } = setup()
    class Canvas extends EventTarget {
      captured = new Set<number>()
      getBoundingClientRect () { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 } }
      setPointerCapture (id: number) { this.captured.add(id) }
      hasPointerCapture (id: number) { return this.captured.has(id) }
      releasePointerCapture (id: number) { this.captured.delete(id) }
    }
    const canvas = new Canvas(); const camera = new THREE.PerspectiveCamera(45, 1, .1, 100)
    camera.position.z = 2; camera.updateMatrixWorld(true)
    const stage = { renderer: { domElement: canvas }, camera, scene: new THREE.Scene(), controls: { enabled: true } }
    const stageView = view(); const mesh = {}
    const points = new Map([[0, 1]])
    const hit = { part: 0, face: [0, 1, 2], point: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1), points }
    const painter = {
      parts: [{ mesh, point: new Int32Array([0, 1, 2]) }], pick: vi.fn(() => hit),
      begin: vi.fn(), protect: vi.fn(), end: vi.fn(), endAsync: vi.fn(),
    }
    paint.painter = painter; paint.view = stageView; paint.editable = new Set([mesh])
    paint.tool = 'protect'; paint.redraw = vi.fn(); paint.listen(stage, stageView)
    for (const altKey of [false, true]) {
      const down = new TestPointerEvent('pointerdown'); down.altKey = altKey
      canvas.dispatchEvent(down)
      expect(paint.stroking).toBe(true); expect(stage.controls.enabled).toBe(false)
      expect(painter.begin).toHaveBeenLastCalledWith({ bounded: true, stableSurface: true, preserveSurface: false })
      expect(painter.protect).toHaveBeenLastCalledWith(0, points, !altKey)
      inputWindow.dispatchEvent(new TestPointerEvent('pointerup'))
      expect(paint.stroking).toBe(false); expect(stage.controls.enabled).toBe(true)
      expect(canvas.captured.size).toBe(0)
    }
    expect(painter.end).toHaveBeenCalledTimes(2); expect(painter.endAsync).not.toHaveBeenCalled()
    expect(animator.setPlaying).toHaveBeenCalledWith(false)
    paint.detach()
  })

  it('shows protected UV aliases separately from Heal coverage without marking geometry edited', () => {
    const { paint } = setup(); const stageView = view(); paint.view = stageView
    const mesh = { geometry: { attributes: { position: { count: 3 } } } }
    paint.painter = {
      parts: [{ mesh, members: new Map([[0, [0]], [1, [1, 2]]]) }],
      area: [new Map([[0, .25], [1, .5]])], protectedPoints: [new Set([1])],
      protectedCount: 1, editedCount: 0, limitedCount: 0, contactLimitedCount: 0,
      stepBack: () => false,
    }
    paint.redraw()
    expect(stageView.paintMasks.get(mesh)).toEqual(new Float32Array([.25, -1, -1]))
    expect(paint.protectedCount).toBe(1); expect(paint.edited).toBe(0)
    expect(stageView.refreshWeights).toHaveBeenCalledOnce()
    paint.stop()
    expect(paint.protectedCount).toBe(0)
    expect(stageView.paintMasks.size).toBe(0)
  })

  it('sends weight and Lift edits in one job and checkpoints only its success', async () => {
    const { paint, api, app, painter, edits, lifts } = ready()
    await paint.save()
    expect(api.savePainting).toHaveBeenCalledExactlyOnceWith('healer', edits, lifts, 7)
    expect(app.jobDone).toHaveBeenCalledExactlyOnceWith('paint-job')
    expect(api.saveShape).not.toHaveBeenCalled()
    expect(api.saveWeights).not.toHaveBeenCalled()
    expect(painter.saved).toHaveBeenCalledTimes(1)
    expect(paint.edited).toBe(0)
  })

  it.each(['failed', 'cancelled'])('retains strokes and Undo when the combined job is %s', async status => {
    const { paint, app, painter } = ready(); app.jobDone.mockResolvedValue({ status })
    await paint.save()
    expect(painter.saved).not.toHaveBeenCalled()
    expect(paint.edited).toBe(2)
    expect(paint.limited).toBe(3)
  })

  it('retains strokes if the combined request fails before a job is created', async () => {
    const { paint, api, app, painter } = ready(); api.savePainting.mockRejectedValue(new Error('offline'))
    await paint.save()
    expect(app.toast).toHaveBeenCalledWith('error', 'offline')
    expect(app.jobDone).not.toHaveBeenCalled()
    expect(painter.saved).not.toHaveBeenCalled()
    expect(paint.edited).toBe(2)
  })

  it('does not checkpoint a newer painter when an old save finishes', async () => {
    const { paint, app, painter } = ready(); const job = deferred<{ status: string }>(); app.jobDone.mockReturnValue(job.promise)
    const pending = paint.save()
    await Promise.resolve()
    const next = { saved: vi.fn() }; paint.painter = next; paint.edited = 11; paint.limited = 4
    job.resolve({ status: 'done' }); await pending
    expect(painter.saved).toHaveBeenCalledTimes(1)
    expect(next.saved).not.toHaveBeenCalled()
    expect(paint.edited).toBe(11)
    expect(paint.limited).toBe(4)
  })

  it('keeps gear painting on its own single-job save path', async () => {
    const { paint, api, painter, edits } = ready(); paint.gear = 'gear-id'
    await paint.save()
    expect(api.saveGearWeights).toHaveBeenCalledExactlyOnceWith('healer', 'gear-id', edits)
    expect(api.savePainting).not.toHaveBeenCalled()
    expect(painter.saved).toHaveBeenCalledTimes(1)
  })

  it('waits for each Start over deletion before submitting the next locked file job', async () => {
    const { paint, api, app } = setup(); const first = deferred<{ status: string }>(); const calls: string[] = []
    api.forgetWeights.mockImplementation(async () => { calls.push('weights'); return { id: 'weights-job' } })
    api.forgetShape.mockImplementation(async () => { calls.push('shape'); return { id: 'shape-job' } })
    app.rig.mockImplementation(async () => { calls.push('rig'); return { id: 'rig-job' } })
    app.jobDone.mockImplementation(async id => { calls.push(`wait:${id}`); return id === 'weights-job' ? await first.promise : { status: 'done' } })
    const pending = paint.startOver({ id: 'healer' })
    await Promise.resolve(); await Promise.resolve()
    expect(api.forgetShape).not.toHaveBeenCalled()
    expect(app.rig).not.toHaveBeenCalled()
    first.resolve({ status: 'done' })
    expect(await pending).toBe(true)
    expect(calls).toEqual(['weights', 'wait:weights-job', 'shape', 'wait:shape-job', 'rig', 'wait:rig-job'])
  })
})
