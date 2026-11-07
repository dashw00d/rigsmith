// The game's forge.json (in its repo, Settings.gameRepo): its pipelines of stages, read and checked whole. A file
// that doesn't hold together is refused with every problem named, never half used. Read again when it changes.
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { getSettings } from '../store.ts'
import type { ForgeConfig, ForgePipeline, ForgeStage, Gate, PublishSpec, StageInput } from './types.ts'

export class ForgeConfigError extends Error {
  problems: string[]
  constructor (file: string, problems: string[]) {
    super(`${file}: ${problems.join('; ')}`)
    this.problems = problems
  }
}

export const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const GATES: Gate[] = ['pick', 'approve', 'align', 'mask']
const PLACEHOLDER = /\{([a-z]+(?:\.[A-Za-z0-9_-]+)?)\}/g
const NAMES = new Set(['work', 'out', 'spec', 'seed', 'item', 'set', 'attempt', 'repo'])

type Raw = Record<string, unknown>
const isObject = (x: unknown): x is Raw => typeof x === 'object' && x !== null && !Array.isArray(x)
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(s => typeof s === 'string')

function stageOf (raw: unknown, where: string, earlier: string[], problems: string[]): ForgeStage | null {
  if (!isObject(raw)) { problems.push(`${where} is not an object`); return null }
  const bad = (what: string): void => { problems.push(`${where}${typeof raw.id === 'string' ? ` (${raw.id})` : ''}: ${what}`) }
  const id = raw.id
  if (typeof id !== 'string' || !ID.test(id)) { bad('needs an id of lowercase letters, digits, - and _'); return null }
  if (earlier.includes(id)) bad('its id is taken by an earlier stage')
  if (!strings(raw.cmd) || raw.cmd.length === 0 || raw.cmd.some(s => s === '')) bad('cmd must be a list of words (the command and its arguments)')
  if (!strings(raw.outputs) || raw.outputs.length === 0) bad('outputs must list what it writes')
  else if (raw.outputs.some(o => o.replace(/^\?/, '') === '' || o.includes('..') || path.isAbsolute(o.replace(/^\?/, '')))) bad('an output is a path inside its work folder')
  const inputs: Record<string, StageInput> = {}
  if (raw.inputs !== undefined) {
    if (!isObject(raw.inputs)) bad('inputs must be an object of name: {stage} or {file}')
    else {
      for (const [name, v] of Object.entries(raw.inputs)) {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) bad(`input name ${name} has odd characters`)
        if (isObject(v) && typeof v.stage === 'string') {
          if (!earlier.includes(v.stage)) bad(`input ${name} comes from ${v.stage}, which isn't an earlier stage`)
          inputs[name] = { stage: v.stage }
        } else if (isObject(v) && typeof v.file === 'string' && v.file !== '') {
          if (v.as !== undefined && (typeof v.as !== 'string' || v.as.includes('..') || path.isAbsolute(v.as))) bad(`input ${name}'s "as" is a path inside work/`)
          inputs[name] = { file: v.file, ...(typeof v.as === 'string' ? { as: v.as } : {}) }
        } else bad(`input ${name} needs a stage or a file`)
      }
    }
  }
  if (strings(raw.cmd)) {
    for (const word of raw.cmd) {
      for (const m of word.matchAll(PLACEHOLDER)) {
        const p = m[1]
        if (p.startsWith('in.')) { if (inputs[p.slice(3)] === undefined) bad(`cmd uses {${p}} but has no input ${p.slice(3)}`) } else if (!NAMES.has(p)) bad(`cmd uses {${p}}, which isn't a placeholder`)
      }
    }
  }
  if (raw.gpu !== undefined && (!isObject(raw.gpu) || typeof raw.gpu.vram !== 'number' || raw.gpu.vram < 0 || typeof raw.gpu.family !== 'string' || raw.gpu.family === '')) bad('gpu is {vram: MiB, family}')
  if (raw.variants !== undefined && (!Number.isInteger(raw.variants) || (raw.variants as number) < 1 || (raw.variants as number) > 32)) bad('variants is a whole number from 1 to 32')
  if (raw.gate !== undefined && !GATES.includes(raw.gate as Gate)) bad(`gate is one of ${GATES.join(', ')}`)
  if (raw.code !== undefined && !strings(raw.code)) bad('code lists files of the repo')
  if (raw.timeout !== undefined && (typeof raw.timeout !== 'number' || raw.timeout <= 0)) bad('timeout is seconds')
  if (raw.env !== undefined && (!isObject(raw.env) || Object.values(raw.env).some(v => typeof v !== 'string'))) bad('env maps names to strings')
  if (raw.version !== undefined && typeof raw.version !== 'string' && typeof raw.version !== 'number') bad('version is a number or a string')
  for (const flag of ['scratch', 'mutates', 'resumable', 'generative', 'cache', 'splits']) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') bad(`${flag} is true or false`)
  }
  if (raw.cache === true && (raw.generative === true || (raw.generative === undefined && raw.gpu !== undefined))) bad('a generative stage is never reused, so it has no cache')
  return {
    id, label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : id,
    cmd: strings(raw.cmd) ? raw.cmd : [], outputs: strings(raw.outputs) ? raw.outputs : [],
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...pick(raw, ['version', 'gpu', 'variants', 'gate', 'code', 'scratch', 'mutates', 'resumable', 'timeout', 'generative', 'cache', 'env', 'splits']),
  }
}

