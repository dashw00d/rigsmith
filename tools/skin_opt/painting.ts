// Read-only geometry mapping; write only the temporary paint record requested by
// the parent rig transaction. No live rig or paint record is changed here.
import { readFileSync, writeFileSync } from 'node:fs'
import { load } from '../lib/node3d.ts'
import { transferPainting } from '../lib/skintransfer.ts'
import type { WeightEdit } from '../../server/weights.ts'

const [target,source,input,output] = process.argv.slice(2)
if (!target || !source || !input || !output) throw new Error('Pass candidate.glb previous.glb paint.json mapped.json')
const old = (await load(source)).scene, now = (await load(target)).scene
const edits = JSON.parse(readFileSync(input,'utf8')) as WeightEdit[]
writeFileSync(output,JSON.stringify(transferPainting(now,old,edits)))
