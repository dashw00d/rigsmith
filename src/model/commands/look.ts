// look.*: switching, removing and ordering texture layers. Layers are added by the look routes' jobs (fill, keep);
// the server recomposes the texture after any of these. A removed layer's file stays (an undo brings it back).
import type { Command } from '../command-types.ts'
import type { Character, TextureLayer } from '../types.ts'
import { bool, missing, note, patchOf, reorder, unknown } from './common.ts'

export type LookCommand = Extract<Command, { type: `look.${string}` }>

const layerText = (l: TextureLayer): string => `layer ${l.kind} on ${l.image}`

export function reduceLook (c: Character, cmd: LookCommand): string[] {
  const look = c.look
  switch (cmd.type) {
    case 'look.layer.update': {
      const l = look.layers.find(x => x.id === cmd.id) ?? missing(`No layer ${cmd.id}`)
      const p = patchOf(cmd.patch, ['enabled', 'note'])
      const out: string[] = []
      if (p.enabled !== undefined) {
        const enabled = bool(p.enabled, 'enabled')
        if (enabled !== l.enabled) { l.enabled = enabled; out.push(`${layerText(l)}: ${enabled ? 'on' : 'off'}`) }
      }
      if (p.note !== undefined) {
        const next = note(p.note, 'note')
        if (next !== l.note) {
          if (next === undefined) delete l.note
          else l.note = next
          out.push(`${layerText(l)}: note ${next === undefined ? 'cleared' : 'changed'}`)
        }
      }
      return out
    }
    case 'look.layer.remove': {
      const l = look.layers.find(x => x.id === cmd.id) ?? missing(`No layer ${cmd.id}`)
      look.layers = look.layers.filter(x => x !== l)
      return [`${layerText(l)}: removed`]
    }
    case 'look.layer.reorder': {
      const next = reorder(look.layers, cmd.ids, 'layer')
      if (next.every((l, i) => l === look.layers[i])) return []
      look.layers = next
      return [`layers reordered: ${next.map(l => `${l.kind} on ${l.image}`).join(', ')} (bottom to top)`]
    }
  }
  return unknown(cmd)
}