function pick (raw: Raw, keys: string[]): Partial<ForgeStage> {
  const out: Raw = {}
  for (const k of keys) if (raw[k] !== undefined) out[k] = raw[k]
  return out as Partial<ForgeStage>
}

function publishOf (raw: unknown, where: string, stages: string[], problems: string[]): PublishSpec | undefined {
  if (raw === undefined) return undefined
  if (!isObject(raw) || typeof raw.into !== 'string' || raw.into === '') { problems.push(`${where}.publish needs "into" (the item's folder in the repo)`); return undefined }
  if (raw.stages !== undefined && (!strings(raw.stages) || raw.stages.some(s => !stages.includes(s)))) problems.push(`${where}.publish.stages names a stage it doesn't have`)
  if (raw.roster !== undefined && (!isObject(raw.roster) || typeof raw.roster.file !== 'string' || typeof raw.roster.list !== 'string' || typeof raw.roster.key !== 'string')) problems.push(`${where}.publish.roster is {file, list, key}`)
  const ch = raw.character
  if (ch !== undefined && (!isObject(ch) || typeof ch.pieces !== 'string' || typeof ch.name !== 'string' || typeof ch.from !== 'string' || !isObject(ch.policy))) problems.push(`${where}.publish.character is {pieces, name, from, policy}`)
  return raw as unknown as PublishSpec
}

/** forge.json's contents checked and resolved against the repo. Throws ForgeConfigError naming every problem. */
export function parseConfig (raw: unknown, repo: string, file = path.join(repo, 'forge.json')): ForgeConfig {
  const problems: string[] = []
  if (!isObject(raw)) throw new ForgeConfigError(file, ['it is not a JSON object'])
  if (raw.schema !== 1) problems.push('schema must be 1')
  if (typeof raw.store !== 'string' || raw.store === '') problems.push('store names the folder attempts are kept in')
  const pipelines: Record<string, ForgePipeline> = {}
  if (!isObject(raw.pipelines) || Object.keys(raw.pipelines).length === 0) problems.push('pipelines must name at least one pipeline')
  else {
    for (const [id, p] of Object.entries(raw.pipelines)) {
      const where = `pipelines.${id}`
      if (!ID.test(id)) problems.push(`${where}: a pipeline id is lowercase letters, digits, - and _`)
      if (!isObject(p) || !Array.isArray(p.stages) || p.stages.length === 0) { problems.push(`${where} needs stages`); continue }
      const stages: ForgeStage[] = []
      p.stages.forEach((s, i) => {
        const stage = stageOf(s, `${where}.stages[${i}]`, stages.map(x => x.id), problems)
        if (stage !== null) stages.push(stage)
      })
      pipelines[id] = {
        id, label: typeof p.label === 'string' ? p.label : id, item: typeof p.item === 'string' ? p.item : 'item', stages,
        ...(p.publish !== undefined ? { publish: publishOf(p.publish, where, stages.map(s => s.id), problems) } : {}),
      }
    }
  }
  if (raw.hashes !== undefined && (!strings(raw.hashes) || raw.hashes.length === 0)) problems.push('hashes is a command (a list of words)')
  for (const k of ['comfy', 'body', 'character']) if (raw[k] !== undefined && typeof raw[k] !== 'string') problems.push(`${k} is a string`)
  if (problems.length > 0) throw new ForgeConfigError(file, problems)
  return {
    schema: 1, repo, file, store: path.resolve(repo, raw.store as string), pipelines,
    ...(typeof raw.comfy === 'string' ? { comfy: raw.comfy } : {}),
    ...(typeof raw.body === 'string' ? { body: raw.body } : {}),
    ...(typeof raw.character === 'string' ? { character: raw.character } : {}),
    ...(strings(raw.hashes) ? { hashes: raw.hashes } : {}),
  }
}

let cached: { file: string, mtime: number, config: ForgeConfig } | null = null

/** The game's forge.json ($RIGSMITH_FORGE names another file), read again when it changed. Null when the game has
 * none; throws ForgeConfigError when it has a broken one. */
export async function loadConfig (repo?: string): Promise<ForgeConfig | null> {
  const root = repo ?? (await getSettings()).gameRepo
  const file = process.env.RIGSMITH_FORGE ?? path.join(root, 'forge.json')
  if (!existsSync(file)) return null
  const mtime = (await stat(file)).mtimeMs
  if (cached !== null && cached.file === file && cached.mtime === mtime) return cached.config
  let raw: unknown
  try { raw = JSON.parse(await readFile(file, 'utf8')) } catch (error) { throw new ForgeConfigError(file, [`not JSON: ${(error as Error).message}`]) }
  const config = parseConfig(raw, path.dirname(file), file)
  cached = { file, mtime, config }
  return config
}

/** A pipeline's stage by id. */
export function findStage (config: ForgeConfig, pipeline: string, stage: string): ForgeStage | undefined {
  return config.pipelines[pipeline]?.stages.find(s => s.id === stage)
}
