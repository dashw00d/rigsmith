// Proper crossings of the actual triangulated surface, independent of capsule
// fitting. Plane cuts are intersected along the planes' common line (Möller,
// 1997, https://web.stanford.edu/class/cs277/resources/papers/Moller1997b.pdf).
// Coplanar overlap, point/edge touching and adjacent faces are deliberately not
// penetration measurements. This detects crossing surfaces, not enclosed volume.

export type Point3 = [number, number, number]
export type Triangle3 = [Point3, Point3, Point3]
export interface SurfaceCrossing { a: number, b: number, from: Point3, to: Point3, length: number }

const sub = (a: Point3, b: Point3): Point3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]]
const dot = (a: Point3, b: Point3): number => a[0]*b[0] + a[1]*b[1] + a[2]*b[2]
const cross = (a: Point3, b: Point3): Point3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
const normal = (t: Triangle3): Point3 | null => {
  const n = cross(sub(t[1], t[0]), sub(t[2], t[0])), len = Math.hypot(...n)
  return len > 0 ? n.map(v => v / len) as Point3 : null
}

/** A nonzero segment passing through both triangle interiors. Distances and
 * epsilon use the coordinates' units. Neither touching nor coplanarity counts. */
export function triangleCrossing (a: Triangle3, b: Triangle3, epsilon = 1e-7): Omit<SurfaceCrossing, 'a' | 'b'> | null {
  const na = normal(a), nb = normal(b)
  if (na === null || nb === null) return null
  return crossingWithNormals(a,b,na,nb,epsilon)
}

function crossingWithNormals (a: Triangle3, b: Triangle3, na: Point3, nb: Point3, epsilon: number): Omit<SurfaceCrossing, 'a' | 'b'> | null {
  const da = a.map(v => dot(nb, sub(v, b[0]))), db = b.map(v => dot(na, sub(v, a[0])))
  // A proper crossing has points strictly on both sides of each plane. A fold
  // along a shared edge must not become a collision merely due to roundoff.
  if (Math.min(...da) >= -epsilon || Math.max(...da) <= epsilon || Math.min(...db) >= -epsilon || Math.max(...db) <= epsilon) return null
  const direction = cross(na, nb), len = Math.hypot(...direction)
  if (len < 1e-12) return null
  for (let k = 0; k < 3; k++) direction[k] /= len
  const cut = (t: Triangle3, distances: number[]): Point3[] => {
    const points: Point3[] = []
    for (let k = 0; k < 3; k++) {
      const j = (k + 1) % 3, d = distances[k], e = distances[j]
      if (d === 0) points.push(t[k])
      else if ((d < 0 && e > 0) || (d > 0 && e < 0)) {
        const u = d / (d - e)
        points.push(t[k].map((v, axis) => v + (t[j][axis] - v) * u) as Point3)
      }
    }
    return points
  }
  const ca = cut(a, da), cb = cut(b, db)
  if (ca.length !== 2 || cb.length !== 2) return null
  const origin = ca[0]
  const ta = ca.map(p => dot(sub(p, origin), direction)), tb = cb.map(p => dot(sub(p, origin), direction))
  const lo = Math.max(Math.min(...ta), Math.min(...tb)), hi = Math.min(Math.max(...ta), Math.max(...tb))
  if (hi - lo <= epsilon) return null
  const at = (t: number): Point3 => origin.map((v, k) => v + direction[k] * t) as Point3
  return { from: at(lo), to: at(hi), length: hi - lo }
}

interface Node { start: number, end: number, left: number, right: number, bounds: Float64Array, boundary?: Uint32Array, weldedBoundary?: Uint32Array }
/** Immutable selection built against one hierarchy. A pair is included when
 * either triangle is selected; unselected triangles remain collision partners. */
export interface SurfaceSelection { readonly surface: SurfaceContacts, readonly faces: Uint8Array, readonly nodes: Uint8Array }

/** Project a triangle's two plane cuts into one common, translated coordinate.
 * Scratch storage belongs to the query, so dense length-only scoring allocates
 * neither temporary vectors nor intersection objects for each triangle pair. */
