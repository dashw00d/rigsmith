// Rigsmith from the command line: everything the app shows, readable, and the same changes the app makes, as the same
// commands through the same server (so open pages update at once and the journal says who did what; every change can
// be undone there). For the designer and an agent alike: the agent's changes are signed "agent" (RIGSMITH_BY
// overrides), the app's "app".
//
//   node tools/rig.ts list                              every character: its game unit, set, gear, mount
//   node tools/rig.ts show WHO [--json]                 all of one: its slots (clip, speed, loop, each adjustment), its
//                                                       hands, its gear with its handles and where it sits, its mount
//   node tools/rig.ts history WHO [N]                   its journal: every change, who made it, when (newest last)
//   node tools/rig.ts note WHO TEXT...                  a line in its journal (for the other one to read)
//   node tools/rig.ts get WHO [PATH]                    its record, or a part (clips.Idle.adjustments, mount.pose.Hips)
//   node tools/rig.ts set WHO FIELD JSON                one thing, as the app changes it (null takes it off): name,
//                                                       joints, markers, boneMap, handPoses, hold, fingers, mount
//   node tools/rig.ts do WHO COMMANDS                   commands (src/model/command-types.ts) as one change: JSON, a
//                                                       list or { "commands": [...] }, or @file
//   node tools/rig.ts undo WHO [SEQ]                    take back its last change (or journal entry SEQ)
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
// WHO: a character id, its name, or the game unit it is. Reads come from the workspace's files (as schema 2, however
// old the file); changes need the server (the app: RIGSMITH_URL, default port 5180). The game's repo is written by
// `export` alone.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Command } from '../src/model/command-types.ts'
import { pct, r3, refText, windowsText } from '../src/model/commands/common.ts'
import { newId } from '../src/model/ids.ts'
import { gearById, heightOf, phaseOf, slotById } from '../src/model/select.ts'
import type { Adjustment, Character, Gear, Handle, HandPose, HandPoseRef, Job, JournalEntry, Mount, Side, Slot } from '../src/model/types.ts'
import type { GameSpec, UnitSpec } from '../src/model/unit.ts'
import { character as readOne, ROOT, settings as readSettings, WORKSPACE } from './lib/node3d.ts'

const SERVER = process.env.RIGSMITH_URL ?? 'http://127.0.0.1:5180'
const BY = process.env.RIGSMITH_BY ?? 'agent'
const SIDES: Side[] = ['Left', 'Right']

/** The game's repo (Settings): Ship writes its units there. */
function gameRepo (): string {
  const repo = readSettings().gameRepo
  return repo !== '' ? repo.replace(/^~(?=$|\/)/, homedir()) : path.join(homedir(), 'dev', 'games', 'emberhold')
}
// Rigsmith's own units (server/game.ts): the game's repo is written only by an export
const specFile = (): string => path.join(WORKSPACE, 'game', 'units.json')
function gameSpec (): GameSpec {
  const f = specFile()
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as GameSpec : { units: {} }
}
const spec = (): Record<string, UnitSpec> => gameSpec().units

