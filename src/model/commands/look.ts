// look.*: switching, removing and ordering texture layers. Layers are added by the look routes' jobs (fill, keep);
// the server recomposes the texture after any of these. A removed layer's file stays (an undo brings it back). Also a
// dynamic character's skins and clothes: look.skins.set and look.clothes.set (schema 4's, the old UI's) keep the folk
// pools and cloth layers in step (src/model/folk.ts); look.cloth.* edit the cloth layers (schema 5), look.skin.bare a
// skin's bare version.
import type { Command } from '../command-types.ts'
import type { Character, Skin, TextureLayer } from '../types.ts'
import { syncLegacyClothes, syncLegacySkins } from '../folk.ts'
import { bad, bool, conflict, list, missing, note, num, obj, opt, patchOf, reorder, str, under, unknown } from './common.ts'
import { clothLayerOf, patchCloth, pruneCloth } from './folk.ts'
import { tagsOf } from './gear.ts'

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
    case 'look.skins.set': {
      const skins = list(cmd.skins, 'skins', skinOf)
      if (new Set(skins.map(s => s.name)).size !== skins.length) bad('Skin names repeat')
      // (a skin given again without its bare version keeps the one it had: a Look job made it)
      for (const k of skins) {
        const bare = (look.skins ?? []).find(s => s.name === k.name)?.bare
        if (k.bare === undefined && bare !== undefined) k.bare = bare
      }
      look.skins = skins.length > 0 ? skins : undefined
      if (look.skins === undefined) delete look.skins
      if (look.skin !== undefined && !skins.some(s => s.name === look.skin)) delete look.skin
      syncLegacySkins(c)
      return [`skins: ${skins.length}`]
    }
    case 'look.skin.bare': {
      const k = (look.skins ?? []).find(s => s.name === cmd.name) ?? missing(`No skin ${String(cmd.name)}`)
      const file = cmd.file === null ? undefined : under(cmd.file, '', 'file')
      if (file === k.bare) return []
      if (file === undefined) delete k.bare
      else k.bare = file
      return [`skin ${k.name}: ${file === undefined ? 'no bare version' : 'a bare version'}`]
    }
    case 'look.cloth.add': {
      const l = clothLayerOf(cmd.layer, 'layer')
      const cloth = look.cloth ?? []
      if (cloth.some(x => x.id === l.id)) conflict(`Cloth layer id ${l.id} is taken`)
      const at = cmd.index === undefined ? cloth.length : Math.min(Math.floor(num(cmd.index, 'index', { min: 0 })), cloth.length)
      cloth.splice(at, 0, l)
      look.cloth = cloth
      return [`cloth ${l.name}: added (${l.slots.join(', ')})`]
    }
    case 'look.cloth.update': {
      const l = (look.cloth ?? []).find(x => x.id === cmd.id) ?? missing(`No cloth layer ${cmd.id}`)
      return patchCloth(l, cmd.patch)
    }
    case 'look.cloth.remove': {
      const l = (look.cloth ?? []).find(x => x.id === cmd.id) ?? missing(`No cloth layer ${cmd.id}`)
      look.cloth = look.cloth!.filter(x => x !== l)
      if (look.cloth.length === 0) delete look.cloth
      return [`cloth ${l.name}: removed`, ...pruneCloth(c, l.id)]
    }
    case 'look.cloth.reorder': {
      const cloth = look.cloth ?? missing('No cloth layers')
      const next = reorder(cloth, cmd.ids, 'cloth layer')
      if (next.every((l, i) => l === cloth[i])) return []
      look.cloth = next
      return [`cloth layers reordered: ${next.map(l => l.name).join(', ')}`]
    }
    case 'look.skin.show': {
      const next = cmd.name === null ? undefined : str(cmd.name, 'name')
      if (next !== undefined && !(look.skins ?? []).some(s => s.name === next)) missing(`No skin ${next}`)
      if (next === look.skin) return []
      if (next === undefined) delete look.skin
      else look.skin = next
      return [next === undefined ? 'skin: its own' : `skin ${next} shown`]
    }
    case 'look.clothes.set': {
      const clothes = list(cmd.clothes, 'clothes', skinOf)
      if (new Set(clothes.map(s => s.name)).size !== clothes.length) bad('Clothes names repeat')
      if (clothes.length > 0) look.clothes = clothes
      else delete look.clothes
      if (look.clothing !== undefined && !clothes.some(s => s.name === look.clothing)) delete look.clothing
      syncLegacyClothes(c)
      return [`clothes: ${clothes.length}`]
    }
    case 'look.clothing.show': {
      const next = cmd.name === null ? undefined : str(cmd.name, 'name')
      if (next !== undefined && !(look.clothes ?? []).some(s => s.name === next)) missing(`No clothes ${next}`)
      if (next === look.clothing) return []
      if (next === undefined) delete look.clothing
      else look.clothing = next
      return [next === undefined ? 'clothes: the skin\'s own' : `clothes ${next} shown`]
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

function skinOf (v: unknown, what: string): Skin {
  const o = obj(v, what)
  const hair = opt(o.hair, x => (typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x) ? x.toLowerCase() : bad(`${what}.hair must be #rrggbb`)))
  const tags = opt(o.tags, x => tagsOf(x, `${what}.tags`))
  const bare = opt(o.bare, x => under(x, '', `${what}.bare`))
  return {
    name: str(o.name, `${what}.name`), file: under(o.file, '', `${what}.file`),
    ...(hair !== undefined ? { hair } : {}), ...(tags !== undefined && tags.length > 0 ? { tags } : {}), ...(bare !== undefined ? { bare } : {}),
  }
}
