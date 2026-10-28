// Validate isolated auto-rig outputs against their input placements and deformation tests.
// node tools/dev/verify_rigs.ts <generated directory> <report.json> [--extended]
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { character, entrySource, isBone, load } from '../lib/node3d.ts'
import { deformationTests } from '../lib/deformation.ts'
import { captureRest, retarget } from '../../src/engine/retarget.ts'

const [dir, output, ...options] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8')) as Array<{ id: string, name: string, ok: boolean }>
const tests = deformationTests(options.includes('--extended'))
const sources = new Map<string, Awaited<ReturnType<typeof entrySource>>>()
const rows = []
for (const c of manifest) {
  if (!c.ok) { rows.push({ id: c.id, name: c.name, ok: false }); continue }
  const record = character(c.id)
  const generated = JSON.parse(readFileSync(path.join(dir, c.id, 'report.json'), 'utf8'))
  const root = (await load(path.join(dir, c.id, 'rigged.glb'))).scene
  root.updateMatrixWorld(true)
  const rest = captureRest(root, isBone)
  const meshes: THREE.SkinnedMesh[] = []
  root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh) })
  const errors: string[] = []
  let maxJointError = 0; let vertices = 0; let badWeights = 0; let seamMismatch = 0
  const seams = new Map<string, Map<string, number>>()
  const point = new THREE.Vector3()
  for (const [name, pos] of Object.entries(generated.joints) as Array<[string, number[]]>) {
    const b = root.getObjectByName(name)
    if (b === undefined) errors.push(`missing bone ${name}`)
    else maxJointError = Math.max(maxJointError, b.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(...pos)))
  }
  const data = meshes.map(m => {
    const p = m.geometry.attributes.position; const si = m.geometry.attributes.skinIndex; const sw = m.geometry.attributes.skinWeight
    vertices += p.count
    const positions = new Float64Array(p.count * 3)
    for (let v = 0; v < p.count; v++) {
      point.fromBufferAttribute(p, v).applyMatrix4(m.matrixWorld).toArray(positions, v * 3)
      let sum = 0; const weights = new Map<string, number>()
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(v, k); const j = si.getComponent(v, k)
        if (!Number.isFinite(w) || w < 0 || !m.skeleton.bones[j]) badWeights++
        sum += w
        if (w > 0) weights.set(m.skeleton.bones[j].name, (weights.get(m.skeleton.bones[j].name) ?? 0) + w)
      }
      if (Math.abs(sum - 1) > 1e-5) badWeights++
      const key = [point.x, point.y, point.z].map(x => Math.round(x * 1e6)).join(',')
      const previous = seams.get(key)
      if (previous && [...new Set([...previous.keys(), ...weights.keys()])].some(n => Math.abs((previous.get(n) ?? 0) - (weights.get(n) ?? 0)) > 1e-5)) seamMismatch++
      seams.set(key, weights)
    }
    const edges = new Map<string, [number, number]>()
    const indices = m.geometry.index
    const indexCount = indices?.count ?? p.count
    for (let i = 0; i < indexCount; i += 3) {
      const tri = indices ? [indices.getX(i), indices.getX(i+1), indices.getX(i+2)] : [i, i+1, i+2]
      for (let k = 0; k < 3; k++) { const a = Math.min(tri[k], tri[(k+1)%3]); const b = Math.max(tri[k], tri[(k+1)%3]); edges.set(`${a},${b}`, [a,b]) }
    }
    const distance = (p: Float64Array, a: number, b: number): number => Math.hypot(p[a*3]-p[b*3], p[a*3+1]-p[b*3+1],p[a*3+2]-p[b*3+2])
    return { mesh:m, positions, edges:[...edges.values()].map(([a,b]) => ({a,b,length:distance(positions,a,b)})).filter(e=>e.length>1e-6), distance }
  })
  if (maxJointError > 1e-5) errors.push('exported joints differ from placements')
  if (badWeights) errors.push(`${badWeights} invalid weights`)
  if (seamMismatch) errors.push(`${seamMismatch} split seam weights differ`)
  const clips = []
  for (const test of tests[record.skeleton.template] ?? []) {
    const key = test.url ?? test.id
    let source = sources.get(key)
    if (!source) { source = await entrySource({clipId:test.id,url:test.url}); sources.set(key,source) }
    const clip = retarget(source.scene, captureRest(source.scene,isBone), source.clip, rest, {fps:30,inPlace:true})
    const mixer = new THREE.AnimationMixer(root); mixer.clipAction(clip).play()
    let sum = 0; let squared = 0; let count = 0; let over2 = 0; let collapsed = 0; let max = 0; const p99 = []
    for (let frame=0; frame<8; frame++) {
      mixer.setTime(clip.duration * (frame+0.5)/8); root.updateMatrixWorld(true)
      const ratios=[]
      for (const d of data) {
        d.mesh.skeleton.update(); const now = new Float64Array(d.positions.length)
        for (let v=0;v<now.length/3;v++) { d.mesh.getVertexPosition(v,point).applyMatrix4(d.mesh.matrixWorld).toArray(now,v*3) }
        if (!now.every(Number.isFinite)) errors.push(`${test.name}: nonfinite posed vertices`)
        for (const e of d.edges) { const r=d.distance(now,e.a,e.b)/e.length; const log=Math.abs(Math.log(Math.max(r,1e-9)));sum+=log;squared+=log*log;count++;if(r>2)over2++;if(r<.5)collapsed++;max=Math.max(max,r);ratios.push(log) }
      }
      ratios.sort((a,b)=>a-b);p99.push(ratios[Math.floor(ratios.length*.99)])
    }
    mixer.stopAllAction(); mixer.uncacheRoot(root)
    if (count === 0) errors.push(`${test.name}: no surface edges to validate`)
    clips.push({name:test.name,frames:8,meanLogStretch:sum/count,rmsLogStretch:Math.sqrt(squared/count),p99LogStretch:p99.reduce((a,b)=>a+b,0)/p99.length,edgesOver2:over2/count,edgesUnderHalf:collapsed/count,maxStretch:max})
  }
  const row = {id:c.id,name:c.name,ok:errors.length===0,vertices,bones:rest.bones.size,maxJointError,badWeights,seamMismatch,errors,clips}
  rows.push(row); console.log(c.name,row.ok?'OK':errors.join('; '),clips.map(c=>`${c.name}:${(c.edgesOver2*100).toFixed(2)}%`).join(' '))
}
writeFileSync(output,JSON.stringify(rows,null,2))
if (rows.some(r=>!r.ok)) process.exitCode=1
