// Compare generated weights with the previous weights on the NEW skeleton.
// Transfer only between matching bind geometry; never undo edited joint placements.
// node tools/skin_opt/validate.ts <candidate.glb> <previous.glb> <human|horse|...>
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { load, entrySource, isBone, ROOT } from '../lib/node3d.ts'
import { captureRest, retarget } from '../../src/engine/retarget.ts'
import { writeWeights, type WeightEdit } from '../../server/weights.ts'

const [candidate, previous, template = 'human'] = process.argv.slice(2)
const sets = JSON.parse(readFileSync(path.join(ROOT, 'static/templates/tests.json'), 'utf8')) as Record<string, Array<{ id: string, name: string, url?: string }>>
const tests = sets[template] ?? []
const root = (await load(candidate)).scene
const oldRoot = (await load(previous)).scene
root.updateMatrixWorld(true); oldRoot.updateMatrixWorld(true)
const meshes = (r: THREE.Object3D): THREE.SkinnedMesh[] => {
  const out: THREE.SkinnedMesh[] = []
  r.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh) })
  return out
}
const now = meshes(root); const old = meshes(oldRoot)
const edits: WeightEdit[] = []
const point = new THREE.Vector3(); const other = new THREE.Vector3()
function transferable (): boolean {
  if (now.length === 0 || now.length !== old.length) return false
  for (let part = 0; part < now.length; part++) {
    const m = now[part]; const was = old[part]
    const p = m.geometry.attributes.position; const q = was.geometry.attributes.position
    // Skin addresses belong to vertices; every bind position must have a match.
    if (p.count !== q.count) return false
    const allowed = new Set(m.skeleton.bones.map(b => b.name))
    const wi = was.geometry.attributes.skinIndex; const ww = was.geometry.attributes.skinWeight
    const box = new THREE.Box3().setFromObject(m)
    const tolerance = Math.max(box.getSize(new THREE.Vector3()).length() * 0.001, 1e-7)
    const cells = new Map<string, Array<{ point: THREE.Vector3, weights: Array<[string, number]> }>>()
    const cell = (v: THREE.Vector3): number[] => [v.x, v.y, v.z].map(x => Math.floor(x / tolerance))
    for (let v = 0; v < q.count; v++) {
      other.fromBufferAttribute(q, v).applyMatrix4(was.matrixWorld)
      const weights: Array<[string, number]> = []
      for (let k = 0; k < 4; k++) {
        const w = ww.getComponent(v, k)
        if (!Number.isFinite(w) || w < 0) return false
        if (w > 0) {
          const name = was.skeleton.bones[wi.getComponent(v, k)]?.name
          if (!name || !allowed.has(name)) return false
          weights.push([name, w])
        }
      }
      if (Math.abs(weights.reduce((s, [, w]) => s + w, 0) - 1) > 1e-4) return false
      const key = cell(other).join(',')
      if (!cells.has(key)) cells.set(key, [])
      cells.get(key)!.push({ point: other.clone(), weights })
    }
    // Importers may reorder vertices and small-hole repair may move a few by a
    // fraction of a millimetre. Match in bind space, never by incidental GLB order.
    for (let v = 0; v < p.count; v++) {
      point.fromBufferAttribute(p, v).applyMatrix4(m.matrixWorld)
      const c = cell(point)
      let best: Array<[string, number]> | undefined
      let distance = tolerance * tolerance
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        for (const entry of cells.get([c[0]+x, c[1]+y, c[2]+z].join(',')) ?? []) {
          const d = point.distanceToSquared(entry.point)
          if (d < distance) { distance = d; best = entry.weights }
        }
      }
      if (best === undefined) return false
      edits.push({ mesh: part, vertex: v, weights: best })
    }
  }
  return true
}
if (tests.length === 0) {
  console.log(JSON.stringify({ compared: false, retained: false, reason: `No deformation checks for ${template}` }))
} else if (!transferable()) {
  console.log(JSON.stringify({ compared: false, retained: false, reason: 'Geometry or bone set changed' }))
} else {
  const rest = captureRest(root, isBone)
  const clips: THREE.AnimationClip[] = []
  for (const test of tests) {
    const src = await entrySource({clipId:test.id,url:test.url})
    clips.push(retarget(src.scene, captureRest(src.scene,isBone),src.clip,rest,{fps:30,inPlace:true}))
  }
  const data = now.map(m => {
    const p = m.geometry.attributes.position
    const positions = new Float64Array(p.count * 3)
    for (let v=0;v<p.count;v++) point.fromBufferAttribute(p,v).applyMatrix4(m.matrixWorld).toArray(positions,v*3)
    const indices = m.geometry.index!; const edges = new Map<string,[number,number]>()
    for (let i=0;i<indices.count;i+=3) {
      const t=[indices.getX(i),indices.getX(i+1),indices.getX(i+2)]
      for(let k=0;k<3;k++){const a=Math.min(t[k],t[(k+1)%3]);const b=Math.max(t[k],t[(k+1)%3]);edges.set(`${a},${b}`,[a,b])}
    }
    const dist=(p:Float64Array,a:number,b:number):number=>Math.hypot(p[a*3]-p[b*3],p[a*3+1]-p[b*3+1],p[a*3+2]-p[b*3+2])
    return {m,positions,dist,edges:[...edges.values()].map(([a,b])=>({a,b,length:dist(positions,a,b)})).filter(e=>e.length>1e-6)}
  })
  function score (): number[] {
    return clips.map(clip=>{
      const mixer=new THREE.AnimationMixer(root);mixer.clipAction(clip).play()
      let squared=0,count=0
      for(let f=0;f<8;f++){
        mixer.setTime(clip.duration*(f+.5)/8);root.updateMatrixWorld(true)
        for(const d of data){
          d.m.skeleton.update();const posed=new Float64Array(d.positions.length)
          for(let v=0;v<posed.length/3;v++)d.m.getVertexPosition(v,point).applyMatrix4(d.m.matrixWorld).toArray(posed,v*3)
          for(const e of d.edges){const log=Math.log(Math.max(d.dist(posed,e.a,e.b)/e.length,1e-9));squared+=log*log;count++}
        }
      }
      mixer.stopAllAction();mixer.uncacheRoot(root)
      return Math.sqrt(squared/Math.max(count,1))
    })
  }
  const generated=score()
  for(const e of edits){
    const m=now[e.mesh];const si=m.geometry.attributes.skinIndex;const sw=m.geometry.attributes.skinWeight
    for(let k=0;k<4;k++){si.setComponent(e.vertex,k,e.weights[k]?m.skeleton.bones.findIndex(b=>b.name===e.weights[k][0]):0);sw.setComponent(e.vertex,k,e.weights[k]?.[1]??0)}
  }
  const prior=score()
  const average=(a:number[]):number=>a.reduce((s,x)=>s+x,0)/a.length
  if (![...generated,...prior].every(Number.isFinite)) throw new Error('Non-finite deformation check')
  // A worse overall result, or a substantial regression on any test, retains the
  // previous skin. The previous weights are evaluated on exactly these new joints.
  const retained=average(generated)>average(prior)*1.01 || generated.some((x,i)=>x>prior[i]*1.1)
  if(retained) await writeWeights(candidate,edits)
  console.log(JSON.stringify({compared:true,retained,generated:average(generated),previous:average(prior),clips:tests.map((t,i)=>({name:t.name,generated:generated[i],previous:prior[i]}))}))
}
