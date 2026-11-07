// The dressing keys and the app's undo keys (src/ui/shortcuts.ts registry; App.svelte registers them once and runs
// the registry from its window listener). Dressing keys work in the Gear step on a dynamic character; `, .` only
// while no clip plays (the timeline steps frames with them then). Ctrl+Z / Ctrl+Shift+Z everywhere
// but Motion (its own keys undo there, through the same journal: timeline.undo / redo); an undo toasts what it took
// back, with Redo.
import { app } from '../../state/app.svelte.ts'
import { timeline } from '../../state/timeline.svelte.ts'
import { viewer } from '../../state/viewer.svelte.ts'
import { coverage } from '../../state/coverage.svelte.ts'
import { isFolk } from '../../engine/folk.ts'
import { register, type Shortcut } from '../../ui/shortcuts.ts'
import type { Character } from '../../state/api.ts'
import { wardrobe } from './wardrobe.svelte.ts'

const dressing = (): Character | null => {
  const c = app.selected
  return c !== null && app.step === 'gear' && isFolk(c) ? c : null
}

// (what Redo can put back: an undo's seq, while nothing was edited since; Motion keeps its own, timeline.svelte.ts)
let redos: Array<{ character: string, seq: number, mark: string }> = []

async function undo (): Promise<void> {
  const c = app.selected
  if (c === null) return
  const entry = await app.undo(c.id)
  if (entry === null) return
  const mark = app.editMark(c.id)
  redos = [...redos.filter(r => r.character !== c.id || r.mark === mark), { character: c.id, seq: entry.seq, mark }]
  app.toast('info', `Undone: ${entry.changes[0] ?? 'the last change'}`, 4000, { label: 'Redo', run: () => { void redo() } })
}

async function redo (): Promise<void> {
  const c = app.selected
  if (c === null) return
  const last = redos.at(-1)
  if (last !== undefined && last.character === c.id) {
    redos.pop()
    // (an edit made since the undo, here or anywhere, ends what redo could put back)
    if (last.mark === app.editMark(c.id)) { await app.undo(c.id, last.seq); return }
    redos = redos.filter(r => r.character !== c.id)
  }
  app.toast('info', 'Nothing to redo', 2500)
}

export function registerAppKeys (): () => void {
  const editing = (): boolean => app.selected !== null && app.step !== 'motion'
  const when = (): boolean => dressing() !== null
  const run = (fn: (c: Character) => void) => (): void => { const c = dressing(); if (c !== null) fn(c) }
  const list: Shortcut[] = [
    { id: 'view.frame', keys: 'f', label: 'Frame the character', group: 'Everywhere', when: () => app.selected !== null && !timeline.hovered, run: () => { viewer.focus() } },
    { id: 'incoming.open', keys: 'i', label: 'Open or close Incoming', group: 'Everywhere', run: () => { app.toggleDrawer('incoming') } },
    { id: 'dress.set.prev', keys: '[', label: 'Previous set', group: 'Dressing', when, run: run(c => { wardrobe.step(c, 'outfit', -1) }) },
    { id: 'dress.set.next', keys: ']', label: 'Next set', group: 'Dressing', when, run: run(c => { wardrobe.step(c, 'outfit', 1) }) },
    { id: 'dress.skin.prev', keys: 'shift+[', label: 'Previous skin', group: 'Dressing', when, run: run(c => { wardrobe.step(c, 'skin', -1) }) },
    { id: 'dress.skin.next', keys: 'shift+]', label: 'Next skin', group: 'Dressing', when, run: run(c => { wardrobe.step(c, 'skin', 1) }) },
    { id: 'dress.clothes.prev', keys: ',', label: 'Previous clothes', group: 'Dressing', when: () => when() && timeline.playing === null, run: run(c => { wardrobe.step(c, 'clothing', -1) }) },
    { id: 'dress.clothes.next', keys: '.', label: 'Next clothes', group: 'Dressing', when: () => when() && timeline.playing === null, run: run(c => { wardrobe.step(c, 'clothing', 1) }) },
    { id: 'dress.randomize', keys: 'r', label: 'Randomize: a new unit (locked slots kept)', group: 'Dressing', when: () => when() && !wardrobe.crowdOpen, run: run(c => { wardrobe.randomize(c) }) },
    { id: 'dress.wardrobe', keys: 'w', label: 'Open or close the Wardrobe', group: 'Dressing', when, run: () => { app.toggleDrawer('wardrobe') } },
    { id: 'gear.coverage', keys: 'h', label: 'Show body coverage', group: 'Dressing', when: () => app.step === 'gear' && viewer.character?.skeleton != null, run: () => { coverage.on = !coverage.on } },
    { id: 'dress.crowd', keys: 'c', label: 'Crowd: many units side by side', group: 'Dressing', when, run: () => { wardrobe.crowdOpen = !wardrobe.crowdOpen } },
    { id: 'app.undo', keys: 'ctrl+z', label: 'Undo', group: 'Everywhere', when: editing, run: () => { void undo() } },
    { id: 'app.redo', keys: 'ctrl+shift+z', label: 'Redo', group: 'Everywhere', when: editing, run: () => { void redo() } },
    { id: 'app.redo.y', keys: 'ctrl+y', label: 'Redo', group: 'Everywhere', when: editing, run: () => { void redo() } },
    { id: 'app.keys', keys: '?', label: 'This list of keys', group: 'Everywhere', run: () => { wardrobe.keysOpen = !wardrobe.keysOpen } },
  ]
  return register(...list)
}
