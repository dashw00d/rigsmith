// Every change to a character, by whoever made it (the app, or a tool such as an agent's: the x-rigsmith-by header),
// in plain words: characters/<id>/journal.jsonl. So the designer and an agent can each read what the other did.
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AnimationEntry, Character, Garment } from './workspace.ts'
import { characterDir } from './workspace.ts'

/** `note`: a line someone wrote, not a change the server saw. */
export interface JournalEntry { at: string, by: string, changes: string[], note?: true }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const round = (v: number[] | undefined): string => (v ?? []).map(x => Math.round(x * 1000) / 1000).join(', ')

function entries (before: AnimationEntry[], after: AnimationEntry[]): string[] {
  const out: string[] = []
  const was = new Map(before.map(a => [a.name, a])); const now = new Map(after.map(a => [a.name, a]))
  for (const [name, a] of now) {
    const b = was.get(name)
    if (b === undefined) { out.push(`clip ${name}: added (${a.clipId})`); continue }
    if (b.clipId !== a.clipId) out.push(`clip ${name}: ${b.clipId} -> ${a.clipId}`)
    for (const k of ['speed', 'loop', 'inPlace', 'lift'] as const) if (!same(b[k], a[k])) out.push(`clip ${name}: ${k} ${String(b[k] ?? '-')} -> ${String(a[k] ?? '-')}`)
    for (const kind of ['bones', 'props'] as const) {
      const kb = b.keys?.[kind] ?? {}; const ka = a.keys?.[kind] ?? {}
      for (const t of new Set([...Object.keys(kb), ...Object.keys(ka)])) {
        if (same(kb[t], ka[t])) continue
        const nb = kb[t]?.length ?? 0; const na = ka[t]?.length ?? 0
        out.push(`clip ${name}: keys on ${t} ${nb === na ? `changed (${na})` : `${nb} -> ${na}`}${na > 0 ? ` at ${ka[t]!.map(k => Math.round(k.u * 100) + '%').join(', ')}` : ''}`)
      }
    }
    if (!same(b.note, a.note)) out.push(`clip ${name}: note changed`)
  }
  for (const name of was.keys()) if (!now.has(name)) out.push(`clip ${name}: removed`)
  if (out.length === 0 && !same(before.map(a => a.name), after.map(a => a.name))) out.push('clips reordered')
  return out
}

function garments (before: Garment[], after: Garment[]): string[] {
  const out: string[] = []
  const was = new Map(before.map(g => [g.id, g]))
  for (const g of after) {
    const b = was.get(g.id)
    if (b === undefined) { out.push(`gear ${g.name}: added (on ${g.bone})`); continue }
    if (b.bone !== g.bone) out.push(`gear ${g.name}: on ${b.bone} -> ${g.bone}`)
    if (!same(b.position, g.position) || !same(b.rotation, g.rotation) || b.scale !== g.scale) {
      out.push(`gear ${g.name}: placed at [${round(g.position)}], turned [${round(g.rotation)}], size ${g.scale}`)
    }
    if ((b.hidden === true) !== (g.hidden === true)) out.push(`gear ${g.name}: ${g.hidden === true ? 'hidden' : 'shown'}`)
    if (b.file !== g.file) out.push(`gear ${g.name}: new mesh`)
    if (b.mode !== g.mode) out.push(`gear ${g.name}: ${g.mode}`)
  }
  const now = new Set(after.map(g => g.id))
  for (const g of before) if (!now.has(g.id)) out.push(`gear ${g.name}: removed`)
  return out
}

/** What changed from `before` to `after`, in plain words. */
export function describe (before: Character | null, after: Character): string[] {
  if (before === null) return ['created']
  const out: string[] = []
  if (before.name !== after.name) out.push(`name: ${before.name} -> ${after.name}`)
  out.push(...entries(before.animations ?? [], after.animations ?? []))
  const sb = new Map((before.scripts ?? []).map(s => [s.id, s])); const sa = new Map((after.scripts ?? []).map(s => [s.id, s]))
  for (const [id, s] of sa) {
    const b = sb.get(id)
    const what = `script ${s.kind}${'clip' in s ? ` (${s.clip})` : ''}`
    if (b === undefined) out.push(`${what}: added`)
    else if (b.enabled !== s.enabled) out.push(`${what}: ${s.enabled ? 'on' : 'off'}`)
    else if (!same(b, s)) out.push(`${what}: ${Object.keys(s).filter(k => !same((b as unknown as Record<string, unknown>)[k], (s as unknown as Record<string, unknown>)[k])).map(k => `${k} -> ${JSON.stringify((s as unknown as Record<string, unknown>)[k])}`).join(', ')}`)
  }
  for (const [id, s] of sb) if (!sa.has(id)) out.push(`script ${s.kind}: removed`)
  out.push(...garments(before.garments ?? [], after.garments ?? []))
  if (!same(before.props, after.props)) out.push(`catalog props: ${(after.props ?? []).map(p => p.name).join(', ') || 'none'}`)
  if (!same(before.mount, after.mount)) {
    const b = before.mount; const a = after.mount
    if (a === undefined) out.push('mount: on foot')
    else if (b === undefined) out.push(`mount: rides ${a.character} on its ${a.bone}`)
    else {
      for (const k of Object.keys(a) as Array<keyof typeof a>) {
        if (same(b[k], a[k])) continue
        out.push(k === 'pose' ? `mount: seat pose of ${Object.keys(a.pose).filter(x => !same(b.pose[x], a.pose[x])).join(', ')}` : `mount: ${k} -> ${JSON.stringify(a[k])}`)
      }
    }
  }
  if (!same(before.skins, after.skins)) out.push(`skins: ${(after.skins ?? []).map(s => s.name).join(', ') || 'none'}`)
  if (!same(before.joints, after.joints)) out.push('joints moved')
  if (before.fingers !== after.fingers) out.push(`fingers: ${String(after.fingers)}`)
  if (!same(before.boneMap, after.boneMap)) out.push('bone map changed')
  if (before.status !== after.status) out.push(`status: ${after.status}`)
  return out
}

export async function record (id: string, by: string, before: Character | null, after: Character, extra: string[] = []): Promise<void> {
  const changes = [...describe(before, after), ...extra]
  if (changes.length === 0) return
  const entry: JournalEntry = { at: new Date().toISOString(), by, changes }
  await appendFile(path.join(characterDir(id), 'journal.jsonl'), JSON.stringify(entry) + '\n')
}

export async function journal (id: string, last = 100): Promise<JournalEntry[]> {
  try {
    const lines = (await readFile(path.join(characterDir(id), 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean)
    return lines.slice(-last).map(l => JSON.parse(l) as JournalEntry)
  } catch {
    return []
  }
}

/** A line of its own in the journal: a note someone wrote, or a change made outside a PATCH (an import). */
export async function note (id: string, by: string, text: string, written = false): Promise<void> {
  const entry: JournalEntry = { at: new Date().toISOString(), by, changes: [text], ...(written ? { note: true as const } : {}) }
  await appendFile(path.join(characterDir(id), 'journal.jsonl'), JSON.stringify(entry) + '\n')
}
