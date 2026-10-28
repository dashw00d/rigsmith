// What the tools share to read Rigsmith's files in node as the app reads them in the browser: three's loaders made to
// run headless (src/engine/headless.ts), the workspace, a character (read as schema 2, src/model/migrate.ts) and its
// body (src/engine/CharacterView.ts, as the viewer holds it), and clips retargeted onto it from files as the viewer's
// RetargetCache retargets them from urls (src/engine/clips.ts). Every function takes the workspace, the environment's
// by default.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { CharacterView } from '../../src/engine/CharacterView.ts'
import { clipUrl, isMixamoJoint, refUrl, type ClipSource, type SourceClip } from '../../src/engine/clips.ts'
import { loadGlbFile } from '../../src/engine/headless.ts'
import { captureRest, retarget, type RestSkeleton } from '../../src/engine/retarget.ts'
import { migrateSettings, readCharacter } from '../../src/model/migrate.ts'
import type { Character, Settings } from '../../src/model/types.ts'

export const ROOT = path.resolve(import.meta.dirname, '..', '..')
// (RIGSMITH_WORKSPACE: another workspace, as the server and the library tools take it)
export const WORKSPACE = path.resolve(process.env.RIGSMITH_WORKSPACE ?? path.join(ROOT, 'workspace'))

export const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true

export async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  return await loadGlbFile(file)
}

/** The file a clip's url names, as the app's server serves it: the library's (/files/library/..., converted clips and
 * creatures' saved ones) or one bundled with the app (/animations/<file>). The url's #name is not part of it. */
export function clipFile (url: string, workspace = WORKSPACE): string {
  const file = decodeURIComponent(url.split('#')[0])
  const [folder, rest] = file.startsWith('/files/library/') ? [path.join(workspace, 'library'), file.slice('/files/library/'.length)]
    : file.startsWith('/animations/') ? [path.join(ROOT, 'static', 'animations'), file.slice('/animations/'.length)]
      : [null, '']
  if (folder === null) throw new Error(`${url} is not a clip bundled with Rigsmith or in its library`)
  const at = path.join(folder, rest)
  if (!at.startsWith(folder + path.sep)) throw new Error(`${url} leaves its folder`)
  return at
}

/** Where an entry's clip comes from: a converted library clip by its id, or its url (bundled with the app, a creature's
 * saved clip). For tools that retarget by hand; the bake asks nodeClipSource. */
export async function entrySource (entry: { clipId: string, url?: string }, workspace = WORKSPACE): Promise<{ scene: THREE.Group, clip: THREE.AnimationClip }> {
  const url = entry.url ?? clipUrl(entry.clipId)
  const file = clipFile(url, workspace)
  if (!existsSync(file)) throw new Error(`clip ${entry.clipId}: ${entry.url === undefined ? 'not in the library' : `no file for ${entry.url}`}`)
  const src = await load(file)
  const hash = url.split('#')[1]
  const name = hash === undefined ? undefined : decodeURIComponent(hash)
  const clip = name === undefined ? src.animations[0] : src.animations.find(a => a.name === name)
  if (clip === undefined) throw new Error(`clip ${entry.clipId}: no ${name ?? 'animation'} in ${url}`)
  return { scene: src.scene, clip }
}

/** Clips retargeted onto `rest` from the workspace's files: what RetargetCache is in the browser (the same url for a
 * ref, the same source skeleton, the same retarget()), cached per clip and options. */
export function nodeClipSource (rest: RestSkeleton, workspace = WORKSPACE): ClipSource {
  const files = new Map<string, Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }>>()
  const sources = new Map<string, Promise<SourceClip>>()
  const retargeted = new Map<string, Promise<THREE.AnimationClip>>()
  // (as clips.ts loadSource: a file of several clips shares one scene, so each named clip poses a copy of its own)
  const source = async (url: string): Promise<SourceClip> => {
    const [file, hash] = url.split('#')
    let gltf = files.get(file)
    if (gltf === undefined) {
      const at = clipFile(file, workspace)
      if (!existsSync(at)) throw new Error(`no clip file for ${url}`)
      gltf = load(at)
      files.set(file, gltf)
      gltf.catch(() => files.delete(file))
    }
    const { scene, animations } = await gltf
    const name = hash === undefined ? undefined : decodeURIComponent(hash)
    const clip = name === undefined ? animations[0] : animations.find(a => a.name === name)
    if (clip === undefined) throw new Error(`No animation ${name ?? ''} in ${file}`)
    const root = name === undefined ? scene : cloneSkinned(scene)
    let hasBones = false
    root.traverse(o => { if (isBone(o)) hasBones = true })
    return { root, rest: captureRest(root, hasBones ? isBone : isMixamoJoint), clip }
  }
  return {
    async get (ref, o) {
      const url = refUrl(ref)
      const key = `${url}|${o.inPlace ? 1 : 0}|${o.mirror === true ? 1 : 0}|${o.fps ?? 30}`
      let clip = retargeted.get(key)
      if (clip === undefined) {
        let src = sources.get(url)
        if (src === undefined) {
          src = source(url)
          sources.set(url, src)
          src.catch(() => sources.delete(url))
        }
        clip = src.then(s => retarget(s.root, s.rest, s.clip, rest, o))
        retargeted.set(key, clip)
        clip.catch(() => retargeted.delete(key))
      }
      return await clip
    },
  }
}

/** A character's record (workspace/characters/<id>/character.json), as schema 2 whatever schema the file is. */
export function character (id: string, workspace = WORKSPACE): Character {
  const file = path.join(workspace, 'characters', id, 'character.json')
  if (!existsSync(file)) throw new Error(`no character ${id}`)
  return readCharacter(JSON.parse(readFileSync(file, 'utf8')))
}

/** The workspace's settings (the shared hand poses, the game repo). */
export function settings (workspace = WORKSPACE): Settings {
  const file = path.join(workspace, 'settings.json')
  return migrateSettings(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})
}

/** A character's rigged body, as the viewer holds it. */
export async function body (id: string, workspace = WORKSPACE): Promise<CharacterView> {
  const c = character(id, workspace)
  if (c.files.rigged === undefined) throw new Error(`${c.name} (${id}) is not rigged`)
  const { scene } = await load(path.join(workspace, 'characters', id, c.files.rigged))
  return new CharacterView(scene)
}
