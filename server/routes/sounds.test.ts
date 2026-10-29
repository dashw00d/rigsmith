// @vitest-environment node
// The sound routes against a temp workspace and a temp game: the game's sounds from its mix table, each with the files
// the game picks from (takes, folders, families), its files served for a preview; a file dropped on an event kept under
// the character's sounds/ by a clean name (the same bytes once, another file of the name numbered), listed and served;
// what isn't a sound refused.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRigged } from '../../src/model/fixtures.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-sounds-'))
const game = path.join(dir, 'game-repo')
process.env.RIGSMITH_WORKSPACE = path.join(dir, 'ws')
let handle: typeof import('../http.ts').handle
let sounds: typeof import('./sounds.ts')

const c = makeRigged()
const folder = path.join(dir, 'ws', 'characters', c.id)
const WAV = Buffer.from('RIFF....WAVEfmt ')

beforeAll(async () => {
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'character.json'), JSON.stringify(c))
  writeFileSync(path.join(dir, 'ws', 'settings.json'), JSON.stringify({ gameRepo: game }))
  const audio = path.join(game, 'assets', 'audio')
  mkdirSync(path.join(audio, 'sfx'), { recursive: true })
  for (const f of ['sword_hit_1.wav', 'sword_hit_2.wav', 'arrow_shoot.wav', 'ui_click.wav']) writeFileSync(path.join(audio, f), WAV)
  for (const f of ['arrow_shoot_2.wav', 'arrow_shoot_3.wav', 'warrior_select.wav', 'archer_select.ogg', 'javelin_throw.ogg']) writeFileSync(path.join(audio, 'sfx', f), WAV)
  writeFileSync(path.join(audio, 'mix.json'), JSON.stringify({
    version: 2,
    sounds: {
      sword_blow: { file: 'sword_hit', cat: 'combat', db: 5 },
      bowshot: { file: 'arrow_shoot', cat: 'combat', db: 4 },
      javelin_throw: { file: 'javelin_throw', cat: 'combat' },
      bark_select: { file: '*_select', cat: 'voice' },
      war_cry: { file: 'war_cry', cat: 'battle_cry', files: ['warrior_select', 'nobody'] },
      silent: { file: 'nothing_here', cat: 'ui' },
    },
  }))
  handle = (await import('../http.ts')).handle
  sounds = await import('./sounds.ts')
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call (method: string, url: string, body?: Buffer | string): Promise<{ status: number, body: any, raw: string, type?: string }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(req, { method, url, headers: { 'x-rigsmith': '1' } })
  let status = 0
  let text = ''
  let type: string | undefined
  const res = { headersSent: false } as { headersSent: boolean, writeHead: (s: number, h?: Record<string, string>) => unknown, end: (t?: string | Buffer) => void }
  res.writeHead = (s: number, h?: Record<string, string>) => { status = s; type = h?.['content-type']; res.headersSent = true; return res }
  res.end = (t?: string | Buffer) => { text = t === undefined ? '' : t.toString() }
  await handle(req, res as unknown as ServerResponse)
  let parsed: unknown
  try { parsed = text === '' ? null : JSON.parse(text) } catch { parsed = null }
  return { status, body: parsed, raw: text, type }
}

describe("the game's sounds", () => {
  it('lists every mix id with the files the game picks from: its takes, a recorded file in a folder, a family, files listed', async () => {
    const r = await call('GET', '/api/game/sounds')
    expect(r.status).toBe(200)
    expect(r.body.found).toBe(true)
    const by = Object.fromEntries((r.body.sounds as Array<{ id: string, files: string[] }>).map(s => [s.id, s]))
    expect(by.sword_blow).toEqual({ id: 'sword_blow', cat: 'combat', files: ['sword_hit_1.wav', 'sword_hit_2.wav'], db: 5, pitch: 0 })
    // (the bare arrow_shoot.wav is a fallback beside recorded takes: the game plays only the takes)
    expect(by.bowshot.files).toEqual(['sfx/arrow_shoot_2.wav', 'sfx/arrow_shoot_3.wav'])
    expect(by.javelin_throw.files).toEqual(['sfx/javelin_throw.ogg'])
    expect(by.bark_select).toMatchObject({ family: true, files: ['sfx/archer_select.ogg', 'sfx/warrior_select.wav'] })
    expect(by.war_cry.files).toEqual(['sfx/warrior_select.wav'])
    expect(by.silent.files).toEqual([])
    expect((r.body.sounds as Array<{ id: string }>).map(s => s.id)).toEqual([...(r.body.sounds as Array<{ id: string }>).map(s => s.id)].sort())
  })

  it('serves a file of the game for a preview, nothing outside its audio folder', async () => {
    const r = await call('GET', '/api/game/sounds/file/sfx/javelin_throw.ogg')
    expect(r.status).toBe(200)
    expect(r.type).toBe('audio/ogg')
    expect(r.raw).toBe(WAV.toString())
    expect((await call('GET', '/api/game/sounds/file/sfx/missing.wav')).status).toBe(404)
    expect((await call('GET', '/api/game/sounds/file/../mix.json')).status).toBe(404)
    expect((await call('GET', '/api/game/sounds/file/mix.json')).status).toBe(404)
  })
})

describe("a character's own sounds", () => {
  const of = `/api/characters/${c.id}/sounds`

  it('keeps a dropped file under sounds/ by a clean name, once for the same bytes, numbered for another', async () => {
    expect((await call('GET', of)).body).toEqual([])
    const first = await call('POST', `${of}?name=${encodeURIComponent('Bow Twang!.WAV')}`, WAV)
    expect(first.status).toBe(201)
    expect(first.body).toEqual({ file: 'bow_twang.wav', sound: 'file:sounds/bow_twang.wav', bytes: WAV.length })
    expect(readFileSync(path.join(folder, 'sounds', 'bow_twang.wav'))).toEqual(WAV)
    expect((await call('POST', `${of}?name=bow_twang.wav`, WAV)).body.file).toBe('bow_twang.wav')
    expect((await call('POST', `${of}?name=bow_twang.wav`, Buffer.from('other bytes'))).body.file).toBe('bow_twang_2.wav')
    expect((await call('GET', of)).body.map((s: { file: string }) => s.file)).toEqual(['bow_twang.wav', 'bow_twang_2.wav'])
    const served = await call('GET', `${of}/bow_twang.wav`)
    expect(served.type).toBe('audio/wav')
    expect(served.raw).toBe(WAV.toString())
  })

  it("refuses what the game can't play, an empty file, and a character that isn't there", async () => {
    expect((await call('POST', `${of}?name=notes.txt`, WAV)).status).toBe(400)
    expect((await call('POST', `${of}?name=empty.wav`, '')).status).toBe(400)
    expect((await call('POST', `${of}`, WAV)).status).toBe(400)
    expect((await call('GET', '/api/characters/nobody-000000/sounds')).status).toBe(404)
    expect(existsSync(path.join(folder, 'sounds', 'notes.txt'))).toBe(false)
  })

  it('names a file plainly', () => {
    expect(sounds.soundName('Héllo World.MP3')).toBe('h_llo_world.mp3')
    expect(sounds.soundName('---.ogg')).toBe('sound.ogg')
  })
})
