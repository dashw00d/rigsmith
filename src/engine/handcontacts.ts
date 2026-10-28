// Contact-aware finger redistribution. Prefer a fixed tip while the distal pad
// tilts and the proximal joints reach its base; optionally relax a free curl. Wrist/body
// tracks and protected grips are never changed. Score the rendered LBS surface,
// not a capsule approximation of a stylized hand.
import * as THREE from 'three'
import { canonical, type Side } from './retarget.ts'
import { reach, setWorldQuaternion } from './ik.ts'
import { SurfaceContacts, type SurfaceSelection } from './surfacecontact.ts'

const FINGERS = ['Index','Middle','Ring','Pinky','Thumb']
const ANGLES = Array.from({ length:29 },(_,i) => THREE.MathUtils.degToRad((i-14)*2.5))
const ZERO = 14
const wp = (b: THREE.Object3D): THREE.Vector3 => b.getWorldPosition(new THREE.Vector3())
const wq = (b: THREE.Object3D): THREE.Quaternion => b.getWorldQuaternion(new THREE.Quaternion())

/** Only the vertices referenced by this hand's faces need skinning per trial.
 * The hierarchy must own its skeletons (SkeletonUtils.clone, not Object3D.clone).
 * Welding uses bind positions, even when the caller is displaying a posed frame. */
export class HandContactSurface {
  readonly root: THREE.Object3D
  readonly positions: Float64Array
  readonly contacts: SurfaceContacts
  private readonly vertices: Array<{ mesh: THREE.SkinnedMesh, vertex: number }> = []
  private readonly meshes = new Set<THREE.SkinnedMesh>()
  private readonly point = new THREE.Vector3()
  private readonly base = new THREE.Vector4()
  private readonly weighted = new THREE.Vector4()
  private readonly skins = new Map<THREE.Skeleton,THREE.Matrix4[]>()
  private readonly selections = new Map<THREE.Bone,{vertices:number[],faces:SurfaceSelection,moving:Set<THREE.Object3D>}>()
  private readonly referenceAreas: Float64Array

  constructor (root: THREE.Object3D, side: Side, height: number) {
    this.root = root
    root.updateMatrixWorld(true)
    const index: number[] = [], aliases: number[] = [], bind: number[] = [], keys = new Map<string,number>(), objects = new Set<THREE.Object3D>()
    root.traverse(o => objects.add(o))
    root.traverse(o => {
      const mesh = o as THREE.SkinnedMesh
      if (!mesh.isSkinnedMesh) return
      if (mesh.skeleton.bones.some(b => !objects.has(b))) throw new Error('Hand correction needs a skeleton owned by its pose root')
      const geo = mesh.geometry, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight
      const map = new Map<number,number>()
      const count = geo.index?.count ?? geo.attributes.position.count
      const hand = mesh.skeleton.bones.map(b => canonical(b.name).startsWith(side+'Hand'))
      const add = (v: number): number => {
        if (map.has(v)) return map.get(v)!
        const at = this.vertices.length
        this.vertices.push({mesh,vertex:v}); this.meshes.add(mesh); map.set(v,at)
        this.point.fromBufferAttribute(geo.attributes.position,v).applyMatrix4(mesh.matrixWorld)
        bind.push(...this.point.toArray())
        const key = this.point.toArray().map(x => Math.round(x/(height*1e-7))).join(',')
        if (!keys.has(key)) keys.set(key,keys.size)
        aliases.push(keys.get(key)!)
        return at
      }
      for (let f = 0; f < count; f += 3) {
        const tri = [0,1,2].map(k => geo.index?.getX(f+k) ?? f+k)
        let weight = 0
        for (const v of tri) for (let k = 0; k < 4; k++) if (hand[si.getComponent(v,k)]) weight += sw.getComponent(v,k)
        if (weight >= 1.5) index.push(...tri.map(add))
      }
    })
    this.positions = Float64Array.from(bind)
    this.contacts = new SurfaceContacts(this.positions,index,aliases)
    this.referenceAreas=Float64Array.from({length:index.length/3},(_,f)=>{
      const a=new THREE.Vector3().fromArray(this.positions,index[f*3]*3),b=new THREE.Vector3().fromArray(this.positions,index[f*3+1]*3),c=new THREE.Vector3().fromArray(this.positions,index[f*3+2]*3)
      return b.sub(a).cross(c.sub(a)).length()/2
    })
    for (const mesh of this.meshes) if (!this.skins.has(mesh.skeleton)) this.skins.set(mesh.skeleton,mesh.skeleton.bones.map(() => new THREE.Matrix4()))
  }

  private updateSkin (moving?: ReadonlySet<THREE.Object3D>): void {
    for (const [skeleton,matrices] of this.skins) skeleton.bones.forEach((bone,i) => {
      if (moving === undefined || moving.has(bone)) matrices[i].multiplyMatrices(bone.matrixWorld,skeleton.boneInverses[i])
    })
  }

