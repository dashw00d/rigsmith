// Rigsmith from the command line: everything the app shows, readable, and the same changes the app makes, made through
// the same server (so open pages update at once and the journal says who did what). For the designer and an agent
// alike: the agent's changes are signed "agent" (RIGSMITH_BY overrides), the app's "app".
//
//   node tools/rig.ts list                              every character: its game unit, set, gear, mount
//   node tools/rig.ts show WHO [--json]                 all of one: its slots and clips (speed, loop, ground, keys),
//                                                       scripts, gear and where it sits, its mount, skins
//   node tools/rig.ts history WHO [N]                   its journal: every change, who made it, when (newest last)
//   node tools/rig.ts note WHO TEXT...                  a line in its journal (for the other one to read)
//   node tools/rig.ts get WHO [PATH]                    its raw record, or a part (animations.0.keys, mount.pose.Hips)
//   node tools/rig.ts set WHO FIELD JSON                one field, as the app saves it (null takes it off)
//   node tools/rig.ts slot WHO SLOT CLIP [speed=1] [loop|once] [inplace|moving]
//                                                       fill a slot (a name the game plays) with a library clip
//   node tools/rig.ts clips WHO QUERY [category]        the library's clips for its rig, by name
//   node tools/rig.ts ride WHO HORSE|off                put him on a horse with the app's default seat, or off it
//   node tools/rig.ts render WHO [clips=Idle,Walk] [at=0,.25,.5,.75] [views=right,front] [size=320] [out=DIR]
//                                                       pictures of its clips as the game file has them (Blender)
//   node tools/rig.ts check [UNIT ...]                  is each game unit's file what Rigsmith would build now?
//   node tools/rig.ts units                             Rigsmith's game units, and which differ from the game's
//   node tools/rig.ts unit NAME JSON|null               set one unit's entry (in Rigsmith: the game is untouched)
//   node tools/rig.ts export UNIT ...                   export units into the game (its units.json entry, its build)
//
// WHO: a character id, its name, or the game unit it is. Writes need the server (the app, port 5180). The game's repo is
// written by `export` alone.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AnimationEntry, Character, Mount, Settings } from '../server/workspace.ts'
import type { JournalEntry } from '../server/journal.ts'
import { describe as describeScript } from '../src/engine/scripts.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const WORKSPACE = path.resolve(process.env.RIGSMITH_WORKSPACE ?? path.join(ROOT, 'workspace'))
const SERVER = process.env.RIGSMITH_URL ?? 'http://127.0.0.1:5180'
const BY = process.env.RIGSMITH_BY ?? 'agent'

interface SpecUnit { character: string, height: number, clips: string[], draft?: boolean, companion?: { character: string, height: number, prefix: string, ridden?: boolean } }

function settings (): Settings {
  const file = path.join(WORKSPACE, 'settings.json')
  const own = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings> : {}
  return { gameRepo: path.join(homedir(), 'dev', 'games', 'emberhold'), ...own } as Settings
}
// Rigsmith's own units (server/game.ts): the game's repo is written only by an export
const specFile = (): string => path.join(WORKSPACE, 'game', 'units.json')
function spec (): Record<string, SpecUnit> {
  const f = specFile()
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { units: Record<string, SpecUnit> }).units : {}
}

