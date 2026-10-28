// Runtime verification of the named library, using the same loader and retargeter as the app: every clip (or one)
// loaded and retargeted onto Y Bot and onto a local character, then every clip a character's slots play retargeted
// onto Y Bot as its slot asks (in place or moving). Writes a report under workspace/library/verify/.
// node tools/library_verify.ts [--clip <library-id>] [--character <character-id>]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { captureRest, retarget } from '../src/engine/retarget.ts'
import type { Character } from '../src/model/types.ts'
import { character as readCharacter, isBone, load, WORKSPACE as workspace } from './lib/node3d.ts'

const lib = path.join(workspace, 'library')
const out = path.join(lib, 'verify')
mkdirSync(out, { recursive: true })
interface Clip { id: string, name: string, file: string, source: string, motionId?: string, inPlace?: boolean }
const manifest = JSON.parse(readFileSync(path.join(lib, 'manifest.json'), 'utf8')) as { clips: Clip[], catalog: { complete: boolean, count: number } }
const catalog = manifest.clips.filter(c => c.source === 'mixamo-catalog')
if (!manifest.catalog?.complete || catalog.length !== manifest.catalog.count) throw new Error('Catalog is incomplete')
function option (name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return value
}
const selectedId = option('--clip')
const selectedCharacter = option('--character')
const checked = selectedId === undefined ? manifest.clips : manifest.clips.filter(c => c.id === selectedId)
if (checked.length === 0) throw new Error(`Unknown clip ${selectedId}`)
const target = await load(path.join(lib, 'mannequin/ybot.glb'))
const rest = captureRest(target.scene, isBone)
const characterDir = path.join(workspace, 'characters')
// (read as schema 2, however old the file)
const characters: Character[] = existsSync(characterDir)
  ? readdirSync(characterDir).filter(id => existsSync(path.join(characterDir, id, 'character.json'))).map(id => readCharacter(id))
  : []
const character = selectedCharacter === undefined
  ? characters.find(c => c.skeleton.template === 'human' && c.clips.length > 0 && (c.files.rigged ?? c.files.model) !== undefined)
  : characters.find(c => c.id === selectedCharacter)
if (selectedCharacter !== undefined && !character) throw new Error(`Unknown character ${selectedCharacter}`)
const own = character?.files.rigged ?? character?.files.model
const actual = character !== undefined && own !== undefined ? await load(path.join(characterDir, character.id, own)) : null
const actualRest = actual ? captureRest(actual.scene, isBone) : null
const failures: Array<{ id: string, error: string }> = []
let count = 0
for (const item of checked) {
  try {
    const source = await load(path.join(lib, item.file))
    const clip = source.animations[0]
    if (source.animations.length !== 1 || clip.name !== item.name) throw new Error('Wrong animation name/count')
    if (!clip.validate() || clip.tracks.some(t => [...t.values, ...t.times].some(v => !Number.isFinite(v)))) throw new Error('Invalid source keys')
    const sourceRest = captureRest(source.scene, isBone)
    for (const targetRest of [rest, ...(actualRest ? [actualRest] : [])]) {
      const baked = retarget(source.scene, sourceRest, clip, targetRest, { samples: 9, inPlace: false })
      if (!baked.validate() || baked.tracks.some(t => [...t.values, ...t.times].some(v => !Number.isFinite(v)))) throw new Error('Invalid retargeted keys')
      if (baked.tracks.length < 20) throw new Error('Missing retargeted bone tracks')
    }
  } catch (error) { failures.push({ id: item.id, error: String(error) }) }
  if (++count % 250 === 0) console.log(`Loaded/retargeted ${count}/${checked.length}; failures ${failures.length}`)
}

// The clips characters play, as their slots ask for them (the generic export sample these were once written into is
// gone with the generic export: the game's units are built and checked by tools/lib/unit_export.ts).
const played = new Map<string, { clip: string, inPlace: boolean, name: string }>()
if (selectedId !== undefined) {
  const item = checked[0]
  played.set(`${item.id}|${item.inPlace === true}`, { clip: item.id, inPlace: item.inPlace ?? false, name: item.name })
} else {
  for (const ch of characters) for (const s of ch.clips) if (s.clip.url === undefined) played.set(`${s.clip.id}|${s.inPlace}`, { clip: s.clip.id, inPlace: s.inPlace, name: `${ch.name} ${s.name}` })
}
const byId = new Map(manifest.clips.map(c => [c.id, c]))
const slotClips: string[] = []
for (const entry of played.values()) {
  const item = byId.get(entry.clip)
  if (item === undefined) { failures.push({ id: entry.clip, error: `played by ${entry.name}, not in the library` }); continue }
  try {
    const source = await load(path.join(lib, item.file))
    const baked = retarget(source.scene, captureRest(source.scene, isBone), source.animations[0], rest, { fps: 30, inPlace: entry.inPlace })
    if (!baked.validate() || baked.tracks.some(t => [...t.values, ...t.times].some(v => !Number.isFinite(v)))) throw new Error('Invalid retargeted keys')
    slotClips.push(entry.clip)
  } catch (error) { failures.push({ id: entry.clip, error: `played by ${entry.name}: ${String(error)}` }) }
}
const report = { checkedAt: new Date().toISOString(), clips: checked.length, targets: ['Y Bot', ...(character ? [character.name] : [])],
  failures, savedCharacters: characters.filter(c => c.clips.length > 0).length, slotClips }
writeFileSync(path.join(out, selectedId === undefined ? 'named-runtime.json' : `${selectedId}-runtime.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exitCode = 1