  /** Match SkinnedMesh.getVertexPosition, including morphs and bind modes, but
   * reuse each bone's world * inverse-bind matrix across its influenced vertices.
   * Three's CPU reader otherwise multiplies those matrices per vertex/weight. */
  private readVertex (i: number): void {
    const {mesh,vertex} = this.vertices[i], si=mesh.geometry.attributes.skinIndex, sw=mesh.geometry.attributes.skinWeight
    THREE.Mesh.prototype.getVertexPosition.call(mesh,vertex,this.point)
    this.base.set(this.point.x,this.point.y,this.point.z,1).applyMatrix4(mesh.bindMatrix)
    this.point.set(0,0,0)
    for (let k = 0; k < 4; k++) {
      const weight = sw.getComponent(vertex,k)
      if (weight === 0) continue
      this.weighted.copy(this.base).applyMatrix4(this.skins.get(mesh.skeleton)![si.getComponent(vertex,k)])
      this.point.x += this.weighted.x*weight; this.point.y += this.weighted.y*weight; this.point.z += this.weighted.z*weight
    }
    this.point.applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld).toArray(this.positions,i*3)
  }

  read (): Float64Array {
    this.root.updateMatrixWorld(true)
    this.updateSkin()
    for (let i = 0; i < this.vertices.length; i++) this.readVertex(i)
    this.contacts.refit(this.positions)
    return this.positions
  }

  length (epsilon: number): number {
    this.read()
    return this.contacts.crossings(epsilon).reduce((s,c) => s+c.length,0)
  }

  /** Estimate covered surface with three area-quadrature samples per triangle.
   * Use bind area so compressing a buried triangle cannot improve the score.
   * This complements crossings; open wrists and pre-existing layers require
   * comparison with the same mesh's source pose, not a zero-contact target. */
  coveredArea (epsilon: number): number {
    this.read()
    return this.coverage(epsilon).area
  }

  private coverage (epsilon:number, unchanged?:(face:number,point:readonly number[],sample:number)=>number|undefined): {area:number,values:Float64Array} {
    const index=this.contacts.index,p=this.positions,point:[number,number,number]=[0,0,0]
    const values=new Float64Array(index.length)
    let area=0,sample=0
    for(let f=0;f<index.length;f+=3){
      const a=index[f]*3,b=index[f+1]*3,c=index[f+2]*3
      const ax=p[b]-p[a],ay=p[b+1]-p[a+1],az=p[b+2]-p[a+2],bx=p[c]-p[a],by=p[c+1]-p[a+1],bz=p[c+2]-p[a+2]
      const nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx,norm=Math.hypot(nx,ny,nz)
      if(norm===0){sample+=3;continue}
      for(const corner of [a,b,c]){
        point[0]=(p[a]+p[b]+p[c])/6+p[corner]/2+epsilon*nx/norm
        point[1]=(p[a+1]+p[b+1]+p[c+1])/6+p[corner+1]/2+epsilon*ny/norm
        point[2]=(p[a+2]+p[b+2]+p[c+2])/6+p[corner+2]/2+epsilon*nz/norm
        const winding=unchanged?.(f/3,point,sample)??this.contacts.signedWinding(point)
        values[sample++]=winding
        if(winding>.5)area+=this.referenceAreas[f/3]/3
      }
    }
    return {area,values}
  }

  /** Start from the complete current pose. During this trial only `bone` and
   * its descendants may move; morphs and unrelated transforms stay fixed.
   * Coverage trials snapshot the surface and may be interleaved, provided the
   * caller restores their source pose before setting a new finger candidate. */
  trial (bone: THREE.Bone, epsilon: number, withCoverage=false): { baseline:number,length:()=>number,coveredBaseline:number,coveredArea:()=>number } {
    let selected = this.selections.get(bone)
    if (selected === undefined) {
      const moving = new Set<THREE.Object3D>(); bone.traverse(b => moving.add(b))
      const vertices = this.vertices.flatMap(({mesh,vertex},i) => {
        if (moving.has(mesh)) return [i]
        const si=mesh.geometry.attributes.skinIndex, sw=mesh.geometry.attributes.skinWeight
        for (let k = 0; k < 4; k++) if (sw.getComponent(vertex,k) !== 0 && moving.has(mesh.skeleton.bones[si.getComponent(vertex,k)])) return [i]
        return []
      })
      const mask = new Set(vertices), faces: number[] = []
      for (let f = 0; f < this.contacts.index.length/3; f++) if ([0,1,2].some(k => mask.has(this.contacts.index[f*3+k]))) faces.push(f)
      selected = {vertices,faces:this.contacts.selectFaces(faces),moving}
      this.selections.set(bone,selected)
    }
    this.read()
    const hits = this.contacts.crossings(epsilon), baseline = hits.reduce((s,c) => s+c.length,0)
    const outside = hits.reduce((s,c) => s+(selected.faces.faces[c.a] || selected.faces.faces[c.b] ? 0 : c.length),0)
    const source=withCoverage?this.positions.slice():null, covered=withCoverage?this.coverage(epsilon):null
    // The old and new moving patches have identical oriented boundaries when
    // every exposed edge stays still. Their closed difference has zero winding
    // outside the union box, so stationary probes there retain their value.
    // Merge seam copies only when their actual old AND new positions coincide.
    const aliases=new Map<string,number>(), representatives:number[]=[], seams:Array<[number,number]>=[],edges=new Map<string,number>()
    if(source!==null){
      for(let i=0;i<source.length;i+=3){
        const key=`${source[i]},${source[i+1]},${source[i+2]}`,v=i/3,prior=aliases.get(key)
        if(prior===undefined){aliases.set(key,v);representatives.push(v)}
        else{representatives.push(prior);seams.push([v,prior])}
      }
      for(let f=0;f<selected.faces.faces.length;f++)if(selected.faces.faces[f])for(let k=0;k<3;k++){
        const a=representatives[this.contacts.index[f*3+k]],b=representatives[this.contacts.index[f*3+(k+1)%3]]
        if(a===b)continue
        const key=`${Math.min(a,b)},${Math.max(a,b)}`
        edges.set(key,(edges.get(key)??0)+(a<b?1:-1))
      }
    }
    const boundary=new Set<number>()
    for(const [key,count]of edges)if(count!==0)for(const v of key.split(',').map(Number))boundary.add(v)
    const update=():void=>{
      bone.updateMatrixWorld(true)
      if(source!==null)this.positions.set(source)
      this.updateSkin(source===null?selected.moving:undefined)
      for (const i of selected.vertices) this.readVertex(i)
      this.contacts.refit(this.positions)
    }
    return {baseline,coveredBaseline:covered?.area??NaN,length:()=>{update();return outside+this.contacts.crossingLength(epsilon,selected.faces)},coveredArea:()=>{
      if(source===null||covered===null)throw new Error('Start a coverage trial before moving the finger')
      update()
      const p=this.positions
      const same=(a:number,b:number):boolean=>[0,1,2].every(k=>p[a*3+k]===p[b*3+k])
      const closed=seams.every(([a,b])=>same(a,b))&&[...boundary].every(v=>[0,1,2].every(k=>p[v*3+k]===source[v*3+k]))
      if(!closed)return this.coverage(epsilon).area
      const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity]
      for(let f=0;f<selected.faces.faces.length;f++)if(selected.faces.faces[f])for(let j=0;j<3;j++)for(let k=0;k<3;k++){
        const i=this.contacts.index[f*3+j]*3+k
        lo[k]=Math.min(lo[k],source[i],p[i]);hi[k]=Math.max(hi[k],source[i],p[i])
      }
      return this.coverage(epsilon,(face,point,sample)=>{
        const previous=covered.values[sample]
        return !selected.faces.faces[face]&&Math.abs(previous-.5)>1e-8&&point.some((v,k)=>v<lo[k]||v>hi[k])?previous:undefined
      }).area
    }}
  }
}