function characters (): Character[] {
  const dir = path.join(WORKSPACE, 'characters')
  return readdirSync(dir).filter(d => existsSync(path.join(dir, d, 'character.json')))
    .map(d => readOne(d))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function resolve (who: string | undefined): Character {
  if (who === undefined) throw new Error('which character? (an id, a name or a game unit)')
  const all = characters()
  const id = spec()[who]?.character
  const found = all.find(c => c.id === who) ?? all.find(c => c.id === id) ?? all.filter(c => c.name.toLowerCase() === who.toLowerCase())
  if (Array.isArray(found)) {
    if (found.length === 1) return found[0]
    throw new Error(found.length === 0 ? `no character "${who}"` : `"${who}" is ${found.length} characters: ${found.map(c => c.id).join(', ')}`)
  }
  return found
}

/** The units a character is in the game: as the unit itself, or the companion (a horse) of each. */
interface UnitRole { unit: string, role: 'unit' | 'companion', u: UnitSpec }
function unitsOf (id: string): UnitRole[] {
  return Object.entries(spec()).flatMap(([unit, u]): UnitRole[] => u.character === id ? [{ unit, role: 'unit', u }] : u.companion?.character === id ? [{ unit, role: 'companion', u }] : [])
}

// ---- the server ---------------------------------------------------------------------------------------------------

class ServerError extends Error {
  body: Record<string, unknown>
  constructor (message: string, body: Record<string, unknown>) { super(message); this.body = body }
}

async function call<T> (method: string, url: string, body?: unknown): Promise<T> {
  let r: Response
  try {
    r = await fetch(SERVER + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-rigsmith': '1', 'x-rigsmith-schema': '2', 'x-rigsmith-by': BY },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new Error(`Rigsmith's server is not running (${SERVER}): start it (npm run dev, or systemctl --user start rigsmith; RIGSMITH_URL for another port)`)
  }
  const text = await r.text()
  const data = text === '' ? null : JSON.parse(text) as unknown
  if (!r.ok) {
    const b = (data ?? {}) as Record<string, unknown>
    throw new ServerError(typeof b.error === 'string' ? b.error : `${r.status} ${r.statusText}`, b)
  }
  return data as T
}

/** Commands as one change (one journal entry, one undo); what it changed, in its words. */
async function run (c: Character, commands: Command[], what?: string): Promise<string[]> {
  if (commands.length === 0) return ['nothing to change']
  const { entry } = await call<{ character: Character, entry: JournalEntry | null }>('POST', `/api/characters/${c.id}/commands`, { commands, what })
  return entry === null ? ['nothing changed'] : entry.changes
}

/** A job the server runs, followed to its end (Ctrl-C cancels it). */
async function follow (job: Job, done: (j: Job) => string): Promise<void> {
  const stop = (): void => {
    console.log('cancelling…')
    void call('POST', `/api/jobs/${job.id}/cancel`).catch(() => {}).finally(() => process.exit(130))
  }
  process.once('SIGINT', stop)
  let last = ''
  for (;;) {
    await new Promise(r => setTimeout(r, 1500))
    const j = (await call<Job[]>('GET', '/api/jobs')).find(x => x.id === job.id)
    if (j === undefined) { console.log('(the job is gone: the server restarted?)'); break }
    if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') {
      console.log(j.status === 'done' ? done(j) : `${j.status}: ${j.error ?? j.message}`)
      if (j.status !== 'done') process.exitCode = 1
      break
    }
    if (j.message !== last && j.message !== '') { console.log(`  ${j.message}`); last = j.message }
  }
  process.off('SIGINT', stop)
}

// ---- reading ------------------------------------------------------------------------------------------------------

const r3s = (v: readonly number[] | undefined): string => (v ?? []).map(r3).join(', ')

function keysText (c: Character, a: Extract<Adjustment, { kind: 'keys' }>): string {
  const all = [...Object.entries(a.bones ?? {}), ...Object.entries(a.gear ?? {}).map(([id, k]) => [gearById(c, id)?.name ?? id, k] as const)]
  return `keys ${all.map(([n, k]) => `${n} (${k.map(x => pct(x.u)).join(' ')})`).join(', ')}`
}

/** An adjustment in words. Ground in the game's centimetres when the character is a unit (else a share of its height). */
function adjustmentText (c: Character, a: Adjustment, game: number | null): string {
  const gearName = (id: string): string => gearById(c, id)?.name ?? id
  switch (a.kind) {
    case 'ground': {
      const own = heightOf(c)
      return `ground ${game !== null ? `${+(a.lift * game / own * 100).toFixed(1)} cm` : `${+(a.lift / own * 100).toFixed(1)} %`}`
    }
    case 'blowTiming':
      return `blow timing: the hit at ${pct(a.at)}${a.blowU !== undefined ? `, the blow at ${pct(a.blowU)} of the clip` : ' (the blow found)'}` +
        `${a.window !== undefined ? `, ${r3(a.window)} s round it` : ''}${a.late !== undefined ? `, late: ${a.late}` : ''}${a.hand !== undefined ? ` (${a.hand})` : ''}`
    case 'pace': return `pace like ${slotById(c, a.like)?.name ?? `(gone: ${a.like})`}`
    case 'handPose': return `${a.hand} hand ${refText(c, a.pose)} in ${windowsText(a.windows)}${a.gear !== undefined ? ` (letting go of ${gearName(a.gear)})` : ''}`
    case 'handleHold': {
      const g = gearById(c, a.gear)
      return `holds ${g?.name ?? a.gear} · ${g?.handles.find(h => h.id === a.handle)?.name ?? a.handle} in ${windowsText(a.windows)}`
    }
    case 'keys': return keysText(c, a)
  }
}

function slotLines (c: Character, s: Slot, game: number | null, pad: number): string[] {
  const bits = [s.clip.id, s.loop ? 'loop' : 'once', s.inPlace ? 'in place' : 'moving']
  if (s.speed !== 1) bits.push(`speed ${s.speed}`)
  const out = [`  ${s.name.padEnd(pad)} ${bits.join(' · ')}`]
  const indent = `  ${''.padEnd(pad)} `
  if (s.note !== undefined) out.push(`${indent}why: ${s.note}`)
  for (const a of s.adjustments) out.push(`${indent}[${a.enabled ? 'on ' : 'off'}] ${adjustmentText(c, a, game)}${a.note !== undefined ? ` · ${a.note}` : ''}`)
  return out
}

function attachText (g: Gear): string {
  const a = g.attach
  const where = a.kind === 'bone' ? `on ${a.bone}` : a.kind === 'skin' ? `worn on the skin (${a.policy}${a.hideBody === true ? ', hides the body under it' : ''})` : 'pinned to a spot of the skin'
  const legacy = a.kind === 'bone' && a.legacyFrame !== undefined ? ' (still in the old catalog frame)' : ''
  return `${where}: at [${r3s(a.place.position)}] turned [${r3s(a.place.rotation)}] size ${+a.place.scale.toFixed(4)}${legacy}`
}

function handleText (c: Character, h: Handle): string {
  const pose = h.pose !== undefined ? `, ${refText(c, h.pose)}` : h.kind === 'carry' ? `, ${refText(c, 'default')}` : ''
  if (h.kind === 'carry') return `carried in the ${h.hand ?? '?'} hand${pose}${h.place !== undefined ? `, held at [${r3s(h.place.position)}]${h.exact === true ? ' exactly' : ''}` : ''}`
  if (h.kind === 'grip') return `grip "${h.name}" for ${h.hand !== undefined ? `the ${h.hand} hand` : 'either hand'}${h.place !== undefined ? ` at [${r3s(h.place.position)}]${h.exact === true ? ' exactly' : ''}` : ''}${pose}`
  return `pull "${h.name}" drawn by ${h.pull?.bone ?? '?'}${h.pose !== undefined ? `, the hand ${refText(c, h.pose)}` : ''} (rests at [${r3s(h.pull?.rest)}])`
}

const refShort = (ref: HandPoseRef | undefined, c: Character): string => refText(c, ref).replace(/^in /, '')

function show (c: Character): string {
  const out: string[] = []
  const own = heightOf(c)
  const t = c.skeleton.template
  const bones = c.skin.bones ?? c.source.stats?.bones
  out.push(`${c.name} (${c.id}) · ${phaseOf(c).label}${t !== 'human' ? ` · ${t}` : ` · fingers ${c.skeleton.fingerLevel}`} · ${c.source.stats?.triangles ?? '?'} tris, ${bones ?? '?'} bones, height ${+own.toFixed(3)}`)
  const overrides = Object.keys(c.skeleton.overrides).length
  const skin = [c.skin.locked ? `locked (${c.skin.lockReason ?? 'no reason given'})` : 'unlocked', c.skin.painted !== undefined ? `${c.skin.painted} points painted by hand` : '',
    c.skin.report !== undefined ? `rigged by ${c.skin.report.method}` : ''].filter(Boolean)
  out.push(`Skeleton: ${overrides > 0 ? `${overrides} joints placed by hand` : 'as detected'}${(c.skeleton.stale ?? []).length > 0 ? `, ${c.skeleton.stale!.length} placements set aside` : ''} · Skin: ${skin.join(', ')}`)
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
      out.push(`In the game: companion of ${unit} (${u.companion!.prefix}, ${u.companion!.height} m) · plays ${u.clips.join(', ')}`)
    }
    for (const n of u.clips) slotNames.add(n)
  }
  if (units.length === 0) out.push('Not in the game (units.json names no unit for it).')
  const pad = Math.max(8, ...c.clips.map(s => s.name.length), ...[...slotNames].map(n => n.length))
  if (slotNames.size > 0) {
    out.push('', 'Slots')
    for (const n of slotNames) {
      const s = c.clips.find(x => x.name === n)
      if (s === undefined) out.push(`  ${n.padEnd(pad)} (empty)`)
      else out.push(...slotLines(c, s, gameHeight, pad))
    }
  }
  const trials = c.clips.filter(s => !slotNames.has(s.name))
  if (trials.length > 0) {
    out.push('', slotNames.size > 0 ? 'Trials (not played by the game)' : 'Clips')
    for (const s of trials) out.push(...slotLines(c, s, gameHeight, pad))
  }
  const hold = c.hands.hold ?? {}
  if (SIDES.some(s => hold[s] !== undefined) || c.hands.poses.length > 0) {
    out.push('', 'Hands')
    for (const side of SIDES) if (hold[side] !== undefined) out.push(`  ${side} hand held ${refShort(hold[side], c)} in every clip`)
    if (c.hands.poses.length > 0) out.push(`  poses: ${c.hands.poses.map(p => `${p.name} (${p.side}, ${p.id})`).join(', ')}`)
  }
  if (c.gear.length > 0) {
    out.push('', 'Gear')
    const gp = Math.max(...c.gear.map(g => g.name.length))
    for (const g of c.gear) {
      const flags = [g.hidden === true ? 'hidden' : '', g.status !== 'ready' ? `${g.status}${g.error !== undefined ? `: ${g.error}` : ''}` : '',
        g.swapSet !== undefined ? `swap set ${g.swapSet}` : '', g.from ?? 'added by hand', g.painted !== undefined ? `${g.painted} painted` : ''].filter(Boolean).join(', ')
      out.push(`  ${g.name.padEnd(gp)} ${attachText(g)} · ${flags}`)
      for (const h of g.handles) out.push(`  ${''.padEnd(gp)}   ${handleText(c, h)}`)
    }
  }
  if (c.mount !== undefined) {
    const m = c.mount
    const horse = characters().find(x => x.id === m.character)
    out.push('', `Mount: rides ${horse?.name ?? '?'} (${m.character}) on its ${m.bone}`)
    out.push(`  seat at [${r3s(m.position)}] turned [${r3s(m.rotation)}]${m.scale !== undefined ? ` size ${m.scale}` : ''}`)
    out.push(`  holds ${m.freeze.join(', ')}${m.hips !== undefined ? `; hips at [${r3s(m.hips)}]` : ''}`)
    const worn = (m.gear ?? []).map(id => horse !== undefined ? gearById(horse, id)?.name ?? id : id)
    out.push(`  the horse wears: skin ${m.skin ?? '(its own)'}; gear ${worn.join(', ') || 'none'} (not exported: the game has never had it)`)
  }
  if ((c.look.skins ?? []).length > 0) out.push('', `Skins: ${c.look.skins!.map(s => `${s.name} (${s.file})`).join(', ')}`)
  if (c.look.layers.length > 0) out.push('', `Look: ${c.look.layers.map(l => `${l.kind} on ${l.image}${l.enabled ? '' : ' (off)'}`).join(', ')}`)
  if (c.error !== undefined) out.push('', `Last error: ${c.error}`)
  return out.join('\n')
}

function list (): string {
  const out: string[] = []
  for (const c of characters()) {
    const units = unitsOf(c.id).map(x => x.role === 'unit' ? x.unit + (x.u.draft === true ? ' (draft)' : '') : `${x.unit}'s ${x.u.companion!.prefix.replace(/_$/, '').toLowerCase()}`)
    const bits = [`${c.clips.length} clips`, `${c.gear.length} gear`]
    if (c.mount !== undefined) bits.push(`rides ${c.mount.character}`)
    if (c.skin.locked) bits.push('skin locked')
    out.push(`${c.id.padEnd(28)} ${c.name.padEnd(24)} ${phaseOf(c).label.padEnd(16)} ${(units.join(', ') || '-').padEnd(22)} ${bits.join(', ')}`)
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

// ---- changing -----------------------------------------------------------------------------------------------------

/** `set WHO FIELD JSON` as the commands the app sends for it (or the route it calls). */
async function set (c: Character, field: string, value: unknown): Promise<string[]> {
  switch (field) {
    case 'name':
      if (typeof value !== 'string') throw new Error('a name is text: set WHO name \'"Archer"\'')
      return await run(c, [{ type: 'character.rename', name: value }])
    // (each joint given that differs from what was detected becomes a placement; one that doesn't stops being one)
    case 'joints': return await run(c, [{ type: 'skeleton.place', joints: value as Record<string, [number, number, number]> }])
    case 'markers': return await run(c, [{ type: 'skeleton.markers', markers: value as Extract<Command, { type: 'skeleton.markers' }>['markers'] }])
    case 'boneMap': return await run(c, [{ type: 'skeleton.boneMap', boneMap: value as Record<string, string> | null }])
    case 'mount': return await run(c, [{ type: 'mount.set', mount: value as Mount | null }])
    case 'hold': {
      const hold = (value ?? {}) as Partial<Record<Side, HandPoseRef>>
      return await run(c, SIDES.map((side): Command => ({ type: 'hands.hold', side, pose: hold[side] ?? null })))
    }
    case 'handPoses': {
      const next = (value ?? []) as HandPose[]
      if (!Array.isArray(next)) throw new Error('handPoses is a list of hand poses')
      const commands: Command[] = []
      for (const p of c.hands.poses) if (!next.some(x => x.id === p.id)) commands.push({ type: 'hands.pose.remove', id: p.id })
      for (const p of next) {
        const was = c.hands.poses.find(x => x.id === p.id)
        if (was === undefined) commands.push({ type: 'hands.pose.add', pose: p })
        else if (JSON.stringify(was) !== JSON.stringify(p)) {
          const { id, ...patch } = p
          commands.push({ type: 'hands.pose.update', id, patch })
        }
      }
      return await run(c, commands, 'hands.poses')
    }
    case 'fingers': {
      if (!['none', 'one', 'two', 'full'].includes(value as string)) throw new Error('fingers: none, one, two or full')
      // (a finger level is a generator: the trace replaces the fingers, so it is a job, not a command)
      const job = await call<Job>('POST', `/api/characters/${c.id}/fingers`, { fingers: value })
      if (typeof job?.id !== 'string' || typeof job.status !== 'string') return ['fingers fitted']
      await follow(job, () => `fingers ${String(value)}`)
      return []
    }
    default:
      throw new Error(`set takes name, joints, markers, boneMap, handPoses, hold, fingers or mount; anything else is a command: rig.ts do WHO '{"type": ...}' (src/model/command-types.ts)`)
  }
}

/** Commands from the command line: JSON, or @file. */
function commandsOf (text: string): Command[] {
  const json = JSON.parse(text.startsWith('@') ? readFileSync(text.slice(1), 'utf8') : text) as unknown
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.commands) ? json.commands : isObj(json) && isObj(json.command) ? [json.command] : [json]
  if (!list.every(x => isObj(x) && typeof x.type === 'string')) throw new Error('commands are objects with a type (src/model/command-types.ts)')
  return list as Command[]
}

/** Export a character's game file to a scratch folder (workspace/renders/<id>): the unit it is (a draft too), else a
 * stand-in unit of its own set. Only the slots filled so far: a unit half done still draws. */
async function exportFor (c: Character, out: string): Promise<{ glb: string, unit: string, missing: string[] }> {
  const { exportUnit } = await import('./lib/unit_export.ts')
  // (a horse is drawn under a rider: the first unit riding it)
  const own = unitsOf(c.id).find(x => x.role === 'unit') ?? unitsOf(c.id)[0]
  mkdirSync(out, { recursive: true })
  const unit = own?.unit ?? c.id
  const u: UnitSpec = own !== undefined
    ? { ...gameSpec().defaults, ...structuredClone(own.u) } as UnitSpec
    : { character: c.id, height: 2, budget: 40000, clips: c.clips.map(s => s.name) }
  const rider = u.character === c.id ? c : readOne(u.character)
  const missing = u.clips.filter(n => !rider.clips.some(s => s.name === n))
  u.clips = u.clips.filter(n => !missing.includes(n))
  delete u.draft
  delete u.models_dir
  if (u.clips.length === 0) throw new Error(`${unit}: no slot filled yet`)
  await exportUnit(unit, u, { workspace: WORKSPACE, modelsDir: out, workDir: path.join(out, 'work') })
  return { glb: path.join(out, `${unit}.glb`), unit, missing }
}

async function ride (c: Character, horseWho: string): Promise<string> {
  if (horseWho === 'off') { await run(c, [{ type: 'mount.set', mount: null }]); return `${c.name} is on foot` }
  const horse = resolve(horseWho)
  // the same seat as the app's "Rides": worked out from the two bodies at rest
  const { body } = await import('./lib/node3d.ts')
  const { riderScale, straddle } = await import('../src/engine/mount.ts')
  const rider = await body(c.id)
  const hv = await body(horse.id)
  const u = Object.values(spec()).find(x => x.character === c.id)
  const k = riderScale({}, { game: u?.height ?? null, own: rider.height }, { game: u?.companion?.character === horse.id ? u.companion.height : null, own: hv.height })
  const seat = straddle(hv, rider, k)
  // (seated again on the same horse: its gear and skin for him kept, as the app's Rides does)
  const was = c.mount?.character === horse.id ? c.mount : undefined
  const kept = { ...(was?.skin !== undefined ? { skin: was.skin } : {}), ...(was?.gear !== undefined ? { gear: was.gear } : {}) }
  const mount: Mount = { character: horse.id, rotation: [0, 0, 0], ...seat, ...kept }
  await run(c, [{ type: 'mount.set', mount }])
  const unitName = Object.entries(spec()).find(([, x]) => x.character === c.id)?.[0]
  const note = u !== undefined && u.companion?.character !== horse.id
    ? `\n(its unit ${unitName ?? ''} has ${u.companion === undefined ? 'no companion' : `${u.companion.character} as its companion`}: the game export needs the horse there too, ridden; Ship's "Rides" sets both)`
    : ''
  return `${c.name} rides ${horse.name} on its ${seat.bone} at [${r3s(seat.position)}] (his size there ${k.toFixed(3)})${note}`
}

// ---- the commands -------------------------------------------------------------------------------------------------

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
      const n = Number(pos[1] ?? 30)
      let lines: JournalEntry[]
      try {
        lines = await call<JournalEntry[]>('GET', `/api/characters/${c.id}/journal?last=${n}`)
      } catch {
        // (no server: the file itself; its lines from before schema 2 have no number)
        const file = path.join(WORKSPACE, 'characters', c.id, 'journal.jsonl')
        lines = (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as JournalEntry) : []).slice(-n)
      }
      if (lines.length === 0) console.log('(nothing in the journal yet)')
      for (const e of lines) {
        const tag = e.seq !== undefined && e.seq >= 0 ? `#${e.seq}`.padEnd(6) : '      '
        const who = (e.by === 'app' ? 'designer' : e.by).padEnd(11)
        const state = e.undoneBy !== undefined ? ` (undone by #${e.undoneBy})` : e.undoes !== undefined ? ` (takes back #${e.undoes})` : ''
        const head = `${e.at.replace('T', ' ').slice(0, 19)}  ${tag}${who} `
        const changes = e.changes.length > 0 ? e.changes : [e.what]
        console.log(`${head}${e.note === true ? 'note: ' : ''}${changes.join('\n' + ' '.repeat(head.length))}${state}`)
      }
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
      for (const line of await set(c, pos[1], JSON.parse(pos.slice(2).join(' ')) as unknown)) console.log(`${c.name}: ${line}`)
      return
    }
    case 'do': {
      const c = resolve(pos[0])
      if (pos[1] === undefined) throw new Error('do WHO COMMANDS (JSON, or @file)')
      for (const line of await run(c, commandsOf(pos.slice(1).join(' ')))) console.log(`${c.name}: ${line}`)
      return
    }
    case 'undo': {
      const c = resolve(pos[0])
      const seq = pos[1] !== undefined ? Number(pos[1].replace(/^#/, '')) : undefined
      try {
        const { entry } = await call<{ entry: JournalEntry | null }>('POST', `/api/characters/${c.id}/undo`, seq === undefined ? {} : { seq })
        for (const line of entry?.changes ?? ['nothing changed']) console.log(`${c.name}: ${line}`)
      } catch (error) {
        const conflicts = error instanceof ServerError ? error.body.conflicts : undefined
        throw new Error(Array.isArray(conflicts) ? `${(error as Error).message}: ${conflicts.join(', ')}` : (error as Error).message, { cause: error })
      }
      return
    }
    case 'clips': {
      const c = resolve(pos[0])
      const q = new URLSearchParams({ q: pos[1] ?? '', size: '40', rig: c.skeleton.template, ...(pos[2] !== undefined ? { category: pos[2] } : {}) })
      const page = await call<{ total: number, clips: Array<{ id: string, name: string, duration: number, loop: boolean, inPlace: boolean, category: string }> }>('GET', `/api/library?${q.toString()}`)
      for (const x of page.clips) console.log(`${x.id.padEnd(44)} ${x.duration.toFixed(2).padStart(6)} s  ${x.loop ? 'loop' : 'once'}  ${x.category ?? ''}  ${x.name}`)
      console.log(`(${page.clips.length} of ${page.total})`)
      return
    }
    case 'slot': {
      const c = resolve(pos[0])
      const [, name, clipId] = pos
      if (name === undefined || clipId === undefined) throw new Error('slot WHO SLOT CLIP [speed=1] [loop|once] [inplace|moving]')
      const rig = c.skeleton.template
      const page = await call<{ clips: Array<{ id: string, url: string, loop: boolean, inPlace: boolean }> }>('GET', `/api/library?${new URLSearchParams({ q: clipId, size: '200', rig }).toString()}`)
      const clip = page.clips.find(x => x.id === clipId)
      if (clip === undefined) throw new Error(`no clip ${clipId} for a ${rig} rig (rig.ts clips WHO QUERY)`)
      const was = c.clips.find(s => s.name === name)
      const ref = clip.url.startsWith('/animations/') || clip.url.startsWith('/files/library/creatures/') ? { id: clipId, url: clip.url } : { id: clipId }
      const same = was !== undefined && was.clip.id === clipId && was.clip.url === ref.url
      const fill: Command = {
        type: 'slot.fill',
        ...(was !== undefined ? { id: was.id } : { name, newId: newId() }),
        clip: ref,
        loop: pos.includes('loop') ? true : pos.includes('once') ? false : was?.loop ?? clip.loop,
        inPlace: pos.includes('inplace') ? true : pos.includes('moving') ? false : was?.inPlace ?? clip.inPlace,
        speed: kv.speed !== undefined ? Number(kv.speed) : was?.speed ?? 1,
        // (a new clip: the old one's adjustments were tuned for other motion)
        keepAdjustments: same,
      }
      for (const line of await run(c, [fill])) console.log(`${c.name}: ${line}`)
      if (was !== undefined && !same && was.adjustments.length > 0) console.log(`(a new clip: its ${was.adjustments.length} adjustments start again)`)
      return
    }
    case 'units': {
      const st = await call<{ repo: string, units: Record<string, { ours: UnitSpec | null, game: UnitSpec | null, differs: boolean }> }>('GET', '/api/game')
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
      const job = await call<Job>('POST', '/api/game/export', { units: pos })
      await follow(job, j => `exported: ${j.message}`)
      return
    }
    case 'ride': {
      const c = resolve(pos[0])
      console.log(await ride(c, pos[1] ?? 'off'))
      return
    }
    case 'render': {
      const c = resolve(pos[0])
      const out = kv.out ?? path.join(WORKSPACE, 'renders', c.id)
      const { glb, missing } = await exportFor(c, out)
      if (missing.length > 0) console.log(`(not drawn, no clip yet: ${missing.join(', ')})`)
      const py = ['-b', '--factory-startup', '-P', path.join(ROOT, 'tools', 'render.py'), '--', glb, out]
      for (const k of ['clips', 'at', 'views', 'size', 'hide']) if (kv[k] !== undefined) py.push(`--${k}`, kv[k])
      const log = execFileSync(process.env.BLENDER ?? 'blender', py, { encoding: 'utf8', maxBuffer: 1 << 26 })
      for (const l of log.split('\n')) if (l.startsWith('SHEET') || l.startsWith('NO CLIP') || /Error/.test(l)) console.log(l)
      return
    }
    case 'check': {
      // Each unit built again as the game's build.sh would (tools/lib/unit_export.ts, Rigsmith's own spec) into a
      // scratch folder, its file compared byte for byte with the game's.
      const { exportUnit } = await import('./lib/unit_export.ts')
      const all = gameSpec()
      const repo = gameRepo()
      const names = pos.length > 0 ? pos : Object.keys(all.units).filter(u => all.units[u].draft !== true)
      const out = path.join(WORKSPACE, 'renders', '_check')
      mkdirSync(out, { recursive: true })
      const hash = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex')
      for (const u of names) {
        const unitSpec = all.units[u]
        if (unitSpec === undefined) { console.log(`${u.padEnd(14)} not one of Rigsmith's units`); continue }
        const merged = { ...all.defaults, ...unitSpec } as UnitSpec
        const game = path.join(repo, merged.models_dir ?? path.join('assets', 'models', 'units'), `${u}.glb`)
        try {
          await exportUnit(u, merged, { workspace: WORKSPACE, modelsDir: out, workDir: path.join(out, 'work') })
        } catch (error) {
          console.log(`${u.padEnd(14)} can't be built: ${(error as Error).message}`)
          process.exitCode = 1
          continue
        }
        const now = path.join(out, `${u}.glb`)
        console.log(`${u.padEnd(14)} ${!existsSync(game) ? 'not in the game yet' : hash(game) === hash(now) ? 'current' : `differs: Rigsmith has changed it (rig.ts export ${u}, or tools/rigsmith/build.sh ${u} in the game)`}`)
      }
      return
    }
    default:
      console.log(readFileSync(import.meta.filename, 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'))
  }
}

main().catch((e: unknown) => { console.error(`rig: ${(e as Error).message}`); process.exit(1) })
