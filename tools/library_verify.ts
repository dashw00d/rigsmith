// Runtime verification of the named library, using the same loader and retargeter as the app.
// node tools/library_verify.ts [--clip <library-id>] [--character <character-id>]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { captureRest, retarget } from '../src/engine/retarget.ts'

const root = path.resolve(import.meta.dirname, '..')
const workspace = process.env.RIGSMITH_WORKSPACE ?? path.join(root, 'workspace')
const lib = path.join(workspace, 'library')
const out = path.join(lib, 'verify')
mkdirSync(out, { recursive: true })
const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('textures omitted in skeleton verification') }
g.FileReader ??= class {
  result: ArrayBuffer | null = null
  onloadend: (() => void) | null = null
  readAsArrayBuffer (blob: Blob): void { void blob.arrayBuffer().then(b => { this.result = b; this.onloadend?.() }) }
}
const warn = console.warn
console.warn = (...args: unknown[]) => { if (!String(args[0]).includes('THREE.GLTFLoader: Couldn\'t load texture')) warn(...args) }
const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true
async function load (file: string) {
  const data = readFileSync(file)
  return await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '')
}
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
const characters = existsSync(characterDir) ? readdirSync(characterDir).flatMap(id => {
  const file = path.join(characterDir, id, 'character.json')
  return existsSync(file) ? [{ id, ...JSON.parse(readFileSync(file, 'utf8')) }] : []
}) : []
const character = selectedCharacter === undefined
  ? characters.find(c => c.template !== undefined ? c.template === 'human' : (c.animations?.length ?? 0) > 0)
  : characters.find(c => c.id === selectedCharacter)
if (selectedCharacter !== undefined && !character) throw new Error(`Unknown character ${selectedCharacter}`)
const actual = character ? await load(path.join(characterDir, character.id, character.files.rigged ?? character.files.model)) : null
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

const saved = new Map<string, { clipId: string, name: string, inPlace: boolean }>()
if (selectedId !== undefined) {
  const item = checked[0]
  saved.set(item.id, { clipId: item.id, name: item.name, inPlace: item.inPlace ?? false })
} else {
  for (const ch of characters) for (const entry of ch.animations ?? []) saved.set(entry.clipId, entry)
}
const exports: THREE.AnimationClip[] = []
const byId = new Map(manifest.clips.map(c => [c.id, c]))
for (const entry of saved.values()) {
  const item = byId.get(entry.clipId)
  if (!item) continue
  const source = await load(path.join(lib, item.file))
  const baked = retarget(source.scene, captureRest(source.scene, isBone), source.animations[0], rest, { fps: 30, inPlace: entry.inPlace })
  baked.name = entry.name
  exports.push(baked)
}
if (exports.length > 0) {
  const data = await new GLTFExporter().parseAsync(target.scene, { binary: true, animations: exports }) as ArrayBuffer
  writeFileSync(path.join(out, selectedId === undefined ? 'named-library-export.glb' : `${selectedId}-export.glb`), Buffer.from(data))
}
const report = { checkedAt: new Date().toISOString(), clips: checked.length, targets: ['Y Bot', ...(character ? [character.name] : [])],
  failures, savedCharacters: characters.filter(c => c.animations?.length > 0).length, exportClips: exports.map(c => c.name) }
writeFileSync(path.join(out, selectedId === undefined ? 'named-runtime.json' : `${selectedId}-runtime.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exitCode = 1