function cutRange (tri: Triangle3, distances: Point3, direction: Point3, origin: Point3, range: Float64Array, first?: Point3): boolean {
  let lo=Infinity, hi=-Infinity, count=0
  for (let k=0;k<3;k++) {
    const j=(k+1)%3,d=distances[k],e=distances[j]
    let x:number,y:number,z:number
    if(d===0) {x=tri[k][0];y=tri[k][1];z=tri[k][2]}
    else if((d<0&&e>0)||(d>0&&e<0)) {
      const u=d/(d-e)
      x=tri[k][0]+(tri[j][0]-tri[k][0])*u;y=tri[k][1]+(tri[j][1]-tri[k][1])*u;z=tri[k][2]+(tri[j][2]-tri[k][2])*u
    } else continue
    if(count===0&&first!==undefined){first[0]=x;first[1]=y;first[2]=z}
    count++
    const t=(x-origin[0])*direction[0]+(y-origin[1])*direction[1]+(z-origin[2])*direction[2]
    lo=Math.min(lo,t);hi=Math.max(hi,t)
  }
  range[0]=lo;range[1]=hi
  return count===2
}

/** Refit a stable triangle hierarchy for each deformed pose. Face IDs and vertex
 * aliases refer to the bind topology, so existing crossings can be compared
 * with the exact same face pair in a candidate skin or naturalized frame. */
export class SurfaceContacts {
  private readonly faces: number[]
  private readonly nodes: Node[] = []
  private readonly faceBounds: Float64Array
  private readonly triangles: Triangle3[]
  private readonly normals: Array<Point3|null>
  private readonly da:Point3=[0,0,0]
  private readonly db:Point3=[0,0,0]
  private readonly direction:Point3=[0,0,0]
  private readonly rangeA=new Float64Array(2)
  private readonly rangeB=new Float64Array(2)
  private readonly first:Point3=[0,0,0]
  private readonly from:Point3=[0,0,0]
  private readonly to:Point3=[0,0,0]
  private positions: ArrayLike<number>
  readonly index: Uint32Array
  readonly aliases: Uint32Array
  private readonly windingVertices: Uint32Array
  private windingWelded = false

  constructor (positions: ArrayLike<number>, index: ArrayLike<number>, aliases?: ArrayLike<number>) {
    if (positions.length % 3 !== 0 || index.length % 3 !== 0) throw new Error('Surface contact data must contain complete vertices and triangles')
    const vertices = positions.length / 3
    if (aliases !== undefined && aliases.length !== vertices) throw new Error('Surface vertex aliases do not match the vertices')
    for (const v of Array.from(index)) if (!Number.isSafeInteger(v) || v < 0 || v >= vertices) throw new Error('Surface triangle index is out of range')
    this.positions = positions
    this.index = Uint32Array.from(index)
    this.aliases = aliases === undefined ? Uint32Array.from({ length: vertices }, (_, i) => i) : Uint32Array.from(aliases)
    const representatives=new Map<number,number>()
    this.windingVertices=Uint32Array.from(this.aliases,(alias,v)=>{
      if(!representatives.has(alias))representatives.set(alias,v)
      return representatives.get(alias)!
    })
    this.faces = Array.from({ length: index.length / 3 }, (_, i) => i)
    this.faceBounds = new Float64Array(this.faces.length * 6)
    this.triangles = this.faces.map(() => [[0,0,0],[0,0,0],[0,0,0]])
    this.normals = this.faces.map(() => [0,0,0])
    this.readBounds()
    if (this.faces.length > 0) this.build(0, this.faces.length)
    this.refit(positions)
  }

  private readBounds (): void {
    for (let t = 0; t < this.faces.length; t++) {
      const tri=this.triangles[t]
      for (let k=0;k<3;k++) for(let axis=0;axis<3;axis++) tri[k][axis]=this.positions[this.index[t*3+k]*3+axis]
      for (let axis = 0; axis < 3; axis++) {
        this.faceBounds[t*6 + axis] = Math.min(tri[0][axis],tri[1][axis],tri[2][axis])
        this.faceBounds[t*6 + 3 + axis] = Math.max(tri[0][axis],tri[1][axis],tri[2][axis])
      }
      // Each plane is shared by every pair containing this face. Recompute it
      // once per refit, including when a previously degenerate face recovers.
      const ax=tri[1][0]-tri[0][0], ay=tri[1][1]-tri[0][1], az=tri[1][2]-tri[0][2]
      const bx=tri[2][0]-tri[0][0], by=tri[2][1]-tri[0][1], bz=tri[2][2]-tri[0][2]
      const x=ay*bz-az*by, y=az*bx-ax*bz, z=ax*by-ay*bx, length=Math.hypot(x,y,z)
      if (length>0) {
        const n:Point3=this.normals[t]??[0,0,0]; n[0]=x/length;n[1]=y/length;n[2]=z/length;this.normals[t]=n
      } else this.normals[t]=null
    }
  }

