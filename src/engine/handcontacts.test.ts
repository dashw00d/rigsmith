// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { describe,expect,it,vi } from 'vitest'
import { body,entrySource,isBone } from '../../tools/lib/node3d.ts'
import { captureRest,retarget,retargetOffsets } from './retarget.ts'
import { correctHandContacts,correctHandContactsAsync,HandContactSurface } from './handcontacts.ts'
import { JointLimits,type Rom } from './limits.ts'

function triangleHand (): {root:THREE.Group,mesh:THREE.SkinnedMesh,bone:THREE.Bone} {
  const root = new THREE.Group(), bone = new THREE.Bone(), geo = new THREE.BufferGeometry()
  bone.name = 'LeftHand'; root.add(bone)
  geo.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,1,-1,0,0,1,0,0,-.5,-1,0,-.5,1,0,.5,0],3))
  geo.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Array(24).fill(0),4))
  geo.setAttribute('skinWeight',new THREE.Float32BufferAttribute(Array.from({length:24},(_,i)=>i%4===0?1:0),4))
  const mesh = new THREE.SkinnedMesh(geo,new THREE.MeshBasicMaterial()); root.add(mesh)
  root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([bone])); return {root,mesh,bone}
}
describe('rendered hand surface',()=>{
  it('falls back to the full field when a moving patch has an open boundary',()=>{
    const {root,mesh,bone}=triangleHand(),finger=new THREE.Bone()
    finger.name='LeftHandIndex1';bone.add(finger);root.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton([bone,finger]))
    mesh.geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(Array.from({length:24},(_,i)=>i<12?1:0),4))
    const surface=new HandContactSurface(root,'Left',2),trial=surface.trial(finger,1e-7,true)
    finger.rotation.x=.4
    const winding=vi.spyOn(surface.contacts,'signedWinding'),partial=trial.coveredArea()
    expect(winding).toHaveBeenCalledTimes(6)
    winding.mockRestore()
    expect(partial).toBeCloseTo(surface.coveredArea(1e-7),12)
  })
  it('detects a fully buried shell and does not reward compressing it',()=>{
    const vertices=[-1,-1,-1,1,-1,-1,1,1,-1,-1,1,-1,-1,-1,1,1,-1,1,1,1,1,-1,1,1]
    const faces=[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5]
    const root=new THREE.Group(),hand=new THREE.Bone(),finger=new THREE.Bone(),geo=new THREE.BufferGeometry()
    hand.name='LeftHand';finger.name='LeftHandIndex1';root.add(hand);hand.add(finger)
    geo.setAttribute('position',new THREE.Float32BufferAttribute([...vertices,...vertices.map(x=>x*.5)],3))
    geo.setIndex([...faces,...faces.map(v=>v+8)])
    geo.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(Array.from({length:64},(_,i)=>i>=32?1:0),4))
    geo.setAttribute('skinWeight',new THREE.Float32BufferAttribute(Array.from({length:64},(_,i)=>i%4===0?1:0),4))
    const mesh=new THREE.SkinnedMesh(geo,new THREE.MeshBasicMaterial());root.add(mesh);root.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton([hand,finger]))
    const surface=new HandContactSurface(root,'Left',2)
    expect(surface.length(1e-7)).toBe(0)
    expect(surface.coveredArea(1e-7)).toBeCloseTo(6,10)
    finger.scale.setScalar(.25)
    expect(surface.coveredArea(1e-7)).toBeCloseTo(6,10)
    finger.position.x=3
    expect(surface.coveredArea(1e-7)).toBeCloseTo(0,10)
  })
  it('rejects an Object3D clone whose skeleton still belongs to the live character',()=>{
    const {root}=triangleHand()
    expect(()=>new HandContactSurface(root.clone(true),'Left',2)).toThrow('owned by its pose root')
  })
  it('follows its own cloned skeleton, root transforms and morph targets',()=>{
    const {root,mesh,bone} = triangleHand(), copy=cloneSkinned(root), copied=copy.children.find(o=>(o as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh
    root.position.set(4,3,2); bone.rotation.z=.7; root.updateMatrixWorld(true)
    copy.position.set(-2,1,5); copy.scale.setScalar(2); copy.getObjectByName('LeftHand')!.rotation.x=.4; copy.updateMatrixWorld(true)
    const surface = new HandContactSurface(copy,'Left',2)
    const positions = surface.read()
    for(let v=0;v<6;v++) expect(new THREE.Vector3().fromArray(positions,v*3).distanceTo(copied.getVertexPosition(v,new THREE.Vector3()).applyMatrix4(copied.matrixWorld))).toBeLessThan(1e-12)
    expect(surface.length(1e-7)).toBeCloseTo(2,6)
    expect(copied.skeleton).not.toBe(mesh.skeleton)
    // Constructing while posed cannot weld different vertices or cache the old skin.
    copied.geometry = copied.geometry.clone()
    copied.geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(new Array(18).fill(0).map((_,i)=>i%3===0?.1:0),3)]
    copied.geometry.morphTargetsRelative = true; copied.updateMorphTargets(); copied.morphTargetInfluences![0]=1
    const after=surface.read()
    for(let v=0;v<6;v++) expect(new THREE.Vector3().fromArray(after,v*3).distanceTo(copied.getVertexPosition(v,new THREE.Vector3()).applyMatrix4(copied.matrixWorld))).toBeLessThan(1e-12)
  })
  it('matches the renderer with blended weights, nonidentity binds and both bind modes',()=>{
    const {root,mesh,bone}=triangleHand(),a=new THREE.Bone(),b=new THREE.Bone()
    a.name='LeftHandIndex1';b.name='LeftHandIndex2';a.position.set(.2,.3,0);b.position.set(.1,.2,.1);bone.add(a);a.add(b)
    mesh.position.set(.3,-.7,.2);mesh.rotation.set(.3,.2,.1);mesh.scale.set(2,.5,1.2)
    root.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton([bone,a,b]),mesh.matrixWorld)
    mesh.geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(Array.from({length:24},(_,i)=>[0,1,2,0][i%4]),4))
    mesh.geometry.setAttribute('skinWeight',new THREE.Uint8BufferAttribute(Array.from({length:24},(_,i)=>[51,77,127,0][i%4]),4,true))
    a.rotation.x=.5;b.rotation.z=.8;root.position.set(-20,8,12)
    for(const mode of [THREE.AttachedBindMode,THREE.DetachedBindMode]) {
      mesh.bindMode=mode
      const surface=new HandContactSurface(root,'Left',2),trial=surface.trial(a,1e-7)
      for(const angle of [.2,-.5]) {
        a.rotation.y=angle;trial.length()
        for(let v=0;v<6;v++) expect(new THREE.Vector3().fromArray(surface.positions,v*3).distanceTo(mesh.getVertexPosition(v,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld))).toBeLessThan(1e-12)
      }
    }
  })
})