function characters (): Character[] {
  const dir = path.join(WORKSPACE, 'characters')
  return readdirSync(dir).filter(d => existsSync(path.join(dir, d, 'character.json')))
    .map(d => JSON.parse(readFileSync(path.join(dir, d, 'character.json'), 'utf8')) as Character)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function resolve (who: string | undefined): Character {
  if (who === undefined) throw new Error('which character? (an id, a name or a game unit)')
  const all = characters()
  const units = spec()
  const id = units[who]?.character
  const found = all.find(c => c.id === who) ?? all.find(c => c.id === id) ?? all.filter(c => c.name.toLowerCase() === who.toLowerCase())
  if (Array.isArray(found)) {
    if (found.length === 1) return found[0]
    throw new Error(found.length === 0 ? `no character "${who}"` : `"${who}" is ${found.length} characters: ${found.map(c => c.id).join(', ')}`)
  }
  return found
}

/** The units a character is in the game: as the unit itself, or the companion (a horse) of each. */
interface UnitRole { unit: string, role: 'unit' | 'companion', u: SpecUnit }
function unitsOf (id: string): UnitRole[] {
  return Object.entries(spec()).flatMap(([unit, u]): UnitRole[] => u.character === id ? [{ unit, role: 'unit', u }] : u.companion?.character === id ? [{ unit, role: 'companion', u }] : [])
}

async function call<T> (method: string, url: string, body?: unknown): Promise<T> {
  let r: Response
  try {
    r = await fetch(SERVER + url, { method, headers: { 'content-type': 'application/json', 'x-rigsmith-by': BY }, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new Error(`Rigsmith's server is not running (${SERVER}): start it (rigsmith, or systemctl --user start rigsmith)`)
  }
  const text = await r.text()
  const data = text === '' ? null : JSON.parse(text) as unknown
  if (!r.ok) throw new Error((data as { error?: string } | null)?.error ?? `${r.status} ${r.statusText}`)
  return data as T
}
const patch = async (id: string, change: Partial<Record<keyof Character, unknown>>): Promise<Character> => await call<Character>('PATCH', `/api/characters/${id}`, change)

const r3 = (v: number[] | undefined): string => (v ?? []).map(x => +x.toFixed(3)).join(', ')
const pct = (u: number): string => `${Math.round(u * 100)}%`

function entryLine (a: AnimationEntry, height: number | null, ownHeight: number): string {
  const bits = [a.clipId, a.loop ? 'loop' : 'once', a.inPlace ? 'in place' : 'moving']
  if (a.speed !== 1) bits.push(`speed ${a.speed}`)
  if ((a.lift ?? 0) !== 0) bits.push(`ground ${height !== null ? `${+((a.lift ?? 0) * height / ownHeight * 100).toFixed(1)} cm` : `${+((a.lift ?? 0) / ownHeight * 100).toFixed(1)} %`}`)
  const keys = [...Object.entries(a.keys?.bones ?? {}), ...Object.entries(a.keys?.props ?? {})]
  if (keys.length > 0) bits.push(`keys ${keys.map(([n, k]) => `${n} (${k.map(x => pct(x.u)).join(' ')})`).join(', ')}`)
  return bits.join(' · ')
}

function show (c: Character): string {
  const out: string[] = []
  const own = c.stats?.height ?? 1
  out.push(`${c.name} (${c.id}) · ${c.status}${c.template !== undefined && c.template !== 'human' ? ` · ${c.template}` : ''} · ${c.stats?.triangles ?? '?'} tris, ${c.stats?.bones ?? '?'} bones, height ${+own.toFixed(3)}`)
  const units = unitsOf(c.id)
  const slotNames = new Set<string>()
  let gameHeight: number | null = null
  for (const { unit, role, u } of units) {
    if (role === 'unit') {
      gameHeight = u.height
      out.push(`In the game: ${unit}${u.draft === true ? ' (draft: built only when named)' : ''} · ${u.height} m · plays ${u.clips.join(', ')}`)
      if (u.companion !== undefined) out.push(`  with ${u.companion.character} (${u.companion.prefix}, ${u.companion.height} m)${u.companion.ridden === true ? ', ridden' : ''}`)
    } else {
      gameHeight = u.companion!.height
      out.push(`In the game: ${role} of ${unit} (${u.companion!.prefix}, ${u.companion!.height} m) · plays ${u.clips.join(', ')}`)
    }
    for (const n of u.clips) slotNames.add(n)
  }
  if (units.length === 0) out.push('Not in the game (units.json names no unit for it).')
  const byName = new Map(c.animations.map(a => [a.name, a]))
  if (slotNames.size > 0) {
    out.push('', 'Slots')
    for (const n of slotNames) {
      const a = byName.get(n)
      out.push(`  ${n.padEnd(8)} ${a === undefined ? '(empty)' : entryLine(a, gameHeight, own)}`)
      if (a?.note !== undefined) out.push(`  ${''.padEnd(8)} why: ${a.note}`)
    }
  }
  const trials = c.animations.filter(a => !slotNames.has(a.name))
  if (trials.length > 0) {
    out.push('', slotNames.size > 0 ? 'Trials (not played by the game)' : 'Clips')
    for (const a of trials) out.push(`  ${a.name.padEnd(8)} ${entryLine(a, gameHeight, own)}`)
  }
  if ((c.scripts ?? []).length > 0) {
    out.push('', 'Scripts')
    for (const s of c.scripts ?? []) {
      const extra = s.kind === 'blow' ? [s.blowU !== undefined ? `blow at ${pct(s.blowU)} of the clip` : 'blow found', s.late !== undefined ? `late: ${s.late}` : ''].filter(Boolean).join(', ') : ''
      out.push(`  [${s.enabled ? 'on ' : 'off'}] ${s.kind.padEnd(5)} ${describeScript(s)}${extra !== '' ? ` (${extra})` : ''}${s.note !== undefined ? ` · ${s.note}` : ''}`)
    }
  }
  if ((c.garments ?? []).length > 0) {
    out.push('', 'Gear')
    for (const g of c.garments ?? []) {
      const flags = [g.mode, g.hidden === true ? 'hidden' : '', g.status !== 'ready' ? g.status : '', g.from !== undefined ? g.from : 'added by hand'].filter(Boolean).join(', ')
      out.push(`  ${g.name.padEnd(22)} on ${g.bone}: at [${r3(g.position)}] turned [${r3(g.rotation)}] size ${+g.scale.toFixed(4)} · ${flags}`)
    }
  }
  if ((c.props ?? []).length > 0) out.push('', `Catalog props (not in the game): ${(c.props ?? []).map(p => `${p.name} on ${p.socket}`).join(', ')}`)
  if (c.mount !== undefined) {
    const m = c.mount
    const horse = characters().find(x => x.id === m.character)
    out.push('', `Mount: rides ${horse?.name ?? '?'} (${m.character}) on its ${m.bone}`)
    out.push(`  seat at [${r3(m.position)}] turned [${r3(m.rotation)}]${m.scale !== undefined ? ` size ${m.scale}` : ''}`)
    out.push(`  holds ${m.freeze.join(', ')}${m.hips !== undefined ? `; hips at [${r3(m.hips)}]` : ''}`)
    out.push(`  the horse wears: skin ${m.skin ?? '(its own)'}; gear ${(m.gear ?? []).join(', ') || 'none'}`)
  }
  if ((c.skins ?? []).length > 0) out.push('', `Skins: ${(c.skins ?? []).map(s => `${s.name} (${s.file})`).join(', ')}`)
  return out.join('\n')
}

function list (): string {
  const out: string[] = []
  for (const c of characters()) {
    const units = unitsOf(c.id).map(x => x.role === 'unit' ? x.unit + (x.u.draft === true ? ' (draft)' : '') : `${x.unit}'s ${x.u.companion!.prefix.replace(/_$/, '').toLowerCase()}`)
    const bits = [`${c.animations.length} clips`, `${(c.garments ?? []).length} gear`]
    if (c.mount !== undefined) bits.push(`rides ${c.mount.character}`)
    out.push(`${c.id.padEnd(28)} ${c.name.padEnd(24)} ${c.status.padEnd(8)} ${(units.join(', ') || '-').padEnd(22)} ${bits.join(', ')}`)
  }
  return out.join('\n')
}

function getPath (value: unknown, p: string | undefined): unknown {
  if (p === undefined || p === '') return value
  return p.split('.').reduce<unknown>((v, k) => {
    if (v === null || v === undefined) return undefined
    if (Array.isArray(v) && !/^\d+$/.test(k)) return v.find(x => (x as { name?: string, id?: string }).name === k || (x as { id?: string }).id === k)
    return (v as Record<string, unknown>)[k]
  }, value)
}

function args (rest: string[]): { pos: string[], kv: Record<string, string>, flags: Set<string> } {
  const pos: string[] = []; const kv: Record<string, string> = {}; const flags = new Set<string>()
  for (const a of rest) {
    const m = /^(?:--)?(\w+)=(.*)$/.exec(a)
    if (m !== null) kv[m[1]] = m[2]
    else if (a.startsWith('--')) flags.add(a.slice(2))
    else pos.push(a)
  }
  return { pos, kv, flags }
}

/** Export a character's game file to a scratch folder (workspace/renders/<id>): the unit it is (a draft too), else a
 * stand-in unit of its own set. */
function exportFor (c: Character, out: string): { glb: string, unit: string, missing: string[] } {
  // (a horse is drawn under a rider: the first unit riding it)
  const own = unitsOf(c.id).find(x => x.role === 'unit') ?? unitsOf(c.id)[0]
  mkdirSync(out, { recursive: true })
  const unit = own?.unit ?? c.id
  const u: Record<string, unknown> = own !== undefined ? structuredClone(own.u) as unknown as Record<string, unknown> : { character: c.id, height: 2, budget: 40000, clips: c.animations.map(a => a.name) }
  // the slots filled so far: a unit half done still draws
  const rider = characters().find(x => x.id === u.character)!
  const missing = (u.clips as string[]).filter(n => !rider.animations.some(a => a.name === n))
  u.clips = (u.clips as string[]).filter(n => !missing.includes(n))
  delete u.draft
  delete u.models_dir
  if ((u.clips as string[]).length === 0) throw new Error(`${unit}: no slot filled yet`)
  const specPath = path.join(out, 'spec.json')
  writeFileSync(specPath, JSON.stringify({ units: { [unit]: u } }, null, 1))
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'game_export.ts'), specPath, out, path.join(out, 'work'), unit], { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 })
  return { glb: path.join(out, `${unit}.glb`), unit, missing }
}

