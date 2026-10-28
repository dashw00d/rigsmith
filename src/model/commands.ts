// The one reducer of user actions (src/model/command-types.ts): the server runs it to change a character (then
// journals and broadcasts the result), the app runs it optimistically before the server answers. Pure and
// deterministic: every id it adds comes in the command; it never touches `version` or `updatedAt` (the store bumps
// them). Each section's rules live in commands/<section>.ts. A command that breaks a rule throws a CommandError and
// changes nothing; a batch is all or nothing.
import type { Command } from './command-types.ts'
import { reduceCharacter } from './commands/character.ts'
import { reduceClips } from './commands/clips.ts'
import { bad, isObj } from './commands/common.ts'
import { reduceGear } from './commands/gear.ts'
import { reduceHands } from './commands/hands.ts'
import { reduceLook } from './commands/look.ts'
import { reduceMount } from './commands/mount.ts'
import { reduceSkeleton } from './commands/skeleton.ts'
import { reduceSkin } from './commands/skin.ts'
import type { Character } from './types.ts'

export { CommandError } from './commands/common.ts'

export interface Applied {
  character: Character
  /** What changed, in plain words (the journal's lines), e.g. "gear GearAxe: placed at [0, 1.2, 0], turned [0, 90, 0], size 1.16". */
  changes: string[]
}

/** Section of a command type (the part before the first dot) -> its reducer, which changes the character in place. */
const SECTIONS: Record<string, (c: Character, cmd: never) => string[]> = {
  character: reduceCharacter,
  skeleton: reduceSkeleton,
  skin: reduceSkin,
  hands: reduceHands,
  gear: reduceGear,
  slot: reduceClips,
  clips: reduceClips,
  look: reduceLook,
  mount: reduceMount,
}

export function applyCommand (c: Character, cmd: Command): Applied {
  return applyCommands(c, [cmd])
}

/** The commands in order on a copy of `c` (plain data: the app passes $state.snapshot), all or nothing. */
export function applyCommands (c: Character, cmds: Command[]): Applied {
  if (!Array.isArray(cmds)) bad('commands must be a list')
  const next = structuredClone(c)
  const changes: string[] = []
  for (const cmd of cmds as unknown[]) {
    const type = isObj(cmd) && typeof cmd.type === 'string' ? cmd.type : bad('A command needs a type')
    const reduce = Object.hasOwn(SECTIONS, type.split('.')[0]) ? SECTIONS[type.split('.')[0]] : bad(`Unknown command ${type}`)
    changes.push(...reduce(next, cmd as never))
  }
  return { character: next, changes }
}
