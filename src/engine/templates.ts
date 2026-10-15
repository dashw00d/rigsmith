// Skeleton templates for non-humanoid characters (from Mesh2Motion's creature rigs, see tools/extract_templates.py).
import * as THREE from 'three'
import type { Joints } from './JointEditor.ts'

export interface Template {
  id: string
  label: string
  joints: Record<string, [number, number, number]>
  parents: Record<string, string | null>
  order: string[]
  mirror: Record<string, string>
  meshBox: [[number, number, number], [number, number, number]]
  animations: string
}

export const BODY_TYPES: Array<{ id: string, label: string }> = [
  { id: 'human', label: 'Humanoid' },
  { id: 'horse', label: 'Horse' },
  { id: 'fox', label: 'Fox' },
  { id: 'bird', label: 'Bird' },
  { id: 'dragon', label: 'Dragon' },
  { id: 'kaiju', label: 'Kaiju' },
  { id: 'spider', label: 'Spider' },
  { id: 'snake', label: 'Snake' },
  { id: 'shark', label: 'Fish' },
]

const cache = new Map<string, Promise<Template>>()

export async function loadTemplate (id: string): Promise<Template> {
  let pending = cache.get(id)
  if (pending === undefined) {
    pending = fetch(`./templates/${id}.json`).then(async r => {
      if (!r.ok) throw new Error(`No template ${id}`)
      return await r.json() as Template
    })
    cache.set(id, pending)
  }
  return await pending
}

/** Place the template's joints inside a model by mapping the template mesh's bounds onto the model's. */
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
  for (const name of template.order) if (template.mirror[name] === undefined) out[name][0] = cx
  return out
}

export function templateSide (template: Template, name: string): 'left' | 'right' | 'center' {
  if (template.mirror[name] === undefined) return 'center'
  return /(_l|_L|\.L|\.l)$|_l_|_L_|^Left/.test(name) ? 'left' : 'right'
}
