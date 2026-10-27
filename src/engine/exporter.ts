// Build a game-ready GLB: the character in its bind pose plus its animation set, baked onto its skeleton.
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { AnimationEntry, Character } from '../../server/workspace.ts'
import { CharacterView } from './CharacterView.ts'
import type { RetargetCache } from './clips.ts'
import { addLods } from './export/lods.ts'
import { bakeEntry } from './animation.ts'
import { attachProps, type PropAttachment } from './props.ts'
import { attachGarments } from './garments.ts'
import { renamer } from './presets/skeletonMap.ts'

export interface ExportOptions {
  boneNames: 'mixamo' | 'mixamorig'
  /** Longest texture side in pixels; null keeps the original. */
  textureSize: number | null
  imageFormat: 'png' | 'jpeg'
  /** Append "-loop" to looping clips so Godot imports them with looping on. */
  loopSuffix: boolean
  fps: number
  /** Distance LOD levels to add (0-3): simplified copies at 50 / 25 / 12% of the triangles. */
  lods: number
}

export const DEFAULT_EXPORT: ExportOptions = { boneNames: 'mixamo', textureSize: 2048, imageFormat: 'png', loopSuffix: true, fps: 30, lods: 3 }

export function clipName (entry: AnimationEntry, options: ExportOptions): string {
  const base = entry.name.trim() || 'Animation'
  return entry.loop && options.loopSuffix && !/-loop$/i.test(base) ? `${base}-loop` : base
}

/** Build every export from saved data, with the same outfit whether or not the character is selected. */
export async function loadExportView (character: Character, urlFor: (file: string | undefined) => string | null, includeProps = true): Promise<CharacterView> {
  const url = urlFor(character.files.rigged)
  if (url === null) throw new Error(`${character.name} is not rigged`)
  const view = await CharacterView.load(url)
  view.setRename(renamer(character.boneMap))
  if (includeProps) await attachProps(view, (character.props ?? []) as PropAttachment[])
  await attachGarments(view, character.garments ?? [], g => urlFor(g.file) ?? '')
  return view
}

export async function exportCharacter (view: CharacterView, entries: AnimationEntry[], cache: RetargetCache, urlFor: (entry: AnimationEntry) => string, options: ExportOptions,
  character: Pick<Character, 'animations' | 'scripts' | 'garments'>): Promise<Blob> {
  // Clone with the real materials, not whatever display mode the viewport is in.
  const mode = view.displayMode
  view.setMode('shaded')
  const root = cloneSkinned(view.root)
  view.setMode(mode)
  // The live character may be mid-animation: put the copy back in its bind pose.
  if (view.rest !== null) {
    root.traverse(o => {
      const rest = view.rest!.bones.get(o.name)
      if (rest !== undefined && (o as THREE.Bone).isBone) {
        o.position.copy(rest.localPosition)
        o.quaternion.copy(rest.localQuaternion)
        o.scale.copy(rest.localScale)
      }
    })
  }
  // Own materials so export tweaks never touch the viewport.
  root.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    if (mesh.geometry.attributes.color !== undefined && !view.hadVertexColors.has(mesh.geometry)) {
      mesh.geometry = mesh.geometry.clone()
      mesh.geometry.deleteAttribute('color')
    }
    const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(m => {
      const copy = m.clone()
      const map = (copy as THREE.MeshStandardMaterial).map
      if (map !== null && map !== undefined) {
        const texture = map.clone()
        texture.userData = { ...texture.userData, mimeType: options.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png' }
        ;(copy as THREE.MeshStandardMaterial).map = texture
      }
      return copy
    })
    mesh.material = Array.isArray(mesh.material) ? materials : materials[0]
  })

  await addLods(root, options.lods ?? 0, view.height)

  const animations: THREE.AnimationClip[] = []
  const used = new Set<string>()
  for (const entry of entries) {
    const { clip: baked } = await bakeEntry(character, view, cache, root, entry, { fps: options.fps, urlFor })
    let name = clipName(entry, options)
    for (let i = 2; used.has(name); i++) name = `${clipName(entry, options)} ${i}`
    used.add(name)
    const animation = baked.clone()
    animation.name = name
    animations.push(animation)
  }

  const exporter = new GLTFExporter()
  const result = await exporter.parseAsync(root, {
    binary: true,
    animations,
    onlyVisible: false,
    maxTextureSize: options.textureSize ?? Infinity,
  }) as ArrayBuffer
  const glb = options.boneNames === 'mixamorig' ? renameNodes(result, name => isMixamoBone(name) ? `mixamorig:${name}` : name) : result
  return new Blob([glb], { type: 'model/gltf-binary' })
}

const BONE = /^(Hips|Spine\d?|Neck|Head(Top_End)?|(Left|Right)(Shoulder|Arm|ForeArm|Hand\w*|UpLeg|Leg|Foot|ToeBase|Toe_End))$/
function isMixamoBone (name: string): boolean { return BONE.test(name) }

/** Rename glTF nodes inside a GLB (names live only in the JSON chunk). */
export function renameNodes (glb: ArrayBuffer, rename: (name: string) => string): ArrayBuffer {
  const view = new DataView(glb)
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))) as { nodes?: Array<{ name?: string }> }
  for (const node of json.nodes ?? []) if (node.name !== undefined) node.name = rename(node.name)
  let text = JSON.stringify(json)
  while (new TextEncoder().encode(text).length % 4 !== 0) text += ' '
  const jsonBytes = new TextEncoder().encode(text)
  const rest = new Uint8Array(glb, 20 + jsonLength)
  const out = new Uint8Array(20 + jsonBytes.length + rest.length)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, 0x46546c67, true)
  outView.setUint32(4, 2, true)
  outView.setUint32(8, out.length, true)
  outView.setUint32(12, jsonBytes.length, true)
  outView.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  out.set(rest, 20 + jsonBytes.length)
  return out.buffer
}
