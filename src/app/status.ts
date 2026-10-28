// What the frame says about a character, worked out from src/model/select.ts: the file the viewer shows, the tick
// each step gets in the top bar, the words for what the import was. Pure, so the list, the top bar, the viewer and
// the thumbnails agree.
import { phaseOf } from '../model/select.ts'
import type { Character, Job } from '../model/types.ts'
import type { Step } from '../state/app.svelte.ts'
import { scanLines } from './look/text.ts'

type Shown = Pick<Character, 'files' | 'status' | 'error' | 'source' | 'skeleton' | 'skin'>

/** The file a character is shown with: its rig only while the rig was built for the skeleton it has now (phase
 * rigged; while a new rig is being made, the old one if it still fits), else the imported model. Undefined: nothing
 * to show yet (importing, or an animation-only file). */
export function shownFile (c: Shown): string | undefined {
  if (c.files.rigged !== undefined) {
    const settled: Shown = c.status === 'rigging' ? { ...c, status: 'rigged' } : c
    if (phaseOf(settled).phase === 'rigged') return c.files.rigged
  }
  return c.files.model
}

/** Whether it has a rig made here (rigged.glb), not none or the imported file's own (as server/importing.ts says). */
export function hasOwnRig (c: Pick<Character, 'files'>): boolean {
  return c.files.rigged !== undefined && c.files.rigged !== c.files.model
}

/** A step's tick in the top bar: done, needs something, or nothing to say. */
export type StepMark = 'done' | 'needs' | null

type Marked = Pick<Character, 'status' | 'error' | 'source' | 'skeleton' | 'skin' | 'gear' | 'clips' | 'look'>

/** What the Ship tick goes by (src/state/ship.svelte.ts has it): the units the character is or is the companion of,
 * each with whether Rigsmith's entry differs from the game's and how its last export ended (null: never exported, or
 * not read yet), and whether any check of those units fails. */
export interface ShipFacts {
  units: ReadonlyArray<{ differs: boolean, last: { status: 'done' | 'failed' | 'cancelled', holdsFailed: readonly string[] } | null }>
  failing: boolean
}

/** Ship: needs work while a check fails, or a unit's last export failed or its holds check did; done once every
 * unit's last export went through and the game has its entry as Rigsmith does. Nothing to say otherwise: not a unit,
 * never exported, a cancelled export, a change not exported yet. */
export function shipMark (f: ShipFacts): StepMark {
  if (f.units.length === 0) return null
  if (f.failing || f.units.some(u => u.last !== null && (u.last.status === 'failed' || u.last.holdsFailed.length > 0))) return 'needs'
  return f.units.every(u => u.last?.status === 'done' && !u.differs) ? 'done' : null
}

/** A step's tick. `ship`: the facts the Ship tick goes by (shipMark); without them it says nothing. */
export function stepMark (c: Marked | null, step: Step, job?: Job | null, ship?: ShipFacts | null): StepMark {
  if (c === null) return null
  const { phase } = phaseOf(c, job)
  const imported = c.source.stats !== undefined
  switch (step) {
    case 'import':
      if (phase === 'importing') return null
      return imported ? 'done' : phase === 'error' ? 'needs' : null
    case 'skeleton':
      // (the Rig button is in this step: a character that needs a rig needs this step)
      return phase === 'rigged' ? 'done' : phase === 'needs-rig' || phase === 'needs-conversion' ? 'needs' : null
    case 'skin':
      return phase === 'rigged' ? 'done' : null
    case 'gear':
      if (c.gear.some(g => g.status === 'error')) return 'needs'
      return c.gear.some(g => g.status === 'ready') ? 'done' : null
    case 'look':
      // (holes the last scan found that no enabled fill or earlier texture covers, as the Look step lists them)
      if (scanLines(c.look.scan, c.look.layers).some(line => line.tone === 'warn')) return 'needs'
      return c.look.layers.some(l => l.enabled) ? 'done' : null
    case 'motion':
      return c.clips.length > 0 ? 'done' : null
    case 'ship':
      return ship === undefined || ship === null ? null : shipMark(ship)
  }
}

/** What the uploaded file was, in words. */
export function kindLabel (c: Pick<Character, 'status' | 'source' | 'skeleton'>): string {
  switch (c.source.kind) {
    case 'mesh': return c.status === 'rigged' ? 'Auto-rigged' : 'Unrigged mesh'
    case 'rigged': return c.skeleton.converted === true ? 'Rigged elsewhere, converted' : 'Rigged elsewhere'
    case 'animation': return 'Animation only'
  }
}

const PRESETS: Record<string, string> = { mixamo: 'Mixamo', tripo: 'Tripo auto-rig', rigify: 'Rigify', unreal: 'Unreal mannequin', unknown: 'Unknown skeleton' }

/** The skeleton family of a rigged import, in words (null: none). */
export function presetLabel (preset: string | undefined): string | null {
  return preset === undefined ? null : PRESETS[preset] ?? preset
}

/** Whether Auto-rig all takes a character: an unrigged mesh, imported, with nothing working on it and its weights
 * not locked (a re-rig of a rigged one is asked for in its own Skeleton step). */
export function autoRiggable (c: Pick<Character, 'status' | 'error' | 'source' | 'skeleton' | 'skin'>, job?: Job | null): boolean {
  return c.source.kind === 'mesh' && c.status === 'ready' && (job === undefined || job === null) && !c.skin.locked &&
    phaseOf(c).phase === 'needs-rig'
}