/** A smooth choice through feasible contact candidates. The first-order path
 * supplies a coherent start; alternating sweeps reduce correction acceleration.
 * For a loop, `costs` contains unique frames, not a duplicate final frame. */
export function contactPath (costs: readonly (readonly number[])[], angles: readonly number[], loop = false, poses?: readonly (readonly (readonly number[] | null)[])[], motionWeight=10): number[] {
  const n = costs.length, k = angles.length
  if (n === 0) return []
  const velocity = .4, acceleration = 3
  const square = (x: number): number => x*x
  let previous = Float64Array.from(costs[0])
  const back = Array.from({length:n},() => new Int32Array(k))
  for (let f = 1; f < n; f++) {
    const current = new Float64Array(k).fill(Infinity)
    for (let b = 0; b < k; b++) {
      if (!Number.isFinite(costs[f][b])) continue
      for (let a = 0; a < k; a++) {
        const cost = previous[a] + costs[f][b] + velocity*square(angles[b]-angles[a])
        if (cost < current[b]) { current[b] = cost; back[f][b] = a }
      }
    }
    previous = current
  }
  const result = new Array<number>(n)
  result[n-1] = Array.from(previous).reduce((best,v,i) => v < previous[best] ? i : best,0)
  for (let f = n-1; f > 0; f--) result[f-1] = back[f][result[f]]
  const at = (i: number): number | null => loop ? (i+n)%n : i < 0 || i >= n ? null : i
  for (let sweep = 0; sweep < 24; sweep++) {
    let changed = false
    for (let f0 = 0; f0 < n; f0++) {
      const f = sweep%2 ? n-1-f0 : f0
      const energy = (candidate: number): number => {
        const angle = (i: number): number => angles[i===f ? candidate : result[i]]
        let cost = costs[f][candidate]
        for (const j of [at(f-1),at(f+1)]) if (j !== null) cost += velocity*square(angle(f)-angle(j))
        for (let c = f-1; c <= f+1; c++) {
          const a = at(c-1), b = at(c), d = at(c+1)
          if (a !== null && b !== null && d !== null) {
            cost += acceleration*square(angle(a)-2*angle(b)+angle(d))
            if (poses !== undefined) cost += motionWeight*jointAcceleration(poses[a][a===f ? candidate : result[a]]!,poses[b][b===f ? candidate : result[b]]!,poses[d][d===f ? candidate : result[d]]!)
          }
        }
        return cost
      }
      let best = result[f], cost = energy(best)
      for (let j = 0; j < k; j++) {
        if (!Number.isFinite(costs[f][j])) continue
        const e = energy(j)
        if (e < cost-1e-12) { best = j; cost = e }
      }
      changed ||= best !== result[f]; result[f] = best
    }
    if (!changed) break
  }
  return result
}

/** Local angular velocity over a unit interval, using the quaternion logarithm.
 * Keep hemisphere changes out of the motion objective. */
function jointVelocity (a: readonly number[], b: readonly number[], i: number): number[] {
  const ax=a[i], ay=a[i+1], az=a[i+2], aw=a[i+3], bx=b[i], by=b[i+1], bz=b[i+2], bw=b[i+3]
  let x=aw*bx-ax*bw-ay*bz+az*by, y=aw*by+ax*bz-ay*bw-az*bx, z=aw*bz-ax*by+ay*bx-az*bw, w=aw*bw+ax*bx+ay*by+az*bz
  if (w < 0) { x=-x; y=-y; z=-z; w=-w }
  const sin = Math.hypot(x,y,z), scale = sin < 1e-10 ? 0 : 2*Math.atan2(sin,w)/sin
  return [x*scale,y*scale,z*scale]
}
function jointAcceleration (a: readonly number[], b: readonly number[], c: readonly number[]): number {
  let energy = 0
  for (let i = 0; i < a.length; i += 4) {
    const ab=jointVelocity(a,b,i), bc=jointVelocity(b,c,i)
    for (let j = 0; j < 3; j++) energy += (bc[j]-ab[j])**2
  }
  return energy
}

/** Refine the sampled contact path in continuous angle space. Quantized pose
 * selection alone gives small but visible jumps as a finger curls. Interpolate
 * only between feasible samples, then evaluate the exact IK and skin again. */