async function ride (c: Character, horseWho: string): Promise<string> {
  if (horseWho === 'off') { await patch(c.id, { mount: null }); return `${c.name} is on foot` }
  const horse = resolve(horseWho)
  // the same seat as the app's "Rides" (src/state/outfit.svelte.ts setMount): worked out from the two bodies at rest
  const { body } = await import('./lib/node3d.ts')
  const { riderScale, straddle } = await import('../src/engine/mount.ts')
  const rider = await body(c.id)
  const hv = await body(horse.id)
  const u = Object.values(spec()).find(x => x.character === c.id)
  const k = riderScale({}, { game: u?.height ?? null, own: rider.height }, { game: u?.companion?.character === horse.id ? u.companion.height : null, own: hv.height })
  const seat = straddle(hv, rider, k)
  const mount: Mount = { character: horse.id, rotation: [0, 0, 0], ...seat }
  await patch(c.id, { mount })
  return `${c.name} rides ${horse.name} on its ${seat.bone} at [${r3(seat.position)}] (his size there ${k.toFixed(3)})`
}

async function main (): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, kv, flags } = args(rest)
  switch (cmd) {
    case 'list': console.log(list()); return
    case 'show': {
      const c = resolve(pos[0])
      console.log(flags.has('json') ? JSON.stringify(c, null, 1) : show(c))
      return
    }
    case 'history': {
      const c = resolve(pos[0])
      const file = path.join(WORKSPACE, 'characters', c.id, 'journal.jsonl')
      const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as JournalEntry) : []
      const n = Number(pos[1] ?? 30)
      if (lines.length === 0) console.log('(nothing in the journal yet)')
      for (const e of lines.slice(-n)) console.log(`${e.at.replace('T', ' ').slice(0, 19)}  ${(e.by === 'app' ? 'designer' : e.by).padEnd(9)} ${e.note === true ? 'note: ' : ''}${e.changes.join('\n' + ' '.repeat(31))}`)
      return
    }
    case 'note': {
      const c = resolve(pos[0])
      await call('POST', `/api/characters/${c.id}/journal`, { note: pos.slice(1).join(' ') })
      console.log('noted')
      return
    }
    case 'get': {
      const c = resolve(pos[0])
      console.log(JSON.stringify(getPath(c, pos[1]), null, 1))
      return
    }
    case 'set': {
      const c = resolve(pos[0])
      if (pos[1] === undefined || pos[2] === undefined) throw new Error('set WHO FIELD JSON')
      await patch(c.id, { [pos[1]]: JSON.parse(pos.slice(2).join(' ')) as unknown })
      console.log(`${c.name}: ${pos[1]} saved`)
      return
    }
    case 'clips': {
      const c = resolve(pos[0])
      const q = new URLSearchParams({ q: pos[1] ?? '', size: '40', rig: c.template ?? 'human', ...(pos[2] !== undefined ? { category: pos[2] } : {}) })
      const page = await call<{ total: number, clips: Array<{ id: string, name: string, duration: number, loop: boolean, inPlace: boolean, category: string }> }>('GET', `/api/library?${q.toString()}`)
      for (const x of page.clips) console.log(`${x.id.padEnd(44)} ${x.duration.toFixed(2).padStart(6)} s  ${x.loop ? 'loop' : 'once'}  ${x.category ?? ''}  ${x.name}`)
      console.log(`(${page.clips.length} of ${page.total})`)
      return
    }
    case 'slot': {
      const c = resolve(pos[0])
      const [, name, clipId] = pos
      if (name === undefined || clipId === undefined) throw new Error('slot WHO SLOT CLIP [speed=1] [loop|once] [inplace|moving]')
      const page = await call<{ clips: Array<{ id: string, url: string, loop: boolean, inPlace: boolean, source?: string }> }>('GET', `/api/library?${new URLSearchParams({ q: clipId, size: '200', rig: c.template ?? 'human' }).toString()}`)
      const clip = page.clips.find(x => x.id === clipId)
      if (clip === undefined) throw new Error(`no clip ${clipId} for a ${c.template ?? 'human'} rig (rig.ts clips WHO QUERY)`)
      const was = c.animations.find(a => a.name === name)
      const entry: AnimationEntry = {
        ...(was ?? {}), name, clipId,
        loop: pos.includes('loop') ? true : pos.includes('once') ? false : was?.loop ?? clip.loop,
        inPlace: pos.includes('inplace') ? true : pos.includes('moving') ? false : was?.inPlace ?? clip.inPlace,
        speed: kv.speed !== undefined ? Number(kv.speed) : was?.speed ?? 1,
      }
      if (clip.url.startsWith('/animations/')) entry.url = clip.url
      else delete entry.url
      if (was !== undefined && was.clipId !== clipId) { delete entry.keys; delete entry.lift }
      const animations = was === undefined ? [...c.animations, entry] : c.animations.map(a => a.name === name ? entry : a)
      await patch(c.id, { animations })
      console.log(`${c.name} ${name}: ${entryLine(entry, null, c.stats?.height ?? 1)}${was !== undefined && was.clipId !== clipId ? ' (a new clip: its keys and ground start again)' : ''}`)
      return
    }
    case 'units': {
      const st = await call<{ repo: string, units: Record<string, { ours: SpecUnit | null, game: SpecUnit | null, differs: boolean }> }>('GET', '/api/game')
      for (const [u, x] of Object.entries(st.units)) console.log(`${u.padEnd(16)} ${(x.ours?.character ?? '-').padEnd(26)} ${x.ours === null ? 'only in the game' : x.game === null ? 'not in the game yet' : x.differs ? 'changed here (export writes it)' : 'as in the game'}${x.ours?.draft === true ? ' · draft' : ''}`)
      console.log(`(the game: ${st.repo})`)
      return
    }
    case 'unit': {
      if (pos[0] === undefined || pos[1] === undefined) throw new Error('unit NAME JSON|null')
      await call('PUT', `/api/game/units/${pos[0]}`, JSON.parse(pos.slice(1).join(' ')) as unknown)
      console.log(`unit ${pos[0]} saved (in Rigsmith; export to put it in the game)`)
      return
    }
    case 'export': {
      if (pos.length === 0) throw new Error('export UNIT ...')
      const job = await call<{ id: string }>('POST', '/api/game/export', { units: pos })
      for (;;) {
        await new Promise(r => setTimeout(r, 1500))
        const j = (await call<Array<{ id: string, status: string, message: string, error?: string }>>('GET', '/api/jobs')).find(x => x.id === job.id)
        if (j === undefined || j.status === 'done' || j.status === 'failed') { console.log(j?.status === 'failed' ? `failed: ${j.error}` : `exported: ${j?.message ?? ''}`); return }
      }
    }
    case 'ride': {
      const c = resolve(pos[0])
      console.log(await ride(c, pos[1] ?? 'off'))
      return
    }
    case 'render': {
      const c = resolve(pos[0])
      const out = kv.out ?? path.join(WORKSPACE, 'renders', c.id)
      const { glb, missing } = exportFor(c, out)
      if (missing.length > 0) console.log(`(not drawn, no clip yet: ${missing.join(', ')})`)
      const py = ['-b', '--factory-startup', '-P', path.join(ROOT, 'tools', 'render.py'), '--', glb, out]
      for (const k of ['clips', 'at', 'views', 'size', 'hide']) if (kv[k] !== undefined) py.push(`--${k}`, kv[k])
      const log = execFileSync(process.env.BLENDER ?? 'blender', py, { encoding: 'utf8', maxBuffer: 1 << 26 })
      for (const l of log.split('\n')) if (l.startsWith('SHEET') || l.startsWith('NO CLIP') || /Error/.test(l)) console.log(l)
      return
    }
    case 'check': {
      const units = spec()
      const repo = settings().gameRepo
      const names = pos.length > 0 ? pos : Object.keys(units).filter(u => units[u].draft !== true)
      const out = path.join(WORKSPACE, 'renders', '_check')
      mkdirSync(out, { recursive: true })
      execFileSync(process.execPath, [path.join(ROOT, 'tools', 'game_export.ts'), specFile(), out, path.join(out, 'work'), ...names], { stdio: ['ignore', 'ignore', 'inherit'] })
      const hash = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex')
      for (const u of names) {
        const game = path.join(repo, 'assets', 'models', 'units', `${u}.glb`)
        const now = path.join(out, `${u}.glb`)
        console.log(`${u.padEnd(14)} ${!existsSync(game) ? 'not in the game yet' : hash(game) === hash(now) ? 'current' : `differs: Rigsmith has changed it (tools/rigsmith/build.sh ${u} in the game)`}`)
      }
      return
    }
    default:
      console.log(readFileSync(import.meta.filename, 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'))
  }
}

main().catch((e: unknown) => { console.error(`rig: ${(e as Error).message}`); process.exit(1) })
