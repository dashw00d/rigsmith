// The Events lane and inspector mounted against a TimelineView of this test's own (as the timeline will hand them one):
// rows and marks drawn where the view puts them, an event added from the menu at the playhead, one dragged on frames,
// one deleted, the measured blow picked by hand, the inspector's sound picked from the game's. Every edit is checked as
// the commands it sends.
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Command } from '../../../../model/command-types.ts'
import { makeCharacter, makeSlot } from '../../../../model/fixtures.ts'
import type { Character, Slot } from '../../../../model/types.ts'
import { app } from '../../../../state/app.svelte.ts'
import { events } from '../../../../state/events.svelte.ts'
import type { SelectedItem, TimelineView } from '../../lanes.ts'
import EventsInspector from '../EventsInspector.svelte'
import EventsLane from '../EventsLane.svelte'

const W = 600
const FRAMES = 30

function makeView (c: Character, slot: Slot, cut?: { start: number, end: number, blow: number, uncut: number }): TimelineView {
  const state = $state({ selection: [] as SelectedItem[], playhead: 0.3 })
  return {
    character: c,
    slot,
    baked: (cut === undefined ? null : { cut, clip: { duration: 1 } }) as TimelineView['baked'],
    toX: v => v * W,
    fromX: x => x / W,
    width: W,
    duration: 1,
    frames: FRAMES,
    toPlayed: u => u,
    toSource: v => v,
    snap: (v, free) => (free === true ? v : Math.round(v * FRAMES) / FRAMES),
    get playhead () { return state.playhead },
    seek: v => { state.playhead = v },
    get selection () { return state.selection },
    select: (items, mode) => {
      if (mode === 'set') state.selection = items
      else if (mode === 'add') state.selection = [...state.selection, ...items.filter(i => !state.selection.some(s => s.id === i.id))]
      else state.selection = [...state.selection.filter(s => !items.some(i => i.id === s.id)), ...items.filter(i => !state.selection.some(s => s.id === i.id))]
    },
  }
}

const sent: Command[][] = []
let target: HTMLElement
let shown: ReturnType<typeof mount> | null = null

beforeEach(() => {
  sent.length = 0
  vi.spyOn(app, 'do').mockImplementation(async (_id, cmd) => { sent.push(Array.isArray(cmd) ? cmd : [cmd]); return { seq: 1 } as never })
  Element.prototype.setPointerCapture ??= () => {}
  target = document.createElement('div')
  document.body.appendChild(target)
})
afterEach(() => {
  if (shown !== null) unmount(shown)
  shown = null
  target.remove()
  vi.restoreAllMocks()
})

const pointer = (type: string, x: number, o: MouseEventInit = {}): MouseEvent => new MouseEvent(type, { bubbles: true, clientX: x, button: 0, ...o })
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); flushSync() }

