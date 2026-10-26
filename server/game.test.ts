import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { spliceUnit, type UnitSpec } from './game.ts'

const sample = `{
 "_doc": ["x"],
 "units": {
  "a": {
   "character": "a-1",
   "height": 2.0,
   "clips": ["Idle"]
  },
  "b": {
   "character": "b-1",
   "height": 1.5,
   "clips": ["Idle", "Walk"]
  }
 }
}
`
const entry: UnitSpec = { character: 'a-2', height: 2.1, budget: 8000, clips: ['Idle', 'Walk'] }

describe('the game units.json splice', () => {
  it('replaces one unit and keeps every other byte', () => {
    const out = spliceUnit(sample, 'a', entry)
    expect(JSON.parse(out).units.a).toEqual(entry)
    expect(out.slice(out.indexOf('  "b"'))).toBe(sample.slice(sample.indexOf('  "b"')))
    expect(out.startsWith('{\n "_doc": ["x"],\n "units": {\n  "a": {\n   "character": "a-2",')).toBe(true)
  })
  it('adds a unit at the end and takes one out', () => {
    const added = spliceUnit(sample, 'c', entry)
    expect(Object.keys(JSON.parse(added).units)).toEqual(['a', 'b', 'c'])
    expect(JSON.parse(spliceUnit(added, 'b', null)).units).toEqual({ a: JSON.parse(sample).units.a, c: entry })
    expect(JSON.parse(spliceUnit(sample, 'b', null)).units).toEqual({ a: JSON.parse(sample).units.a })
  })
  it("leaves the game's own file unchanged when a unit is written back as it is", () => {
    const file = path.join(homedir(), 'dev', 'games', 'emberhold', 'tools', 'rigsmith', 'units.json')
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { return }
    const units = JSON.parse(text).units as Record<string, UnitSpec>
    const name = Object.keys(units).find(u => !/\d\.0\b/.test(JSON.stringify(units[u])) && !text.includes(`"${u}": {\n   "_`))
    if (name === undefined) return
    const again = spliceUnit(text, name, units[name])
    expect(JSON.parse(again)).toEqual(JSON.parse(text))
    // (only that block can differ, and only by how its numbers are written)
    expect(again.slice(0, again.indexOf(`  "${name}": {`))).toBe(text.slice(0, text.indexOf(`  "${name}": {`)))
  })
})