  private build (start: number, end: number): number {
    const at = this.nodes.length
    const node: Node = { start, end, left: -1, right: -1, bounds: new Float64Array(6) }
    this.nodes.push(node)
    if (end - start > 8) {
      const lo = [Infinity,Infinity,Infinity], hi = [-Infinity,-Infinity,-Infinity]
      for (let i = start; i < end; i++) for (let axis = 0; axis < 3; axis++) {
        const c = this.faceBounds[this.faces[i]*6+axis] + this.faceBounds[this.faces[i]*6+3+axis]
        lo[axis] = Math.min(lo[axis],c); hi[axis] = Math.max(hi[axis],c)
      }
      const axis = hi.map((v,k) => v-lo[k]).reduce((best, v, k, extents) => v > extents[best] ? k : best, 0)
      const centre = (f: number): number => this.faceBounds[f*6+axis] + this.faceBounds[f*6+3+axis]
      const sorted = this.faces.slice(start,end).sort((a,b) => centre(a)-centre(b) || a-b)
      for (let i = 0; i < sorted.length; i++) this.faces[start+i] = sorted[i]
      const mid = Math.floor((start+end)/2)
      node.left = this.build(start,mid); node.right = this.build(mid,end)
      // Outside this node's box, its triangle patch subtends exactly the same
      // solid angle as a fan over its oriented boundary. The closed difference
      // is contained in the box and has zero winding there. Keep both boundaries:
      // welded UV copies may separate after skinning, requiring raw indices.
      for(const welded of [false,true]){
        const edges = new Map<string,number>()
        for (let i=start;i<end;i++) for(let k=0;k<3;k++) {
          let a=this.index[this.faces[i]*3+k],b=this.index[this.faces[i]*3+(k+1)%3]
          if(welded){a=this.windingVertices[a];b=this.windingVertices[b]}
          if(a===b)continue
          const key=`${Math.min(a,b)},${Math.max(a,b)}`
          edges.set(key,(edges.get(key)??0)+(a<b?1:-1))
        }
        const boundary:number[]=[]
        for(const [key,count] of edges) {
          const [a,b]=key.split(',').map(Number)
          for(let i=0;i<Math.abs(count);i++)boundary.push(...(count>0?[a,b]:[b,a]))
        }
        if(boundary.length/2<end-start)node[welded?'weldedBoundary':'boundary']=Uint32Array.from(boundary)
      }
    }
    return at
  }