describe('the Events lane', () => {
  const slot = makeSlot({ id: 'atk', name: 'Attack', loop: false, events: [
    { id: 'h', name: 'hit', u: 0.5 },
    { id: 'd', name: 'draw', u: 0.1, to: 0.3, sound: 'mix:bowshot' },
    { id: 'l', name: 'step.L', u: 0.2 },
  ] })
  const c = makeCharacter({ clips: [slot] })

  it('draws a row per name and each event where the view puts it', () => {
    shown = mount(EventsLane, { target, props: { view: makeView(c, slot) } })
    flushSync()
    expect([...target.querySelectorAll('.tag')].map(t => t.textContent?.trim())).toEqual(['Hit', 'Left foot down', 'Draw'])
    const marks = [...target.querySelectorAll<HTMLElement>('.mark')]
    expect(marks.map(m => m.style.left)).toEqual(['300px', '120px'])
    const span = target.querySelector<HTMLElement>('.span')!
    expect([span.style.left, span.style.width]).toEqual(['60px', '120px'])
  })

  it('adds an event of the menu at the playhead, with its built-in bone', async () => {
    shown = mount(EventsLane, { target, props: { view: makeView(c, slot) } })
    flushSync()
    target.querySelector<HTMLButtonElement>('.chip')!.click()
    flushSync()
    const items = [...target.querySelectorAll<HTMLButtonElement>('.menu .item')]
    expect(items.find(b => b.textContent?.includes('Hit'))!.disabled).toBe(true)
    items.find(b => b.textContent?.includes('Right foot down'))!.click()
    await settle()
    expect(sent).toEqual([[{ type: 'slot.event.add', slot: 'atk', event: { id: expect.any(String), name: 'step.R', u: 0.3, bone: 'RightFoot' } }]])
  })

  it('drags an event on frames, and deletes the selection with Delete', async () => {
    const view = makeView(c, slot)
    shown = mount(EventsLane, { target, props: { view } })
    flushSync()
    const step = target.querySelectorAll<HTMLElement>('.mark')[1]
    step.dispatchEvent(pointer('pointerdown', 120))
    flushSync()
    expect(view.selection).toEqual([{ track: 'events', id: 'l', u: 0.2 }])
    step.dispatchEvent(pointer('pointermove', 152))
    flushSync()
    expect(target.querySelector('.readout')?.textContent).toBe('8')
    step.dispatchEvent(pointer('pointerup', 152))
    await settle()
    expect(sent.at(-1)).toEqual([{ type: 'slot.event.update', slot: 'atk', id: 'l', patch: { u: 8 / 30 } }])
    const lane = target.querySelector<HTMLElement>('.events-lane')!
    lane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await settle()
    expect(sent.at(-1)).toEqual([{ type: 'slot.event.remove', slot: 'atk', id: 'l' }])
  })

  it("shows the fit's measured blow hollow, and moving it picks the blow by hand", async () => {
    const plain = makeSlot({ id: 'atk', name: 'Attack', loop: false })
    const view = makeView(makeCharacter({ clips: [plain] }), plain, { start: 0, end: 1, blow: 0.45, uncut: 1 })
    shown = mount(EventsLane, { target, props: { view } })
    flushSync()
    const blow = target.querySelector<HTMLElement>('.mark.measured')!
    expect(blow.style.left).toBe('270px')
    blow.dispatchEvent(pointer('pointerdown', 270))
    blow.dispatchEvent(pointer('pointermove', 300))
    blow.dispatchEvent(pointer('pointerup', 300))
    await settle()
    expect(sent.at(-1)).toEqual([{ type: 'slot.event.add', slot: 'atk', event: { id: expect.any(String), name: 'hit', u: 0.5 } }])
  })
})

describe('the Events inspector', () => {
  it("sets the selected event's sound from the game's, and its frame typed", async () => {
    const slot = makeSlot({ id: 'atk', name: 'Attack', loop: false, events: [{ id: 'r', name: 'release', u: 0.5 }] })
    const view = makeView(makeCharacter({ clips: [slot] }), slot)
    view.select([{ track: 'events', id: 'r', u: 0.5 }], 'set')
    events.game = { repo: '/game', found: true, sounds: [{ id: 'bowshot', cat: 'combat', files: ['arrow_shoot.wav'], db: 4, pitch: 0.1 }] }
    vi.spyOn(events, 'loadGame').mockResolvedValue()
    vi.spyOn(events, 'loadOwn').mockResolvedValue()
    vi.spyOn(events, 'play').mockResolvedValue()
    shown = mount(EventsInspector, { target, props: { view } })
    flushSync()
    expect(target.querySelector('.title strong')?.textContent).toBe('Release')
    target.querySelector<HTMLButtonElement>('.list .pick')!.click()
    await settle()
    expect(sent.at(-1)).toEqual([{ type: 'slot.event.update', slot: 'atk', id: 'r', patch: { sound: 'mix:bowshot' } }])
    const frame = target.querySelector<HTMLInputElement>('input[aria-label="Its frame"]')!
    frame.focus()
    frame.value = '12'
    frame.dispatchEvent(new Event('input', { bubbles: true }))
    frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
    expect(sent.at(-1)).toEqual([{ type: 'slot.event.update', slot: 'atk', id: 'r', patch: { u: 0.4 } }])
  })
})
