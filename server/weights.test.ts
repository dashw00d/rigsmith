// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({ dir:'' }))
vi.mock('./workspace.ts',() => ({ characterDir:() => state.dir }))
import { publishRig } from './weights.ts'

beforeEach(async () => { state.dir = await mkdtemp(path.join(os.tmpdir(),'rigsmith-paint-publish-')) })
afterEach(async () => { await rm(state.dir,{recursive:true,force:true}) })
const file = (name: string): string => path.join(state.dir,name)
const painting = [{mesh:0,vertex:5,weights:[['Hand',1]] as Array<[string,number]>}]

describe('rig and paint publication', () => {
  it('publishes the remapped paint record with the new rig and clears stale addresses', async () => {
    await writeFile(file('rigged.glb'),'old rig')
    await writeFile(file('weight_edits.json'),'{"0:2":{"mesh":0,"vertex":2,"weights":[["Hand",1]]}}')
    await writeFile(file('candidate.glb'),'new rig')
    await publishRig('test',file('candidate.glb'),file('rigged.glb'),painting)
    expect(await readFile(file('rigged.glb'),'utf8')).toBe('new rig')
    expect(JSON.parse(await readFile(file('weight_edits.json'),'utf8'))).toEqual({'0:5':painting[0]})
    expect((await readdir(state.dir)).sort()).toEqual(['rigged.glb','weight_edits.json'])
  })

  it('restores the old rig if the paint record cannot be published', async () => {
    await writeFile(file('rigged.glb'),'old rig')
    await writeFile(file('candidate.glb'),'new rig')
    // An existing directory cannot be replaced by rename(file,directory).
    await mkdir(file('weight_edits.json'))
    await writeFile(file('weight_edits.json/sentinel'),'untouched')
    await expect(publishRig('test',file('candidate.glb'),file('rigged.glb'),painting)).rejects.toThrow()
    expect(await readFile(file('rigged.glb'),'utf8')).toBe('old rig')
    expect(await readFile(file('weight_edits.json/sentinel'),'utf8')).toBe('untouched')
    expect((await readdir(state.dir)).sort()).toEqual(['rigged.glb','weight_edits.json'])
  })

  it('does not create a painting record when no painting exists', async () => {
    await writeFile(file('candidate.glb'),'new rig')
    await publishRig('test',file('candidate.glb'),file('rigged.glb'),[])
    expect(await readdir(state.dir)).toEqual(['rigged.glb'])
  })
})