const have = existsSync('workspace/characters/skirmisher-19c713/rigged.glb') && existsSync('workspace/library/clips/mixamo-Grab_And_Slam.glb')
async function heldPose (): Promise<{root:THREE.Object3D,clip:THREE.AnimationClip,height:number}> {
  const view=await body('skirmisher-19c713'), source=await entrySource({clipId:'mixamo-Grab_And_Slam'})
  const sourceClip=retarget(source.scene,captureRest(source.scene,isBone),source.clip,view.rest!,{fps:30,inPlace:true})
  const mixer=new THREE.AnimationMixer(view.root); mixer.clipAction(sourceClip).play();mixer.setTime(97/30);view.root.updateMatrixWorld(true)
  const tracks:THREE.KeyframeTrack[]=[]
  for(const b of view.bones.values()) tracks.push(new THREE.QuaternionKeyframeTrack(b.name+'.quaternion',[0,.1],[...b.quaternion.toArray(),...b.quaternion.toArray()]))
  const prop=new THREE.Object3D();prop.name='test-prop';view.root.add(prop)
  tracks.push(new THREE.VectorKeyframeTrack('test-prop.position',[0,.1],[0,0,0,1,2,3]))
  mixer.stopAllAction();mixer.uncacheRoot(view.root)
  return {root:view.root,clip:new THREE.AnimationClip('held curl',.1,tracks),height:view.height}
}
const transforms = (root:THREE.Object3D): number[][] => {const out:number[][]=[];root.traverse(b=>out.push([...b.position.toArray(),...b.quaternion.toArray(),...b.scale.toArray()]));return out}
describe.skipIf(!have)('endpoint-preserving contact correction',()=>{
  it('reuses only unaffected skin and contacts within a finger trial',async()=>{
    const {root,clip,height}=await heldPose(),surface=new HandContactSurface(root,'Left',height),mixer=new THREE.AnimationMixer(root)
    mixer.clipAction(clip).play();mixer.setTime(.05)
    const wrist=root.getObjectByName('LeftHand')!,bone=root.getObjectByName('LeftHandIndex1') as THREE.Bone,source=bone.quaternion.clone()
    for(const wristAngle of [0,.3,-.4]) {
      wrist.rotation.z=wristAngle;bone.quaternion.copy(source)
      const trial=surface.trial(bone,height*1e-6)
      expect(trial.baseline).toBeCloseTo(surface.length(height*1e-6),12)
      for(const angle of [-.2,.1,.25,0]) {
        bone.quaternion.copy(source).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),angle))
        const partial=trial.length(),positions=Array.from(surface.positions),full=surface.length(height*1e-6)
        expect(partial).toBeCloseTo(full,11)
        expect(positions).toEqual(Array.from(surface.positions))
      }
    }
  })
  it('reuses covered samples only outside a closed moving patch, matching a full query',async()=>{
    const {root,clip,height}=await heldPose(),surface=new HandContactSurface(root,'Left',height),mixer=new THREE.AnimationMixer(root)
    mixer.clipAction(clip).play();mixer.setTime(.05)
    const bone=root.getObjectByName('LeftHandIndex1') as THREE.Bone,source=bone.quaternion.clone()
    const trial=surface.trial(bone,height*1e-6,true)
    expect(trial.coveredBaseline).toBeCloseTo(surface.coveredArea(height*1e-6),12)
    for(const angle of [-.15,.1,.25,0]){
      bone.quaternion.copy(source).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),angle))
      expect(trial.coveredArea()).toBeCloseTo(surface.coveredArea(height*1e-6),12)
    }
    mixer.stopAllAction();mixer.uncacheRoot(root)
  })
  it('keeps coverage snapshots independent when trial frames are interleaved',async()=>{
    const {root,clip,height}=await heldPose(),surface=new HandContactSurface(root,'Left',height),mixer=new THREE.AnimationMixer(root)
    mixer.clipAction(clip).play();mixer.setTime(.05)
    const bone=root.getObjectByName('LeftHandIndex1') as THREE.Bone,source=bone.quaternion.clone(),wrist=root.getObjectByName('LeftHand')!,wristSource=wrist.quaternion.clone()
    const frames=[0,.4].map(angle=>{
      wrist.quaternion.copy(wristSource).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),angle));bone.quaternion.copy(source)
      return {wrist:wrist.quaternion.clone(),trial:surface.trial(bone,height*1e-6,true)}
    })
    for(const index of [0,1,0]){
      wrist.quaternion.copy(frames[index].wrist);bone.quaternion.copy(source).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),.1));root.updateMatrixWorld(true)
      expect(frames[index].trial.coveredArea()).toBeCloseTo(surface.coveredArea(height*1e-6),12)
      expect(frames[index].trial.length()).toBeCloseTo(surface.length(height*1e-6),11)
    }
    mixer.stopAllAction();mixer.uncacheRoot(root)
  })
  it('leaves fully protected grips and rigs without fingers byte-for-byte intact',async()=>{
    const {root,clip,height}=await heldPose()
    expect(correctHandContacts(root,clip,{height,protect:['Left','Right'],tipTolerance:height*.004}).clip).toBe(clip)
    expect(correctHandContacts(new THREE.Group(),clip,{height}).clip).toBe(clip)
  })
  it('reduces an actual closed hand while retaining fingertips, a protected hand, prop tracks and the input pose',async()=>{
    const {root,clip,height}=await heldPose(), initial=transforms(root)
    const solved=correctHandContacts(root,clip,{height,fps:30,protect:['Right']})
    expect(solved.changedFrames).toBeGreaterThan(0)
    expect(solved.after).toBeLessThan(solved.before*.99)
    expect(solved.tipMiss).toBeLessThan(height*1e-5)
    expect(transforms(root)).toEqual(initial)
    for(const track of clip.tracks.filter(t=>!/^LeftHand(?:Index|Middle|Ring|Pinky|Thumb)[123]\.quaternion$/.test(t.name))) expect(solved.clip.tracks.find(t=>t.name===track.name)).toBe(track)
    const sample=(c:THREE.AnimationClip):THREE.Vector3[]=>{
      const mixer=new THREE.AnimationMixer(root);mixer.clipAction(c).play();mixer.setTime(.05);root.updateMatrixWorld(true)
      const points:THREE.Vector3[]=[];root.traverse(b=>{if(/^LeftHand.+4$/.test(b.name)) points.push(b.getWorldPosition(new THREE.Vector3()))})
      mixer.stopAllAction();mixer.uncacheRoot(root);return points
    }
    const before=sample(clip),after=sample(solved.clip)
    expect(Math.max(...before.map((p,i)=>p.distanceTo(after[i])))).toBeLessThan(height*1e-5)
  },20000)
  it('restores all transforms if cancellation happens during a trial',async()=>{
    const {root,clip,height}=await heldPose(), initial=transforms(root)
    let cancel=false
    await expect(correctHandContactsAsync(root,clip,{height,progress:()=>{cancel=true},cancelled:()=>cancel})).rejects.toMatchObject({name:'AbortError'})
    expect(transforms(root)).toEqual(initial)
  },10000)
  it('also restores the pose when cancelled during the covered-surface check',async()=>{
    const {root,clip,height}=await heldPose(),initial=transforms(root)
    let cancel=false
    await expect(correctHandContactsAsync(root,clip,{height,progress:(_done,_total,phase)=>{cancel=phase==='clearance'},cancelled:()=>cancel})).rejects.toMatchObject({name:'AbortError'})
    expect(cancel).toBe(true);expect(transforms(root)).toEqual(initial)
  },10000)
  it('restores the pose when cancelled while checking clip interpolation',async()=>{
    const {root,clip,height}=await heldPose(),initial=transforms(root)
    let cancel=false
    await expect(correctHandContactsAsync(root,clip,{height,progress:(_done,_total,phase)=>{cancel=phase==='trajectory'},cancelled:()=>cancel})).rejects.toMatchObject({name:'AbortError'})
    expect(cancel).toBe(true);expect(transforms(root)).toEqual(initial)
  },10000)
  it('joins a loop with the same finger correction while retaining the prop travel',async()=>{
    const {root,clip,height}=await heldPose()
    clip.duration=.2
    for(const track of clip.tracks) track.times[1]=.2
    const track=clip.tracks.find(t=>t.name==='LeftHandMiddle2.quaternion')!
    const q=new THREE.Quaternion().fromArray(track.values), mid=q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),.03))
    track.times=new Float32Array([0,.1,.2]);track.values=new Float32Array([...q.toArray(),...mid.toArray(),...q.toArray()])
    const result=correctHandContacts(root,clip,{height,loop:true,protect:['Right']})
    expect(result.changedFrames).toBeGreaterThan(0)
    for(const t of result.clip.tracks.filter(t=>/^LeftHand.+\.quaternion$/.test(t.name))) expect(new THREE.Quaternion().fromArray(t.values).normalize().angleTo(new THREE.Quaternion().fromArray(t.values,t.values.length-4).normalize())).toBeLessThan(1e-6)
    expect(result.clip.tracks.find(t=>t.name==='test-prop.position')).toBe(clip.tracks.find(t=>t.name==='test-prop.position'))
  },20000)
  it('has identical sync and async results',async()=>{
    const {root,clip,height}=await heldPose(), opts={height,protect:['Right'] as const}
    const sync=correctHandContacts(root,clip,opts), async=await correctHandContactsAsync(root,clip,opts)
    expect(async.clip.tracks.map(t=>[t.name,Array.from(t.times),Array.from(t.values)])).toEqual(sync.clip.tracks.map(t=>[t.name,Array.from(t.times),Array.from(t.values)]))
    expect(async.fingers).toEqual(sync.fingers)
  },20000)
  it('finds a smooth free-finger trajectory through a changing grab contact',async()=>{
    const view=await body('skirmisher-19c713'),src=await entrySource({clipId:'mixamo-Grab_And_Slam'})
    const full=retarget(src.scene,captureRest(src.scene,isBone),src.clip,view.rest!,{fps:30,inPlace:true})
    const clip=THREE.AnimationUtils.subclip(full,'changing grab',72,96,30),initial=transforms(view.root)
    const result=correctHandContacts(view.root,clip,{height:view.height,tipTolerance:view.height*.004,protect:['Left']})
    expect(result.fingers.find(f=>f.name==='RightHandRing')?.mode).toBe('clearance')
    expect(result.fingers.find(f=>f.name==='RightHandThumb')?.mode).toBe('clearance')
    expect(transforms(view.root)).toEqual(initial)
    for(const t of clip.tracks.filter(t=>!/^RightHand(?:Index|Middle|Ring|Pinky|Thumb)[123]\.quaternion$/.test(t.name)))expect(result.clip.tracks.find(r=>r.name===t.name)).toBe(t)
    const surface=new HandContactSurface(view.root,'Right',view.height),tips=[...view.bones].filter(([n])=>/^RightHand.+4$/.test(n)).map(([,b])=>b)
    const sample=(clip:THREE.AnimationClip):Array<{area:number,tips:THREE.Vector3[]}>=>{
      const mixer=new THREE.AnimationMixer(view.root),action=mixer.clipAction(clip),rows=[]
      action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play()
      for(let f=0;f<result.frames*2-1;f++){
        mixer.setTime(clip.duration*f/(2*(result.frames-1)))
        rows.push({area:surface.coveredArea(view.height*1e-6),tips:tips.map(b=>b.getWorldPosition(new THREE.Vector3()))})
      }
      mixer.stopAllAction();mixer.uncacheRoot(view.root);return rows
    }
    const before=sample(clip),after=sample(result.clip)
    expect(after.reduce((s,r)=>s+r.area,0)).toBeLessThan(before.reduce((s,r)=>s+r.area,0))
    for(let f=0;f<before.length;f++){
      expect(after[f].area).toBeLessThanOrEqual(before[f].area+view.height**2*1e-10)
      after[f].tips.forEach((p,k)=>expect(p.distanceTo(before[f].tips[k])).toBeLessThan(view.height*.004+1e-7))
    }
    for(const f of result.fingers.filter(f=>f.accepted))expect(f.accelerationAfter).toBeLessThanOrEqual(f.accelerationBefore*(1+1e-4)+1e-10)
  },90000)
  it.skipIf(!existsSync('workspace/characters/huntress-a1f4b9/rigged.glb')||!existsSync('workspace/library/clips/mixamo-Punching.glb'))('uncurls a free finger without a pulse or increased buried surface',async()=>{
    const view=await body('huntress-a1f4b9'),src=await entrySource({clipId:'mixamo-Punching'})
    const clip=retarget(src.scene,captureRest(src.scene,isBone),src.clip,view.rest!,{fps:30,inPlace:true})
    const result=correctHandContacts(view.root,clip,{height:view.height,tipTolerance:view.height*.004,protect:['Left']})
    const finger=result.fingers.find(f=>f.name==='RightHandIndex')!
    expect(finger.mode).toBe('relaxed');expect(finger.accepted).toBe(true)
    expect(result.tipMiss).toBeGreaterThan(view.height*.0001)
    expect(result.tipMiss).toBeLessThan(view.height*.004)
    for(const track of clip.tracks.filter(t=>t.name.startsWith('LeftHand')))expect(result.clip.tracks.find(t=>t.name===track.name)).toBe(track)
    const track=result.clip.tracks.find(t=>t.name==='RightHandIndex3.quaternion')!
    const first=new THREE.Quaternion().fromArray(track.values).normalize()
    // A fixed local pose while the whole hand punches; float32 sampling noise
    // is allowed, but no visible curl/unfurl has been introduced.
    for(let i=0;i<track.values.length;i+=4) expect(first.angleTo(new THREE.Quaternion().fromArray(track.values,i).normalize())).toBeLessThan(1e-5)
    const surfaces=(['Left','Right'] as const).map(s=>new HandContactSurface(view.root,s,view.height))
    const coverage=(clip:THREE.AnimationClip):number[]=>{
      const mixer=new THREE.AnimationMixer(view.root);mixer.clipAction(clip).play();mixer.setTime(13/30)
      const values=surfaces.map(s=>s.coveredArea(view.height*1e-6));mixer.stopAllAction();mixer.uncacheRoot(view.root);return values
    }
    const before=coverage(clip),after=coverage(result.clip)
    expect(after[0]).toBeCloseTo(before[0],12);expect(after[1]).toBeLessThan(before[1])
  },25000)
  it('keeps a finger joint the clip has in its range in it, given the ranges (src/engine/limits.ts)',async()=>{
    const view=await body('skirmisher-19c713'),src=await entrySource({clipId:'mixamo-Grab_And_Slam'})
    const srcRest=captureRest(src.scene,isBone),rest=view.rest!
    const full=retarget(src.scene,srcRest,src.clip,rest,{fps:30,inPlace:true})
    const clip=THREE.AnimationUtils.subclip(full,'changing grab',72,84,30)
    const rom=JSON.parse(readFileSync('static/templates/rom/human.json','utf8')) as Rom
    const limits=new JointLimits(rom,retargetOffsets(srcRest,rest).offsets,n=>rest.bones.get(n)?.parent??null)
    const result=correctHandContacts(view.root,clip,{height:view.height,tipTolerance:view.height*.004,protect:['Left'],limits,nameOf:b=>b.name})
    const joints=[...view.bones.keys()].filter(n=>/^RightHand(?:Index|Middle|Ring|Pinky|Thumb)[123]$/.test(n)&&limits.has(n))
    expect(joints.length).toBeGreaterThan(0)
    const turns=(c:THREE.AnimationClip,f:number):Map<string,THREE.Quaternion>=>{
      const mixer=new THREE.AnimationMixer(view.root),action=mixer.clipAction(c)
      action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();mixer.setTime(c.duration*f/(result.frames-1))
      const out=new Map(joints.map(n=>[n,view.bones.get(n)!.quaternion.clone()]))
      mixer.stopAllAction();mixer.uncacheRoot(view.root);return out
    }
    let checked=0
    for(let f=0;f<result.frames;f++){
      const before=turns(clip,f),after=turns(result.clip,f)
      for(const n of joints)if(limits.within(n,before.get(n)!)){checked++;expect(limits.within(n,after.get(n)!),`${n} on frame ${f}`).toBe(true)}
    }
    expect(checked).toBeGreaterThan(0)
    expect(result.tipMiss).toBeLessThan(view.height*.004+1e-7)
  },90000)
})