  refit (positions: ArrayLike<number>): void {
    if (positions.length !== this.positions.length) throw new Error('Deformed surface vertex count changed')
    for (let k = 0; k < positions.length; k++) if (!Number.isFinite(positions[k])) throw new Error('Deformed surface has a nonfinite vertex')
    this.positions = positions
    this.windingWelded=true
    for(let v=0;v<this.windingVertices.length&&this.windingWelded;v++){
      const r=this.windingVertices[v]
      for(let k=0;k<3;k++)if(positions[v*3+k]!==positions[r*3+k]){this.windingWelded=false;break}
    }
    this.readBounds()
    for (let i = this.nodes.length-1; i >= 0; i--) {
      const n = this.nodes[i], b = n.bounds
      b.set([Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity])
      const include = (bounds: Float64Array, at: number): void => {
        for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k],bounds[at+k]); b[k+3] = Math.max(b[k+3],bounds[at+k+3]) }
      }
      if (n.left < 0) for (let j = n.start; j < n.end; j++) include(this.faceBounds,this.faces[j]*6)
      else { include(this.nodes[n.left].bounds,0); include(this.nodes[n.right].bounds,0) }
    }
  }

  selectFaces (selected: Iterable<number>): SurfaceSelection {
    const faces = new Uint8Array(this.faces.length), nodes = new Uint8Array(this.nodes.length)
    for (const f of selected) {
      if (!Number.isSafeInteger(f) || f < 0 || f >= faces.length) throw new Error('Selected surface face is out of range')
      faces[f] = 1
    }
    for (let i = this.nodes.length-1; i >= 0; i--) {
      const n = this.nodes[i]
      if (n.left < 0) { for (let j = n.start; j < n.end; j++) if (faces[this.faces[j]]) { nodes[i]=1; break } }
      else nodes[i] = nodes[n.left] | nodes[n.right]
    }
    return {surface:this,faces,nodes}
  }

  private intersection (ai:number,bi:number,epsilon:number,segment:boolean): number {
    const a=this.triangles[ai],b=this.triangles[bi],na=this.normals[ai],nb=this.normals[bi]
    if(na===null||nb===null) return 0
    const da=this.da,db=this.db,dir=this.direction
    for(let k=0;k<3;k++) {
      da[k]=nb[0]*(a[k][0]-b[0][0])+nb[1]*(a[k][1]-b[0][1])+nb[2]*(a[k][2]-b[0][2])
      db[k]=na[0]*(b[k][0]-a[0][0])+na[1]*(b[k][1]-a[0][1])+na[2]*(b[k][2]-a[0][2])
    }
    if(Math.min(da[0],da[1],da[2])>=-epsilon||Math.max(da[0],da[1],da[2])<=epsilon||Math.min(db[0],db[1],db[2])>=-epsilon||Math.max(db[0],db[1],db[2])<=epsilon) return 0
    dir[0]=na[1]*nb[2]-na[2]*nb[1];dir[1]=na[2]*nb[0]-na[0]*nb[2];dir[2]=na[0]*nb[1]-na[1]*nb[0]
    const norm=Math.hypot(dir[0],dir[1],dir[2])
    if(norm<1e-12) return 0
    for(let k=0;k<3;k++)dir[k]/=norm
    const origin=a[0]
    if(!cutRange(a,da,dir,origin,this.rangeA,segment?this.first:undefined)||!cutRange(b,db,dir,origin,this.rangeB)) return 0
    const lo=Math.max(this.rangeA[0],this.rangeB[0]),hi=Math.min(this.rangeA[1],this.rangeB[1])
    if(hi-lo<=epsilon) return 0
    if(segment) {
      const offset=(this.first[0]-origin[0])*dir[0]+(this.first[1]-origin[1])*dir[1]+(this.first[2]-origin[2])*dir[2]
      for(let k=0;k<3;k++){this.from[k]=this.first[k]+(lo-offset)*dir[k];this.to[k]=this.first[k]+(hi-offset)*dir[k]}
    }
    return hi-lo
  }

  private visit (epsilon:number,selected:SurfaceSelection|undefined,emit?: (a:number,b:number,length:number)=>void): number {
    if (selected !== undefined && selected.surface !== this) throw new Error('Surface selection belongs to another hierarchy')
    if (this.nodes.length === 0) return 0
    const stack = [0,0]
    let length=0
    const overlaps = (a: Float64Array, i: number, b: Float64Array, j: number): boolean => {
      return !(a[i]>b[j+3]+epsilon||b[j]>a[i+3]+epsilon||a[i+1]>b[j+4]+epsilon||b[j+1]>a[i+4]+epsilon||a[i+2]>b[j+5]+epsilon||b[j+2]>a[i+5]+epsilon)
    }
    const test = (a: number, b: number): void => {
      if (selected !== undefined && !(selected.faces[a] || selected.faces[b])) return
      if (!overlaps(this.faceBounds,a*6,this.faceBounds,b*6)) return
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) if (this.aliases[this.index[a*3+k]] === this.aliases[this.index[b*3+j]]) return
      const hit = this.intersection(a,b,epsilon,emit!==undefined)
      if (hit > 0) {length+=hit;emit?.(Math.min(a,b),Math.max(a,b),hit)}
    }
    while (stack.length > 0) {
      const bi = stack.pop()!, ai = stack.pop()!, a = this.nodes[ai], b = this.nodes[bi]
      if (selected !== undefined && !(selected.nodes[ai] || selected.nodes[bi])) continue
      if (!overlaps(a.bounds,0,b.bounds,0)) continue
      if (a.left < 0 && b.left < 0) {
        for (let i = a.start; i < a.end; i++) for (let j = ai === bi ? i+1 : b.start; j < b.end; j++) test(this.faces[i],this.faces[j])
      } else if (ai === bi) stack.push(a.left,a.left,a.left,a.right,a.right,a.right)
      else if (b.left < 0 || (a.left >= 0 && a.end-a.start >= b.end-b.start)) stack.push(a.left,bi,a.right,bi)
      else stack.push(ai,b.left,ai,b.right)
    }
    return length
  }

  crossingLength (epsilon=1e-7,selected?:SurfaceSelection): number {
    return this.visit(epsilon,selected)
  }

  /** Generalized winding number (signed solid angle / 4 pi). For an outward,
   * closed mesh this is one inside and zero outside, including a completely
   * enclosed shell that has no triangle crossings. Open or inconsistently
   * oriented patches yield a real-valued diagnostic, not a watertight solid.
   * Jacobson et al. 2013: https://igl.ethz.ch/projects/winding-number/ */
  signedWinding (point: Point3): number {
    if(!point.every(Number.isFinite))throw new Error('Winding query must be finite')
    let sum=0,correction=0
    const add=(a:Point3,b:Point3,c:Point3):void=>{
      let ax=a[0]-point[0],ay=a[1]-point[1],az=a[2]-point[2]
      let bx=b[0]-point[0],by=b[1]-point[1],bz=b[2]-point[2]
      let cx=c[0]-point[0],cy=c[1]-point[1],cz=c[2]-point[2]
      let al=Math.sqrt(ax*ax+ay*ay+az*az),bl=Math.sqrt(bx*bx+by*by+bz*bz),cl=Math.sqrt(cx*cx+cy*cy+cz*cz)
      if(al===0||!Number.isFinite(al))al=Math.hypot(ax,ay,az)
      if(bl===0||!Number.isFinite(bl))bl=Math.hypot(bx,by,bz)
      if(cl===0||!Number.isFinite(cl))cl=Math.hypot(cx,cy,cz)
      // The solid angle on a vertex is direction-dependent. Callers measuring
      // a surface offset never query a vertex; do not manufacture an infinity.
      if(al===0||bl===0||cl===0)return
      ax/=al;ay/=al;az/=al;bx/=bl;by/=bl;bz/=bl;cx/=cl;cy/=cl;cz/=cl
      const numerator=ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx)
      const denominator=1+ax*bx+ay*by+az*bz+bx*cx+by*cy+bz*cz+cx*ax+cy*ay+cz*az
      const value=Math.atan2(numerator,denominator)-correction,next=sum+value
      correction=(next-sum)-value;sum=next
    }
    const stack=this.nodes.length===0?[]:[0],anchor:Point3=[0,0,0],a:Point3=[0,0,0],b:Point3=[0,0,0]
    while(stack.length>0){
      const n=this.nodes[stack.pop()!],box=n.bounds
      const boundary=this.windingWelded?(n.weldedBoundary??n.boundary):n.boundary
      if(boundary!==undefined&&(point[0]<box[0]||point[0]>box[3]||point[1]<box[1]||point[1]>box[4]||point[2]<box[2]||point[2]>box[5])){
        for(let k=0;k<3;k++)anchor[k]=box[k]+(box[k+3]-box[k])/2
        for(let i=0;i<boundary.length;i+=2){
          for(let k=0;k<3;k++){a[k]=this.positions[boundary[i]*3+k];b[k]=this.positions[boundary[i+1]*3+k]}
          add(anchor,a,b)
        }
      }else if(n.left>=0)stack.push(n.left,n.right)
      else for(let i=n.start;i<n.end;i++){
        const f=this.faces[i]
        if(this.normals[f]!==null)add(...this.triangles[f])
      }
    }
    return sum/(2*Math.PI)
  }


  crossings (epsilon=1e-7,selected?:SurfaceSelection): SurfaceCrossing[] {
    const out:SurfaceCrossing[]=[]
    this.visit(epsilon,selected,(a,b,length)=>out.push({a,b,length,from:[...this.from],to:[...this.to]}))
    return out.sort((a,b)=>a.a-b.a||a.b-b.b)
  }
}