function continuousPath (costs: number[][], poses: Array<Array<readonly number[] | null>>, loop: boolean, grid:readonly number[]=ANGLES, motionWeight=10): number[] {
  const choice = contactPath(costs,grid,loop,poses,motionWeight), n = costs.length
  type Sample = { angle:number,cost:number,q:readonly number[] }
  const sample = (f: number, angle: number): Sample | null => {
    let x = THREE.MathUtils.clamp((angle-grid[0])/(grid[1]-grid[0]),0,grid.length-1)
    if (Math.abs(x-Math.round(x)) < 1e-9) x = Math.round(x)
    const a = Math.floor(x), b = Math.ceil(x), t = x-a
    if (!Number.isFinite(costs[f][a]) || !Number.isFinite(costs[f][b])) return null
    const qa = poses[f][a]!, qb = poses[f][b]!
    if (a === b) return {angle,cost:costs[f][a],q:qa}
    const q = new Array<number>(qa.length)
    for (let i = 0; i < q.length; i += 4) {
      const sign = qa.slice(i,i+4).reduce((s,v,j) => s+v*qb[i+j],0) < 0 ? -1 : 1
      for (let j = 0; j < 4; j++) q[i+j] = (1-t)*qa[i+j]+t*sign*qb[i+j]
      const norm = Math.hypot(...q.slice(i,i+4))
      for (let j = 0; j < 4; j++) q[i+j] /= norm
    }
    return {angle,cost:(1-t)*costs[f][a]+t*costs[f][b],q}
  }
  const selected = choice.map((j,f) => sample(f,grid[j])!)
  const at = (i: number): number | null => loop ? (i+n)%n : i < 0 || i >= n ? null : i
  for (let sweep = 0; sweep < 32; sweep++) {
    let movement = 0
    for (let f0 = 0; f0 < n; f0++) {
      const f = sweep%2 ? n-1-f0 : f0
      const energy = (candidate: Sample): number => {
        const s = (i: number): Sample => i === f ? candidate : selected[i]
        let cost = candidate.cost
        for (const j of [at(f-1),at(f+1)]) if (j !== null) cost += .4*(candidate.angle-s(j).angle)**2
        for (let c = f-1; c <= f+1; c++) {
          const a=at(c-1), b=at(c), d=at(c+1)
          if (a !== null && b !== null && d !== null) cost += 3*(s(a).angle-2*s(b).angle+s(d).angle)**2 + motionWeight*jointAcceleration(s(a).q,s(b).q,s(d).q)
        }
        return cost
      }
      let best = selected[f], cost = energy(best)
      const consider = (s: Sample): void => { const value = energy(s); if (value < cost) { best=s; cost=value } }
      const center = Math.round((best.angle-grid[0])/(grid[1]-grid[0]))
      for (let j = Math.max(0,center-2); j < Math.min(grid.length-1,center+2); j++) {
        const a=sample(f,grid[j]), b=sample(f,grid[j+1]), mid=(grid[j]+grid[j+1])/2, m=sample(f,mid)
        if (a === null || b === null || m === null) continue
        consider(a); consider(b); consider(m)
        const ea=energy(a), eb=energy(b), em=energy(m), curvature=ea+eb-2*em
        if (curvature > 1e-12) {
          const t=THREE.MathUtils.clamp((ea-eb)/(2*curvature),-1,1)
          consider(sample(f,mid+t*(grid[j+1]-mid))!)
        }
      }
      movement = Math.max(movement,Math.abs(best.angle-selected[f].angle)); selected[f]=best
    }
    if (movement < 1e-5) break
  }
  return selected.map(s => s.angle)
}

interface Finger {
  bones: [THREE.Bone,THREE.Bone,THREE.Bone,THREE.Bone]
  q: THREE.Quaternion[]
  p: THREE.Vector3[]
  axis: THREE.Vector3
  distal: THREE.Quaternion
}
function fingerAt (bones: Finger['bones']): Finger {
  const p = bones.map(wp)
  return { bones, q:bones.slice(0,3).map(b => b.quaternion.clone()), p,
    axis:new THREE.Vector3().crossVectors(p[1].clone().sub(p[0]),p[2].clone().sub(p[1])).normalize(), distal:wq(bones[2]) }
}

/** Try a pad tilt, retaining the actual end marker. Null if the redistribution
 * needs excessive joint motion, a singular bend, or cannot reach the endpoint. */
function redistribute (finger: Finger, angle: number, height: number): { q: number[], change: number, miss: number } | null {
  const { bones:[upper,lower,end,tip], q, p, axis, distal } = finger
  ;[upper,lower,end].forEach((b,i) => b.quaternion.copy(q[i])); upper.updateMatrixWorld(true)
  if (angle === 0) return {q:q.flatMap(q => q.toArray()),change:0,miss:0}
  if (axis.lengthSq() < .5) return null
  const turn = new THREE.Quaternion().setFromAxisAngle(axis,angle)
  const target = p[3].clone().sub(p[3].clone().sub(p[2]).applyQuaternion(turn))
  reach({upper,lower,end},target,{nameOf:b => b.name,keepEnd:false})
  setWorldQuaternion(end,turn.multiply(distal))
  const miss = wp(tip).distanceTo(p[3])
  const change = Math.max(...[upper,lower,end].map((b,i) => b.quaternion.angleTo(q[i])))
  if (miss > height*1e-5 || change > THREE.MathUtils.degToRad(35)) return null
  return {q:[upper,lower,end].flatMap(b => b.quaternion.toArray()),change,miss}
}

export interface HandContactOptions {
  height: number
  fps?: number
  loop?: boolean
  /** Authored grips, finger keys, or hands touching props. */
  protect?: readonly Side[]
  /** A free finger may gently uncurl within this world-space endpoint distance.
   * Zero (default) requires the original endpoint. Protected hands never move. */
  tipTolerance?: number
  progress?: (done: number,total: number,phase?:'search'|'clearance'|'relaxation'|'trajectory') => void
  cancelled?: () => boolean
}
export interface HandContactResult {
  clip: THREE.AnimationClip
  frames: number
  changedFrames: number
  tipMiss: number
  jointChange: number
  before: number
  after: number
  fingers: Array<{ name:string,accepted:boolean,mode:'continuous'|'constant'|'relaxed'|'clearance'|null,reason:string|null,before:number,after:number,accelerationBefore:number,accelerationAfter:number }>
}

export function correctHandContacts (root: THREE.Object3D, clip: THREE.AnimationClip, options: HandContactOptions): HandContactResult {
  const steps = handContactSteps(root,clip,options)
  let next = steps.next()
  while (!next.done) next = steps.next()
  return next.value
}

export async function correctHandContactsAsync (root: THREE.Object3D, clip: THREE.AnimationClip, options: HandContactOptions): Promise<HandContactResult> {
  const steps = handContactSteps(root,clip,options)
  try {
    let start = performance.now(), next = steps.next()
    while (!next.done) {
      if (performance.now()-start > 12) { await new Promise(r => setTimeout(r,0)); start = performance.now() }
      next = steps.next()
    }
    return next.value
  } finally { steps.return(undefined as never) }
}

