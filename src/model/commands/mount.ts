// mount.*: the horse a rider sits on (Ship). The unit's companion is written by Ship alongside, in units.json.
import type { Command } from '../command-types.ts'
import type { Character, Mount } from '../types.ts'
import { bad, list, missing, names, num, obj, opt, patchOf, quat, record, same, str, unknown, vec3, vecText, type Obj } from './common.ts'

export type MountCommand = Extract<Command, { type: `mount.${string}` }>

const FIELDS = ['character', 'bone', 'position', 'rotation', 'scale', 'freeze', 'pose', 'hips', 'skin', 'gear']

function mountOf (c: Character, v: unknown): Mount {
  const m = obj(v, 'mount')
  const horse = str(m.character, 'mount.character')
  if (horse === c.id) bad("A character can't ride itself")
  const scale = opt(m.scale, x => num(x, 'mount.scale', { above: 0 }))
  const hips = opt(m.hips, x => vec3(x, 'mount.hips'))
  const skin = opt(m.skin, x => str(x, 'mount.skin'))
  const gear = opt(m.gear, x => list(x, 'mount.gear', str))
  return {
    character: horse, bone: str(m.bone, 'mount.bone'), position: vec3(m.position, 'mount.position'), rotation: vec3(m.rotation, 'mount.rotation'),
    ...(scale !== undefined ? { scale } : {}), freeze: list(m.freeze ?? [], 'mount.freeze', str), pose: record(m.pose ?? {}, 'mount.pose', quat),
    ...(hips !== undefined ? { hips } : {}), ...(skin !== undefined ? { skin } : {}), ...(gear !== undefined ? { gear } : {}),
  }
}

function changes (was: Mount, now: Mount): string[] {
  const out: string[] = []
  for (const k of FIELDS as Array<keyof Mount>) {
    if (same(was[k], now[k])) continue
    const v = now[k]
    if (k === 'pose') out.push(`mount: seat pose of ${names(Object.keys(now.pose).filter(b => !same(was.pose[b], now.pose[b])))}`)
    else if (v === undefined) out.push(`mount: ${k} unset`)
    else if (k === 'position' || k === 'rotation' || k === 'hips') out.push(`mount: ${k} ${vecText(v as number[])}`)
    else out.push(`mount: ${k} ${Array.isArray(v) ? names(v as string[]) || 'none' : String(v)}`)
  }
  return out
}

export function reduceMount (c: Character, cmd: MountCommand): string[] {
  switch (cmd.type) {
    case 'mount.set': {
      const next = cmd.mount === null ? null : mountOf(c, cmd.mount)
      const was = c.mount
      if (same(was ?? null, next)) return []
      if (next === null) { delete c.mount; return ['mount: on foot'] }
      c.mount = next
      return was === undefined || was.character !== next.character ? [`mount: rides ${next.character} on its ${next.bone}`] : changes(was, next)
    }
    case 'mount.update': {
      const was = c.mount ?? missing('It rides nothing yet; give it a mount first')
      const patch = patchOf(cmd.patch, FIELDS)
      const merged: Obj = { ...was }
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete merged[k]
        else if (v !== undefined) merged[k] = v
      }
      const next = mountOf(c, merged)
      if (same(was, next)) return []
      c.mount = next
      return changes(was, next)
    }
  }
  return unknown(cmd)
}
