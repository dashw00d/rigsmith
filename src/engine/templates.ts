// The skeleton families a character can be built on (DESIGN.md §0.3): the human (Mixamo) and the creature templates
// taken from Mesh2Motion's rigs (static/templates/<id>.json, made by tools/extract_templates.py). Human and horse are
// supported; the others stay as data, offered under "Other creatures" as experimental (no marker set, no deformation
// tests, plain heat weights).
//
// A joint's side and mirror partner come from its name (Left/Right before it, _l/_r, _L/_R, .L/.R after it, or _l_
// inside), which agrees with every template's own mirror map (templates.test.ts checks), so a skeleton's spec needs
// no template file loaded.
import * as THREE from 'three'
import { hierarchyOf, type Hierarchy } from '../model/skeletons.ts'
import type { Joints, SkeletonSection } from '../model/types.ts'
import { prettyBone } from './mixamo.ts'

export interface TemplateInfo {
  id: string
  label: string
  status: 'supported' | 'experimental'
  /** It has a marker set (static/templates/markers.json): the marker board places it. */
  markers: boolean
  /** It has deformation tests (static/templates/tests.json): the Skin step checks its weights on them. */
  tests: boolean
}

export const TEMPLATES: readonly TemplateInfo[] = [
  { id: 'human', label: 'Person', status: 'supported', markers: true, tests: true },
  { id: 'horse', label: 'Horse', status: 'supported', markers: true, tests: true },
  { id: 'fox', label: 'Fox', status: 'experimental', markers: false, tests: false },
  { id: 'bird', label: 'Bird', status: 'experimental', markers: false, tests: false },
  { id: 'dragon', label: 'Dragon', status: 'experimental', markers: false, tests: false },
  { id: 'kaiju', label: 'Kaiju', status: 'experimental', markers: false, tests: false },
  { id: 'spider', label: 'Spider', status: 'experimental', markers: false, tests: false },
  { id: 'snake', label: 'Snake', status: 'experimental', markers: false, tests: false },
  { id: 'shark', label: 'Fish', status: 'experimental', markers: false, tests: false },
]

/** A template's entry; one this build doesn't list (a character from a newer one) counts as experimental. */
export function templateInfo (id: string): TemplateInfo {
  return TEMPLATES.find(t => t.id === id) ?? { id, label: id.charAt(0).toUpperCase() + id.slice(1), status: 'experimental', markers: false, tests: false }
}

/** "person", "horse": a template's name in a sentence. */
export const templateName = (id: string): string => templateInfo(id).label.toLowerCase()

/** A creature template's file. */
export interface Template {
  id: string
  label: string
  joints: Joints
  parents: Record<string, string | null>
  order: string[]
  mirror: Record<string, string>
  meshBox: [[number, number, number], [number, number, number]]
  animations: string
}

const cache = new Map<string, Promise<Template>>()

export async function loadTemplate (id: string): Promise<Template> {
  let pending = cache.get(id)
  if (pending === undefined) {
    pending = fetch(`./templates/${id}.json`).then(async r => {
      if (!r.ok) throw new Error(`No template ${id}`)
      return await r.json() as Template
    })
    // (a failed load is tried again next time)
    pending.catch(() => { cache.delete(id) })
    cache.set(id, pending)
  }
  return await pending
}

/** Place the template's joints inside a model by mapping the template mesh's bounds onto the model's: the fit the
 * server falls back to when the mesh doesn't read as that body (or the fit along it isn't installed). */
export function fitTemplate (template: Template, box: THREE.Box3): Joints {
  const [lo, hi] = template.meshBox
  const out: Joints = {}
  const size = box.getSize(new THREE.Vector3())
  for (const [name, p] of Object.entries(template.joints)) {
    const t = [0, 1, 2].map(i => (p[i] - lo[i]) / Math.max(hi[i] - lo[i], 1e-6))
    out[name] = [box.min.x + t[0] * size.x, box.min.y + t[1] * size.y, box.min.z + t[2] * size.z]
  }
  // Keep the symmetry plane exactly at the model's center.
  const cx = (box.min.x + box.max.x) / 2
  for (const [a, b] of Object.entries(template.mirror)) {
    if (out[a] !== undefined && out[b] !== undefined && a < b) {
      const avg = ((out[a][0] - cx) - (out[b][0] - cx)) / 2
      out[a][0] = cx + avg
      out[b][0] = cx - avg
    }
  }
  for (const name of template.order) if (template.mirror[name] === undefined && out[name] !== undefined) out[name][0] = cx
  return out
}

