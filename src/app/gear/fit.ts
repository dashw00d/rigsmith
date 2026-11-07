import type { Command } from '../../model/command-types.ts'
import type { Gear, Placement, Vec3 } from '../../model/types.ts'

/** The document before a placement session, kept separately from optimistic edits. */
export interface FitStart { character: string, id: string, place: Placement, origin: Vec3 | null }

export function fitSnapshot (character: string, gear: Gear): FitStart {
  const p = gear.attach.place
  return {
    character, id: gear.id,
    place: { position: [...p.position], rotation: [...p.rotation], scale: p.scale },
    origin: gear.origin === undefined ? null : [...gear.origin],
  }
}

/** One batch: origin rebases placement, so restore the origin before the original placement. */
export function fitRestore (start: FitStart, current: Gear): Command[] {
  if (start.id !== current.id) return []
  const originChanged = JSON.stringify(start.origin) !== JSON.stringify(current.origin ?? null)
  const placeChanged = JSON.stringify(start.place) !== JSON.stringify(current.attach.place)
  const commands: Command[] = []
  if (originChanged) commands.push({ type: 'gear.origin', id: start.id, origin: start.origin })
  if (originChanged || placeChanged) commands.push({ type: 'gear.place', id: start.id, place: start.place })
  return commands
}
