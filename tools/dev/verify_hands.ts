// Dense, read-only hand contact/endpoint/motion verification.
// node tools/dev/verify_hands.ts report.json character-id clip-id [--free] [--coverage] [--midpoints]
import { writeFileSync } from 'node:fs'
import * as THREE from 'three'
import { body,entrySource,isBone } from '../lib/node3d.ts'
import { captureRest,retarget } from '../../src/engine/retarget.ts'
import { correctHandContacts,HandContactSurface } from '../../src/engine/handcontacts.ts'

const [output,id,clipId,...flags] = process.argv.slice(2)
if (!output || !id || !clipId) throw new Error('Pass report.json, character ID and clip ID')
const view = await body(id), src = await entrySource({clipId})
const clip = retarget(src.scene,captureRest(src.scene,isBone),src.clip,view.rest!,{fps:30,inPlace:true})
const start = performance.now()
const tipTolerance=flags.includes('--free')?view.height*.004:0
const solved = correctHandContacts(view.root,clip,{height:view.height,fps:30,loop:flags.includes('--loop'),protect:flags.includes('--protect')?['Left','Right']:[],tipTolerance})
const solveSeconds = (performance.now()-start)/1000
const surfaces = (['Left','Right'] as const).map(s => new HandContactSurface(view.root,s,view.height))
const bones = [...view.bones].filter(([n]) => /Hand.+[123]$/.test(n)).map(([,b]) => b)
const tips = [...view.bones].filter(([n]) => /Hand.+4$/.test(n)).map(([,b]) => b)
const saved: Array<{b:THREE.Object3D,p:THREE.Vector3,q:THREE.Quaternion,s:THREE.Vector3}> = []
view.root.traverse(b => saved.push({b,p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}))
const read = (motion: THREE.AnimationClip,offset=0): Array<{q:number[][],tips:THREE.Vector3[],length:number,lengths:number[],covered:number[]}> => {
  const mixer = new THREE.AnimationMixer(view.root), rows = []
  for (let f = 0; f < solved.frames-(offset>0?1:0); f++) {
    mixer.stopAllAction(); for (const {b,p,q,s} of saved) {b.position.copy(p);b.quaternion.copy(q);b.scale.copy(s)}
    const action = mixer.clipAction(motion);action.reset();action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();mixer.setTime(solved.frames===1?0:motion.duration*(f+offset)/(solved.frames-1));view.root.updateMatrixWorld(true)
    const lengths=surfaces.map(h=>h.length(view.height*1e-6))
    rows.push({q:bones.map(b=>b.quaternion.toArray()),tips:tips.map(b=>b.getWorldPosition(new THREE.Vector3())),length:lengths.reduce((s,v)=>s+v,0),lengths,covered:flags.includes('--coverage')||flags.includes('--midpoints')||tipTolerance>0?surfaces.map(h=>h.coveredArea(view.height*1e-6)):[]})
  }
  mixer.stopAllAction();mixer.uncacheRoot(view.root);return rows
}
const before = read(clip),after = read(solved.clip),dt = clip.duration/Math.max(1,solved.frames-1)
const acceleration = (poses: typeof before, group?: string): number => {
  const velocity: THREE.Vector3[][] = []
  for(let f=1;f<poses.length;f++) velocity.push(poses[f].q.map((q,b)=>{
    const turn=new THREE.Quaternion().fromArray(poses[f-1].q[b]).invert().multiply(new THREE.Quaternion().fromArray(q));if(turn.w<0)turn.set(-turn.x,-turn.y,-turn.z,-turn.w)
    const sin=Math.hypot(turn.x,turn.y,turn.z),angle=2*Math.atan2(sin,turn.w)
    return new THREE.Vector3(turn.x,turn.y,turn.z).multiplyScalar(sin<1e-10?0:angle/sin/dt)
  }))
  const values = velocity.slice(1).flatMap((v,f)=>v.flatMap((w,b)=>group === undefined || bones[b].name.startsWith(group) ? [w.clone().sub(velocity[f][b]).lengthSq()/(dt*dt)] : []))
  return Math.sqrt(values.reduce((s,x)=>s+x,0)/Math.max(1,values.length))
}
const tipMiss = Math.max(0,...after.flatMap((r,f)=>r.tips.map((p,i)=>p.distanceTo(before[f].tips[i]))))
const increases = after.flatMap((r,f)=>r.length>before[f].length+view.height*1e-5?[{frame:f,before:before[f].length,after:r.length}]:[])
const coverageIncreases=after.flatMap((r,f)=>r.covered.flatMap((a,s)=>a>before[f].covered[s]+view.height**2*1e-9?[{frame:f,side:s,before:before[f].covered[s],after:a}]:[]))
const contactRegressions=after.flatMap((r,f)=>r.lengths.flatMap((a,s)=>a>before[f].lengths[s]+view.height*1e-5&&!(r.covered[s]<before[f].covered[s]-view.height**2*1e-10)?[{frame:f,side:s,before:before[f].lengths[s],after:a}]:[]))
const {clip:result,...report} = solved
const motion = [...new Set(bones.map(b=>b.name.slice(0,-1)))].map(name=>({name,before:acceleration(before,name),after:acceleration(after,name)}))
const changedOtherTracks=clip.tracks.filter(t=>!/(?:Left|Right)Hand(?:Index|Middle|Ring|Pinky|Thumb)[123]\.quaternion$/.test(t.name)).filter(t=>result.tracks.find(r=>r.name===t.name)!==t).map(t=>t.name)
const midBefore=flags.includes('--midpoints')?read(clip,.5):[],midAfter=flags.includes('--midpoints')?read(result,.5):[]
const midpointCoverageIncreases=midAfter.flatMap((r,f)=>r.covered.flatMap((a,s)=>a>midBefore[f].covered[s]+view.height**2*1e-9?[{frame:f+.5,side:s,before:midBefore[f].covered[s],after:a}]:[]))
const midpointContactRegressions=midAfter.flatMap((r,f)=>r.lengths.flatMap((a,s)=>a>midBefore[f].lengths[s]+view.height*1e-5&&!(r.covered[s]<midBefore[f].covered[s]-view.height**2*1e-10)?[{frame:f+.5,side:s,before:midBefore[f].lengths[s],after:a}]:[]))
const midpointTipMiss=Math.max(0,...midAfter.flatMap((r,f)=>r.tips.map((p,i)=>p.distanceTo(midBefore[f].tips[i]))))
const passed=Math.max(tipMiss,midpointTipMiss)<Math.max(tipTolerance,view.height*1e-5)+view.height*1e-7 && contactRegressions.length===0 && coverageIncreases.length===0 && midpointCoverageIncreases.length===0 && midpointContactRegressions.length===0 && changedOtherTracks.length===0 && motion.every(m=>m.after<=m.before*(1+1e-4)+.01)
writeFileSync(output,JSON.stringify({id,clipId,...report,passed,solveSeconds,seconds:(performance.now()-start)/1000,tipTolerance,verifiedTipMiss:tipMiss,increases,coverageIncreases,contactRegressions,midpointFrames:midBefore.length,midpointTipMiss,midpointCoverageIncreases,midpointContactRegressions,changedOtherTracks,sourceAcceleration:acceleration(before),solvedAcceleration:acceleration(after),motion,framesDetail:before.map((r,f)=>({frame:f,before:r.length,after:after[f].length,lengthsBefore:r.lengths,lengthsAfter:after[f].lengths,coveredBefore:r.covered,coveredAfter:after[f].covered})),midpoints:midBefore.map((r,f)=>({frame:f+.5,before:r.length,after:midAfter[f].length,lengthsBefore:r.lengths,lengthsAfter:midAfter[f].lengths,coveredBefore:r.covered,coveredAfter:midAfter[f].covered})),tracks:result.toJSON()},null,2))
console.log(JSON.stringify({id,clipId,passed,frames:report.frames,accepted:report.fingers.filter(f=>f.accepted).length,before:report.before,after:report.after,tipMiss,increasedFrames:increases.length,sourceAcceleration:acceleration(before),solvedAcceleration:acceleration(after)}))
if(!passed) process.exitCode=1
