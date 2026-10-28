import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT, WORKSPACE } from './node3d.ts'

interface Motion { id: string, name: string, url?: string }

/** Rig stress tests plus a deterministic spread of library motions. The extra
 * clips are validation cases, not mandatory optimizer training poses. */
export function deformationTests (extended = false): Record<string, Motion[]> {
  const tests = JSON.parse(readFileSync(path.join(ROOT, 'static/templates/tests.json'), 'utf8')) as Record<string, Motion[]>
  const file = path.join(WORKSPACE, 'library/manifest.json')
  if (!extended || !existsSync(file)) return tests
  const catalog = JSON.parse(readFileSync(file, 'utf8')) as { clips: Array<Motion & { category: string, source: string, duplicateOf?: string | null }> }
  for (const category of ['locomotion', 'combat', 'jump', 'crouch-prone', 'work', 'dance', 'sit-lie', 'climb']) {
    const pool = catalog.clips.filter(c => c.category === category && c.source === 'mixamo-catalog' && !c.duplicateOf && !tests.human.some(t => t.id === c.id)).sort((a,b) => a.id.localeCompare(b.id))
    for (const fraction of [1/3, 2/3]) {
      const c = pool[Math.floor(pool.length * fraction)]
      if (c !== undefined && !tests.human.some(t => t.id === c.id)) tests.human.push({ id: c.id, name: c.name })
    }
  }
  return tests
}