// ---- sides --------------------------------------------------------------------------------------------------------

export type JointSide = 'left' | 'right' | 'center'

const SUFFIX: Array<[RegExp, string]> = [
  [/_l$/, '_r'], [/_r$/, '_l'], [/_L$/, '_R'], [/_R$/, '_L'], [/\.L$/, '.R'], [/\.R$/, '.L'], [/\.l$/, '.r'], [/\.r$/, '.l'],
]
const INFIX: Array<[string, string]> = [['_l_', '_r_'], ['_r_', '_l_'], ['_L_', '_R_'], ['_R_', '_L_']]

/** The name with its side swapped (LeftHand -> RightHand, wing_1_L -> wing_1_R), or the name itself. */
export function swapSide (name: string): string {
  if (name.startsWith('Left')) return `Right${name.slice(4)}`
  if (name.startsWith('Right')) return `Left${name.slice(5)}`
  for (const [from, to] of SUFFIX) if (from.test(name)) return name.replace(from, to)
  for (const [from, to] of INFIX) if (name.includes(from)) return name.replace(from, to)
  return name
}

/** A joint's partner on the other side among `names`, or itself (a joint of the middle line). */
export function mirrorOf (name: string, names: ReadonlySet<string>): string {
  const other = swapSide(name)
  return other !== name && names.has(other) ? other : name
}

const LEFT = /(_l|_L|\.L|\.l)$|_l_|_L_|^Left/

export function sideOf (name: string, names: ReadonlySet<string>): JointSide {
  if (mirrorOf(name, names) === name) return 'center'
  return LEFT.test(name) ? 'left' : 'right'
}

/** What the joint editor needs to know about a skeleton: its bones, their sides and mirror partners. */
export interface SkeletonSpec {
  bones: Hierarchy
  side: (name: string) => JointSide
  mirror: (name: string) => string
}

/** A character's skeleton as the joint editor and the marker board draw it (src/model/skeletons.ts hierarchyOf). */
export function skeletonSpec (c: { skeleton: Pick<SkeletonSection, 'template' | 'fingerLevel' | 'detected' | 'overrides'> }): SkeletonSpec {
  const bones = hierarchyOf(c)
  const names = new Set(bones.map(([b]) => b))
  return { bones, side: name => sideOf(name, names), mirror: name => mirrorOf(name, names) }
}

/** A joint's name for people: "Forearm", "Index 2" for the human; "Front leg upper" for a creature's front_leg_upper_l
 * (the side is shown apart). */
export function jointLabel (name: string): string {
  if (!/_/.test(name) && /^[A-Z]/.test(name)) return prettyBone(name)
  const bare = name.replace(/(_l|_r|_L|_R|\.L|\.R|\.l|\.r)$/, '').replace(/_(l|r|L|R)_/, '_').replace(/[_.]+/g, ' ').trim()
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

/** Joint chip groups for a creature: the middle line's joints, then one side's limbs, each a chain from where it leaves
 * the body, named by what its joints' names share ("Back leg", "Wing", "Ear"). */
export function creatureGroups (bones: Hierarchy, side: 'left' | 'right' = 'left'): Array<{ label: string, bones: string[] }> {
  const names = new Set(bones.map(([b]) => b))
  const parent = new Map(bones)
  const body: string[] = []
  const limbs = new Map<string, string[]>()
  for (const [bone] of bones) {
    if (bone === 'root') continue
    const s = sideOf(bone, names)
    if (s === 'center') { body.push(bone); continue }
    if (s !== side) continue
    // (the chain's first joint off the middle line)
    let top = bone
    for (let p = parent.get(top) ?? null; p !== null && sideOf(p, names) === side; p = parent.get(p) ?? null) top = p
    limbs.set(top, [...(limbs.get(top) ?? []), bone])
  }
  const out = body.length > 0 ? [{ label: 'Body', bones: body }] : []
  for (const [top, chain] of limbs) out.push({ label: shared(chain) ?? jointLabel(top), bones: chain })
  return out
}

/** The words every joint label of a chain starts with, if any. */
function shared (chain: string[]): string | null {
  const words = chain.map(j => jointLabel(j).toLowerCase().split(' '))
  const common: string[] = []
  for (let i = 0; words.every(w => w.length > i + 1 && w[i] === words[0][i]) && !/^\d/.test(words[0][i]); i++) common.push(words[0][i])
  if (common.length === 0) return null
  const label = common.join(' ')
  return label.charAt(0).toUpperCase() + label.slice(1)
}
