// character.*: the character's own name.
import type { Command } from '../command-types.ts'
import type { Character } from '../types.ts'
import { name, unknown } from './common.ts'

export type CharacterCommand = Extract<Command, { type: `character.${string}` }>

export function reduceCharacter (c: Character, cmd: CharacterCommand): string[] {
  switch (cmd.type) {
    case 'character.rename': {
      const next = name(cmd.name, 'name')
      if (next === c.name) return []
      const was = c.name
      c.name = next
      return [`name: ${was} -> ${next}`]
    }
  }
  return unknown(cmd)
}
