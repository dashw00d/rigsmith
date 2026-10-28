// skin.*: the weight lock. While locked the server refuses whatever would change the body's weights (a re-rig,
// painting, the optimizer); the rig report, painted count and rig joints are the rig job's.
import type { Command } from '../command-types.ts'
import type { Character } from '../types.ts'
import { bad, bool, unknown } from './common.ts'

export type SkinCommand = Extract<Command, { type: `skin.${string}` }>

export function reduceSkin (c: Character, cmd: SkinCommand): string[] {
  switch (cmd.type) {
    case 'skin.lock': {
      const locked = bool(cmd.locked, 'locked')
      const given = cmd.reason === undefined || cmd.reason === null ? undefined
        : typeof cmd.reason === 'string' ? cmd.reason.trim() || undefined : bad('reason must be text')
      // (locked again without a reason: it keeps the one it has)
      const reason = locked ? given ?? (c.skin.locked ? c.skin.lockReason : undefined) : undefined
      if (locked === c.skin.locked && reason === c.skin.lockReason) return []
      c.skin.locked = locked
      if (reason === undefined) delete c.skin.lockReason
      else c.skin.lockReason = reason
      return [locked ? `skin: locked${reason !== undefined ? ` (${reason})` : ''}` : 'skin: unlocked']
    }
  }
  return unknown(cmd)
}