function * handContactSteps (root: THREE.Object3D, clip: THREE.AnimationClip, o: HandContactOptions): Generator<void,HandContactResult> {
  const fps = o.fps ?? 30, height = o.height
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(height) || height <= 0 || !Number.isFinite(clip.duration) || clip.duration < 0) throw new Error('Hand contacts need a finite size, duration and positive frame rate')
  const tipTolerance=o.tipTolerance??0
  if(!Number.isFinite(tipTolerance)||tipTolerance<0)throw new Error('Hand endpoint tolerance must be finite and nonnegative')
  const saved: Array<{b:THREE.Object3D,p:THREE.Vector3,q:THREE.Quaternion,s:THREE.Vector3}> = []
  const bones = new Map<string,THREE.Bone>()
  root.traverse(b => { saved.push({b,p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}); if ((b as THREE.Bone).isBone) bones.set(canonical(b.name),b as THREE.Bone) })
  // The edit can be opened at any posed frame. Its current quaternions are not
  // the rest pose: recover local bind turns from the skin's inverse bind data.
  const bindWorld=new Map<THREE.Bone,THREE.Matrix4>(),bindTurns=new Map<THREE.Bone,THREE.Quaternion>()
  root.traverse(o=>{const mesh=o as THREE.SkinnedMesh;if(mesh.isSkinnedMesh)mesh.skeleton.bones.forEach((b,i)=>bindWorld.set(b,mesh.skeleton.boneInverses[i].clone().invert()))})
  for(const [bone,world]of bindWorld){
    const parent=bindWorld.get(bone.parent as THREE.Bone)
    if(parent!==undefined){const q=new THREE.Quaternion();parent.clone().invert().multiply(world).decompose(new THREE.Vector3(),q,new THREE.Vector3());bindTurns.set(bone,q)}
  }
  const restore = (): void => { for (const {b,p,q,s} of saved) { b.position.copy(p); b.quaternion.copy(q); b.scale.copy(s) } root.updateMatrixWorld(true) }
  const count = clip.duration === 0 ? 0 : Math.max(1,Math.round(clip.duration*fps))
  const times = Array.from({length:count+1},(_,i) => count === 0 ? 0 : clip.duration*i/count)
  const keyTimes = Float32Array.from(times)
  const unique = o.loop === true && count > 1 ? count : times.length
  const tracks = new Map<THREE.Bone,Float32Array>()
  const trackInterpolants = new Map<THREE.Bone,THREE.Interpolant>()
  const mixer = new THREE.AnimationMixer(root)
  const pose = (f: number): void => {
    mixer.stopAllAction(); restore()
    const time=count===0?0:clip.duration*f/count
    const action = mixer.clipAction(clip); action.reset(); action.setLoop(THREE.LoopOnce,1); action.clampWhenFinished = true; action.play(); mixer.setTime(time)
    for (const [bone,q] of tracks) bone.quaternion.fromArray(Number.isInteger(f)?q:trackInterpolants.get(bone)!.evaluate(time),Number.isInteger(f)?f*4:0)
    root.updateMatrixWorld(true)
  }
  const sides = (['Left','Right'] as const).filter(s => !o.protect?.includes(s))
  const fingers = sides.flatMap(side => FINGERS.flatMap(name => {
    const chain = [1,2,3,4].map(i => bones.get(side+'Hand'+name+i))
    return chain.every(b => b !== undefined) ? [{side,bones:chain as Finger['bones']}] : []
  }))
  if (fingers.length === 0) return {clip,frames:times.length,changedFrames:0,tipMiss:0,jointChange:0,before:0,after:0,fingers:[]}
  const surfaces = new Map(sides.map(side => [side,new HandContactSurface(root,side,height)]))
  const coveredBaseline=new Map(sides.map(side=>[side,new Float64Array(times.length).fill(NaN)]))
  let tipMiss = 0, jointChange = 0, before = 0, after = 0
  const changedFrames = new Set<number>()
  const reports: HandContactResult['fingers'] = []
  const check = (): void => { if (o.cancelled?.()) throw new DOMException('Hand correction cancelled','AbortError') }
  let done = 0
  try {
    for (let f = 0; f < times.length; f++) { check(); pose(f); for (const surface of surfaces.values()) before += surface.length(height*1e-6); yield }
    for (const {side,bones:chain} of fingers) {
      const surface = surfaces.get(side)!, costs: number[][] = [], candidates: Array<Array<ReturnType<typeof redistribute>>> = [], sampledLengths:number[][] = [], baselines: number[] = []
      for (let f = 0; f < times.length; f++) {
        check(); pose(f)
        const finger = fingerAt(chain), trial = surface.trial(chain[0],height*1e-6), baseline = trial.baseline
        baselines.push(baseline)
        const row = ANGLES.map((angle,i) => {
          const candidate = redistribute(finger,angle,height)
          if (candidate === null) return {candidate:null,cost:Infinity,length:Infinity}
          const length = i === ZERO ? baseline : trial.length()
          // Every selected frame must improve or retain its actual hand surface.
          return {candidate,length,cost:length > baseline+height*1e-7 ? Infinity : length/height+.02*(candidate.change/.5)**2}
        })
        costs.push(row.map(r => r.cost)); candidates.push(row.map(r => r.candidate));sampledLengths.push(row.map(r=>r.length))
        o.progress?.(++done,fingers.length*times.length,'search')
        yield
      }
      // A loop's duplicated endpoint uses the same correction choice, and both
      // source endpoints must admit it. No extra wrap frame or unkeyed pose leak.
      if (unique < times.length) costs[0] = costs[0].map((v,j) => v+costs.at(-1)![j])
      const angles = continuousPath(costs.slice(0,unique),candidates.slice(0,unique).map(row => row.map(c => c?.q ?? null)),o.loop === true)
      if (unique < times.length) angles.push(angles[0])
      const selected = [], lengths = [], usedAngles: number[] = []
      const exact = (f:number,angle:number): {candidate:NonNullable<ReturnType<typeof redistribute>>,length:number,angle:number} => {
        pose(f)
        const finger = fingerAt(chain), trial = surface.trial(chain[0],height*1e-6)
        // A feasible sampled interval need not remain feasible between its
        // endpoints on the actual nonlinear skin. Backtrack on that surface;
        // the whole resulting trajectory still has to pass the motion guard.
        for (let attempt = 0; attempt < 8; attempt++) {
          const tried = angle/2**attempt
          const candidate = redistribute(finger,tried,height)
          if (candidate === null) continue
          const length = trial.length()
          if (length <= baselines[f]+height*1e-6) return {candidate,length,angle:tried}
        }
        return {candidate:candidates[f][ZERO]!,length:baselines[f],angle:0}
      }
      for (let f = 0; f < times.length; f++) {
        check()
        const result = exact(f,angles[f])
        selected.push(result.candidate); lengths.push(result.length); usedAngles.push(result.angle)
        yield
      }
      if (unique < times.length) {
        // Backtracking must use the same correction at both copies of a loop
        // endpoint; choosing them independently would introduce a wrap pop.
        let angle = Math.abs(usedAngles[0]) < Math.abs(usedAngles[unique]) ? usedAngles[0] : usedAngles[unique]
        for (let attempt = 0; attempt < 9; attempt++) {
          check()
          const first=exact(0,attempt===8 ? 0 : angle), last=exact(unique,attempt===8 ? 0 : angle)
          if (first.angle === last.angle) {
            for (const [f,result] of [[0,first],[unique,last]] as const) {selected[f]=result.candidate; lengths[f]=result.length}
            break
          }
          angle=Math.abs(first.angle)<Math.abs(last.angle) ? first.angle : last.angle
          yield
        }
      }
      const quality = (qs: readonly (readonly number[])[]): {energy:number,peak:number} => {
        const at = (i:number): readonly number[] => qs[(i+unique)%unique]
        const values = Array.from({length:o.loop && unique>2 ? unique : Math.max(0,unique-2)},(_,i) => o.loop && unique>2 ? jointAcceleration(at(i-1),at(i),at(i+1)) : jointAcceleration(qs[i],qs[i+1],qs[i+2]))
        return {energy:values.reduce((s,v) => s+v,0),peak:Math.max(0,...values)}
      }
      const original = quality(candidates.map(row => row[ZERO]!.q)), sumBefore = baselines.reduce((s,v) => s+v,0)
      let corrected = quality(selected.map(c => c.q)),sumAfter = lengths.reduce((s,v) => s+v,0)
      const admissible = (q:ReturnType<typeof quality>):boolean=>q.energy<=original.energy*(1+1e-4)+1e-10&&q.peak<=original.peak*(1+1e-4)+1e-10
      let reason = !admissible(corrected) ? 'motion' : sumAfter >= sumBefore-height*1e-6 ? 'no improvement' : null
      let mode:HandContactResult['fingers'][number]['mode']=reason===null?'continuous':null
      if(reason!==null) {
        // A still fist should not have to pulse with a changing contact optimum.
        // Try a single pad tilt for the whole clip, using already evaluated exact
        // candidates. Every frame, the endpoint and the same motion guards must
        // still pass; this is not a relaxation of the acceptance criteria.
        const uniqueCosts=costs.slice(0,unique)
        let bestScore=uniqueCosts.reduce((s,row)=>s+row[ZERO],0)+10*original.energy
        for(let j=0;j<ANGLES.length;j++) {
          if(j===ZERO||costs.some(row=>!Number.isFinite(row[j])))continue
          const q=quality(candidates.map(row=>row[j]!.q)),total=sampledLengths.reduce((s,row)=>s+row[j],0)
          if(!admissible(q)||total>=sumBefore-height*1e-6)continue
          const score=uniqueCosts.reduce((s,row)=>s+row[j],0)+10*q.energy
          if(score>=bestScore-1e-12)continue
          bestScore=score;corrected=q;sumAfter=total;reason=null;mode='constant'
          for(let f=0;f<times.length;f++){selected[f]=candidates[f][j]!;lengths[f]=sampledLengths[f][j]}
        }
      }
      const covered=coveredBaseline.get(side)!
      const middleTrials=new Map<number,ReturnType<HandContactSurface['trial']>>()
      function * midpoints(qs:readonly {q:number[]}[],maxChange:number,allFailures=false):Generator<void,number[]>{
        // Replay the same float32 keys and spherical interpolation as the saved
        // clip. Safe endpoint skins do not imply a safe skin between them.
        const interpolants=[0,1,2].map(k=>new THREE.QuaternionLinearInterpolant(keyTimes,Float32Array.from(qs.flatMap(c=>c.q.slice(k*4,k*4+4))),4,new Float64Array(4)))
        const failures:number[]=[]
        for(let f=0;f<count;f++){
          check();pose(f+.5);o.progress?.(f+1,count,'trajectory')
          const source=fingerAt(chain)
          let trial=middleTrials.get(f)
          if(trial===undefined){trial=surface.trial(chain[0],height*1e-6,true);middleTrials.set(f,trial)}
          const time=clip.duration*(f+.5)/count
          chain.slice(0,3).forEach((b,k)=>b.quaternion.fromArray(interpolants[k].evaluate(time)));chain[0].updateMatrixWorld(true)
          const miss=wp(chain[3]).distanceTo(source.p[3]),change=Math.max(...chain.slice(0,3).map((b,k)=>b.quaternion.angleTo(source.q[k])))
          const chainLength=source.p.slice(1).reduce((s,p,i)=>s+p.distanceTo(source.p[i]),0)
          const length=trial.length(),area=trial.coveredArea()
          if(miss>Math.max(Math.min(tipTolerance,chainLength*.08),height*1e-5)+height*1e-7||change>maxChange+1e-5||area>trial.coveredBaseline+height*height*1e-10||(area>=trial.coveredBaseline-height*height*1e-10&&length>trial.baseline+height*1e-6))failures.push(f)
          yield
          if(failures.length&&!allFailures)break
        }
        return failures
      }
      function * coverage(qs: readonly {q:number[]}[],crossingLengths:readonly number[]):Generator<void,{pass:boolean,values:number[]}>{
        const values:number[]=[]
        for(let f=0;f<times.length;f++){
          check();pose(f)
          o.progress?.(f+1,times.length,'clearance')
          if(!Number.isFinite(covered[f]))covered[f]=surface.coveredArea(height*1e-6)
          // Verify the actual float32 turns that will be stored in the clip.
          const q=Float32Array.from(qs[f].q)
          chain.slice(0,3).forEach((b,k)=>b.quaternion.fromArray(q,k*4))
          const value=surface.coveredArea(height*1e-6);values.push(value)
          yield
          if(value>covered[f]+height*height*1e-10)return {pass:false,values}
          // Contour length can increase while a buried finger emerges. Permit
          // that trade only when the independently sampled covered area falls;
          // unchanged coverage still requires no extra proper crossings.
          if(value>=covered[f]-height*height*1e-10&&crossingLengths[f]>baselines[f]+height*1e-6)return {pass:false,values}
        }
        return {pass:true,values}
      }
      let acceptedCoverage:number[]|null=null
      if(reason===null){
        const guarded=yield*coverage(selected,lengths)
        if(!guarded.pass){reason='enclosure';mode=null}
        else if((yield*midpoints(selected,THREE.MathUtils.degToRad(35))).length){reason='interpolation';mode=null}
        else acceptedCoverage=guarded.values
      }
      if(reason!==null&&tipTolerance>0&&chain.slice(0,3).every(b=>bindTurns.has(b))){
        // The same small relaxation over the whole clip avoids a contact-driven
        // flexing pulse. Keep the wrist, finger lengths and all nonfinger tracks;
        // retain the authored motion if any frame or motion guard regresses.
        for(const amount of [.02,.04,.06,.08,.1]){
          const relaxed:Array<NonNullable<ReturnType<typeof redistribute>>>=[],relaxedLengths:number[]=[]
          let feasible=true
          for(let f=0;f<times.length;f++){
            check();pose(f)
            o.progress?.(f+1,times.length,'relaxation')
            const source=fingerAt(chain),length=source.p.slice(1).reduce((s,p,i)=>s+p.distanceTo(source.p[i]),0)
            chain.slice(0,3).forEach((b,k)=>b.quaternion.copy(source.q[k]).slerp(bindTurns.get(b)!,amount))
            chain[0].updateMatrixWorld(true)
            const miss=wp(chain[3]).distanceTo(source.p[3]),change=Math.max(...chain.slice(0,3).map((b,k)=>b.quaternion.angleTo(source.q[k])))
            if(miss>Math.min(tipTolerance,length*.08)||change>THREE.MathUtils.degToRad(10)){feasible=false;break}
            const value=surface.length(height*1e-6)
            relaxed.push({q:chain.slice(0,3).flatMap(b=>b.quaternion.toArray()),change,miss});relaxedLengths.push(value)
            yield
          }
          if(!feasible)continue
          const motion=quality(relaxed.map(c=>c.q)),total=relaxedLengths.reduce((s,v)=>s+v,0)
          if(!admissible(motion))continue
          const guarded=yield*coverage(relaxed,relaxedLengths)
          if(!guarded.pass)continue
          if((yield*midpoints(relaxed,THREE.MathUtils.degToRad(10))).length)continue
          if(total>=sumBefore-height*1e-6&&guarded.values.reduce((s,v)=>s+v,0)>=covered.reduce((s,v)=>s+v,0)-height*height*1e-10)continue
          corrected=motion;sumAfter=total;reason=null;mode='relaxed';acceptedCoverage=guarded.values
          for(let f=0;f<times.length;f++){selected[f]=relaxed[f];lengths[f]=relaxedLengths[f]}
          break
        }
      }
      if(reason!==null&&tipTolerance>0&&chain.slice(0,3).every(b=>bindTurns.has(b))){
        // Choose a smooth uncurl through each frame's safe interval. A fixed
        // adjustment can fail when fingers contact different surfaces through
        // a gesture. Interpolants are checked on the actual float32 skin; an
        // unsafe interval is removed before solving the whole trajectory again.
        const grid=[0,.02,.04,.06,.08,.1], freeCosts:number[][]=[],freeCandidates:Array<Array<ReturnType<typeof redistribute>>>=[],freeLengths:number[][]=[],freeCoverage:number[][]=[]
        const freeTrials:Array<ReturnType<HandContactSurface['trial']>>=[]
        const sourceAt=(f:number):Finger=>{pose(f);return fingerAt(chain)}
        const relaxed=(source:Finger,amount:number):ReturnType<typeof redistribute>=>{
          const q=Float32Array.from(source.q.flatMap((q,k)=>q.clone().slerp(bindTurns.get(chain[k])!,amount).toArray()))
          chain.slice(0,3).forEach((b,k)=>b.quaternion.fromArray(q,k*4));chain[0].updateMatrixWorld(true)
          const miss=wp(chain[3]).distanceTo(source.p[3]),change=Math.max(...chain.slice(0,3).map((b,k)=>b.quaternion.angleTo(source.q[k])))
          const length=source.p.slice(1).reduce((s,p,i)=>s+p.distanceTo(source.p[i]),0)
          return miss>Math.min(tipTolerance,length*.08)||change>THREE.MathUtils.degToRad(10)?null:{q:Array.from(q),change,miss}
        }
        const safe=(f:number,area:number,length:number):boolean=>area<=covered[f]+height*height*1e-10&&(area<covered[f]-height*height*1e-10||length<=baselines[f]+height*1e-6)
        const score=(area:number,length:number,change:number):number=>length/height+100*area/(height*height)+.02*(change/.5)**2
        for(let f=0;f<times.length;f++){
          check();const source=sourceAt(f),trial=surface.trial(chain[0],height*1e-6,true)
          freeTrials.push(trial);covered[f]=trial.coveredBaseline
          const row:number[]=[score(covered[f],baselines[f],0)],qs:Array<ReturnType<typeof redistribute>>=[candidates[f][ZERO]!],ls=[baselines[f]],areas=[covered[f]]
          let open=true
          for(let j=1;j<grid.length;j++){
            check();const candidate:ReturnType<typeof redistribute>=open?relaxed(source,grid[j]):null
            const length:number=candidate===null?Infinity:trial.length(),area:number=candidate===null?Infinity:trial.coveredArea()
            open=candidate!==null&&safe(f,area,length)
            qs.push(candidate);ls.push(length);areas.push(area);row.push(open?score(area,length,candidate!.change):Infinity)
            yield
          }
          freeCosts.push(row);freeCandidates.push(qs);freeLengths.push(ls);freeCoverage.push(areas)
          o.progress?.(f+1,times.length,'relaxation')
        }
        for(const weight of [10,100,1000]){
          if(reason===null)break
          for(let iteration=0;iteration<8;iteration++){
            const joined=freeCosts.map(row=>row.slice())
            if(unique<times.length)joined[0]=joined[0].map((v,j)=>v+joined[unique][j])
            const path=continuousPath(joined.slice(0,unique),freeCandidates.slice(0,unique).map(row=>row.map(c=>c?.q??null)),o.loop===true,grid,weight)
            if(unique<times.length)path.push(path[0])
            const qs:Array<NonNullable<ReturnType<typeof redistribute>>>=[],ls:number[]=[],areas:number[]=[]
            let bad=false,changed=false
            for(let f=0;f<times.length;f++){
              check();o.progress?.(f+1,times.length,'trajectory')
              const amount=path[f],j=Math.round(amount/.02)
              let candidate:ReturnType<typeof redistribute>,length:number,area:number
              if(Math.abs(amount-grid[j])<1e-12){candidate=freeCandidates[f][j];length=freeLengths[f][j];area=freeCoverage[f][j]}
              else{candidate=relaxed(sourceAt(f),amount);length=candidate===null?Infinity:freeTrials[f].length();area=candidate===null?Infinity:freeTrials[f].coveredArea()}
              if(candidate===null||!safe(f,area,length)){
                bad=true
                // An interpolated skin can fail between safe samples. Remove
                // that part of this frame's interval, then solve time again.
                for(let j=1;j<grid.length;j++)if(grid[j]>=amount&&Number.isFinite(freeCosts[f][j])){freeCosts[f][j]=Infinity;changed=true}
              }else{qs.push(candidate);ls.push(length);areas.push(area)}
              yield
            }
            if(bad){if(!changed)break;continue}
            const motion=quality(qs.map(c=>c.q)),total=ls.reduce((s,v)=>s+v,0)
            if(!admissible(motion))break
            if(total>=sumBefore-height*1e-6&&areas.reduce((s,v)=>s+v,0)>=covered.reduce((s,v)=>s+v,0)-height*height*1e-10)break
            const between=yield*midpoints(qs,THREE.MathUtils.degToRad(10),true)
            if(between.length){
              changed=false
              for(const f of between)for(const frame of [f,f+1])for(let j=1;j<grid.length;j++)if(grid[j]>=path[frame]&&Number.isFinite(freeCosts[frame][j])){freeCosts[frame][j]=Infinity;changed=true}
              if(changed)continue
              break
            }
            corrected=motion;sumAfter=total;reason=null;mode='clearance';acceptedCoverage=areas
            for(let f=0;f<times.length;f++){selected[f]=qs[f];lengths[f]=ls[f]}
            break
          }
        }
      }
      reports.push({name:chain[0].name.slice(0,-1),accepted:reason===null,mode,reason,before:sumBefore,after:sumAfter,accelerationBefore:original.energy,accelerationAfter:corrected.energy})
      // Keep an entire authored finger when no continuous, endpoint-preserving
      // improvement survives the exact skin and motion checks. Per-frame fallback
      // would create the same jitter this pass is intended to remove.
      if (reason !== null) continue
      if(acceptedCoverage===null)throw new Error('Hand correction was not checked for enclosed surfaces')
      covered.set(acceptedCoverage)
      for (let k = 0; k < 3; k++) {
        const values = new Float32Array(times.length*4)
        for (let f = 0; f < times.length; f++) {
          const candidate = selected[f]
          if (candidate === null) throw new Error('No feasible hand correction')
          values.set(candidate.q.slice(k*4,k*4+4),f*4)
          if (candidate.change > 1e-6) changedFrames.add(f)
          tipMiss = Math.max(tipMiss,candidate.miss); jointChange = Math.max(jointChange,candidate.change)
        }
        tracks.set(chain[k],values)
        trackInterpolants.set(chain[k],new THREE.QuaternionLinearInterpolant(keyTimes,values,4,new Float64Array(4)))
      }
    }
    for (let f = 0; f < times.length; f++) { check(); pose(f); for (const surface of surfaces.values()) after += surface.length(height*1e-6); yield }
  } finally {
    mixer.stopAllAction(); mixer.uncacheRoot(root); restore()
    root.traverse(b => { if ((b as THREE.SkinnedMesh).isSkinnedMesh) (b as THREE.SkinnedMesh).skeleton.update() })
  }
  const names = new Set([...tracks.keys()].map(b => b.name+'.quaternion'))
  const out = clip.tracks.filter(t => !names.has(t.name))
  for (const [bone,values] of tracks) out.push(new THREE.QuaternionKeyframeTrack(bone.name+'.quaternion',times,values))
  return {clip:tracks.size===0 ? clip : new THREE.AnimationClip(clip.name,clip.duration,out,clip.blendMode),frames:times.length,changedFrames:changedFrames.size,tipMiss,jointChange,before,after,fingers:reports}
}
