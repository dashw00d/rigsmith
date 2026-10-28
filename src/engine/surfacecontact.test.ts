// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SurfaceContacts, triangleCrossing, type Point3, type Triangle3 } from './surfacecontact.ts'

const a: Triangle3 = [[-1,-1,0],[1,-1,0],[0,1,0]]
const b: Triangle3 = [[0,-.5,-1],[0,-.5,1],[0,.5,0]]
const cubeVertices=[-1,-1,-1,1,-1,-1,1,1,-1,-1,1,-1,-1,-1,1,1,-1,1,1,1,1,-1,1,1]
const cubeFaces=[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5]

describe('oriented solid-angle queries',()=>{
  it('detects enclosed surfaces even when no triangles cross and respects orientation',()=>{
    const p=[...cubeVertices,...cubeVertices.map(x=>x*.25)],t=[...cubeFaces,...cubeFaces.map(v=>v+8)],surface=new SurfaceContacts(p,t)
    expect(surface.crossings()).toHaveLength(0)
    expect(surface.signedWinding([0,0,0])).toBeCloseTo(2,12)
    expect(surface.signedWinding([.5,0,0])).toBeCloseTo(1,12)
    expect(surface.signedWinding([2,0,0])).toBeCloseTo(0,12)
    const inward=new SurfaceContacts(cubeVertices,[...cubeFaces].reverse())
    expect(inward.signedWinding([0,0,0])).toBeCloseTo(-1,12)
  })
  it('agrees with direct triangle solid angles for open, deformed, translated patches',()=>{
    const direct=(positions:number[],index:number[],point:Point3):number=>{
      let sum=0
      for(let i=0;i<index.length;i+=3){
        const [a,b,c]=[0,1,2].map(k=>[0,1,2].map(j=>positions[index[i+k]*3+j]-point[j]))
        const dot=(a:number[],b:number[]):number=>a.reduce((s,v,j)=>s+v*b[j],0)
        const det=a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0])
        const la=Math.hypot(...a),lb=Math.hypot(...b),lc=Math.hypot(...c)
        sum+=2*Math.atan2(det,la*lb*lc+dot(a,b)*lc+dot(b,c)*la+dot(c,a)*lb)
      }
      return sum/(4*Math.PI)
    }
    // An open cube's two extra reversed/duplicate faces also exercise signed
    // edge multiplicities, rather than assuming a manifold or closed surface.
    const index=[...cubeFaces.slice(6),...cubeFaces.slice(9,12),...cubeFaces.slice(0,3).reverse()]
    for(const [scale,offset]of [[.001,0],[1,10000],[1000,-1e6]]){
      const positions=cubeVertices.map((v,i)=>(v+Math.sin(i)*.13)*scale+offset),tree=new SurfaceContacts(positions,index)
      for(let step=0;step<3;step++){
        for(let i=0;i<positions.length;i++)positions[i]+=Math.sin(i+step)*scale*.07
        tree.refit(positions)
        for(let i=0;i<70;i++){
          const point:Point3=[Math.sin(i*.7)*3,Math.cos(i*1.1)*2,Math.sin(i*1.9)*1.8].map(x=>x*scale+offset) as Point3
          expect(tree.signedWinding(point)).toBeCloseTo(direct(positions,index,point),9)
        }
      }
    }
  })
  it('does not cancel split seam edges that move apart',()=>{
    const vertices=cubeFaces.flatMap(i=>cubeVertices.slice(i*3,i*3+3)),aliases=[...cubeFaces]
    const surface=new SurfaceContacts(vertices,Array.from({length:aliases.length},(_,i)=>i),aliases)
    expect(surface.signedWinding([0,0,0])).toBeCloseTo(1,12)
    for(let i=0;i<9;i++)vertices[i]+=i%3===2?2:0
    surface.refit(vertices)
    expect(surface.signedWinding([0,0,0])).not.toBeCloseTo(1,4)
    expect(new SurfaceContacts([],[]).signedWinding([0,0,0])).toBe(0)
    expect(()=>surface.signedWinding([NaN,0,0])).toThrow('finite')
  })
})
describe('proper surface crossings', () => {
  it('finds the actual intersection segment and is invariant to winding and order', () => {
    for (const x of [a,[...a].reverse() as Triangle3]) for (const y of [b,[...b].reverse() as Triangle3]) for (const [p,q] of [[x,y],[y,x]]) {
      const hit = triangleCrossing(p,q)!
      expect(hit.length).toBeCloseTo(1,12)
      expect([hit.from,hit.to].sort((p,q) => p[1]-q[1])).toEqual([[0,-.5,0],[0,.5,0]])
    }
  })
  it('rejects separation, coplanar overlap, point touches and degenerate faces', () => {
    expect(triangleCrossing(a,b.map(v => [v[0]+2,v[1],v[2]]) as Triangle3)).toBeNull()
    expect(triangleCrossing(a,a)).toBeNull()
    expect(triangleCrossing(a,[[0,1,0],[0,2,1],[0,2,-1]])).toBeNull()
    expect(triangleCrossing(a,[[0,0,-1],[0,0,0],[0,0,1]])).toBeNull()
    expect(triangleCrossing(a,[[-1,-1,0],[1,-1,0],[0,-2,1]])).toBeNull()
  })
  it('works at different scales, far from the origin and near parallel', () => {
    for (const scale of [.001,1,1000]) {
      const move = (t: Triangle3): Triangle3 => t.map(p => p.map(v => v*scale+10000)) as Triangle3
      expect(triangleCrossing(move(a),move(b),scale*1e-8)!.length).toBeCloseTo(scale,8)
    }
    const near: Triangle3 = b.map(p => [p[2],p[1],p[2]*1e-6]) as Triangle3
    expect(triangleCrossing(a,near,1e-10)!.length).toBeCloseTo(1,8)
  })
})

describe('surface hierarchy across deformed poses', () => {
  it('agrees with the independent plane-cut routine across random pairs, scales and translations',()=>{
    let seed=173
    const random=():number=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*2-1}
    const base:Triangle3[]=Array.from({length:50},()=>Array.from({length:3},()=>[random(),random(),random()]) as Triangle3)
    for(const [scale,offset]of [[1,0],[.001,10000],[1000,-1000000]]) {
      const triangles=base.map(t=>t.map(p=>p.map(v=>v*scale+offset)) as Triangle3),positions=triangles.flat(2),epsilon=scale*1e-7
      const tree=new SurfaceContacts(positions,Array.from({length:positions.length/3},(_,i)=>i))
      const actual=tree.crossings(epsilon),expected=triangles.flatMap((a,i)=>triangles.flatMap((b,j)=>{const hit=j>i?triangleCrossing(a,b,epsilon):null;return hit===null?[]:[{a:i,b:j,...hit}]}))
      expect(actual.map(c=>[c.a,c.b])).toEqual(expected.map(c=>[c.a,c.b]))
      actual.forEach((hit,i)=>{
        expect(Math.abs(hit.length-expected[i].length)).toBeLessThan(scale*1e-9)
        for(const p of [hit.from,hit.to]) expect(Math.min(...[expected[i].from,expected[i].to].map(q=>Math.hypot(...p.map((x,k)=>x-q[k]))))).toBeLessThan(Math.max(scale*1e-9,Math.abs(offset)*1e-14))
      })
      expect(Math.abs(tree.crossingLength(epsilon)-expected.reduce((s,c)=>s+c.length,0))).toBeLessThan(scale*1e-8)
    }
  })
  it('clears and restores cached planes when a face collapses and recovers',()=>{
    const positions=[...a.flat(),...b.flat()],tree=new SurfaceContacts(positions,[0,1,2,3,4,5])
    expect(tree.crossingLength()).toBeCloseTo(1,12)
    tree.refit([...new Array(9).fill(0),...b.flat()]);expect(tree.crossingLength()).toBe(0)
    tree.refit(positions);expect(tree.crossingLength()).toBeCloseTo(1,12)
  })
  it('finds every pair exactly once through refits, agreeing with an exhaustive traversal', () => {
    const triangles: Triangle3[] = []
    // Deterministic offset planes, with both crossings and clear separation.
    for (let i = 0; i < 30; i++) triangles.push((i%2 ? a : b).map(p => [p[0]+(i%5)*.47,p[1]+Math.floor(i/5)*.31,p[2]+Math.sin(i)*.2]) as Triangle3)
    const positions = triangles.flat(2), index = positions.map((_,i) => i).slice(0,positions.length/3)
    const tree = new SurfaceContacts(positions,index)
    const pairs = (): string[] => triangles.flatMap((a,i) => triangles.flatMap((b,j) => j > i && triangleCrossing(a,b) !== null ? [`${i},${j}`] : []))
    const actual = (): string[] => tree.crossings().map(c => `${c.a},${c.b}`)
    expect(actual()).toEqual(pairs()); expect(actual().length).toBeGreaterThan(20)
    for (let i = 0; i < triangles.length; i++) for (const p of triangles[i]) p[2] += i*.8
    tree.refit(triangles.flat(2)); expect(actual()).toEqual(pairs())
  })
  it('ignores adjacent faces and welded attribute seams, without merging nearby surfaces', () => {
    const positions = [...a.flat(),...b.flat()]
    expect(new SurfaceContacts(positions,[0,1,2,3,4,5]).crossings()).toHaveLength(1)
    expect(new SurfaceContacts(positions,[0,1,2,3,4,5],[0,1,2,0,4,5]).crossings()).toHaveLength(0)
    expect(new SurfaceContacts(positions,[0,1,2,0,4,5]).crossings()).toHaveLength(0)
  })
  it('handles empty surfaces and rejects corrupt geometry', () => {
    expect(new SurfaceContacts([],[]).crossings()).toEqual([])
    expect(() => new SurfaceContacts(a.flat(),[0,1,4])).toThrow('out of range')
    const tree = new SurfaceContacts(a.flat(),[0,1,2])
    expect(() => tree.refit([])).toThrow('count changed')
    expect(() => tree.refit(a.flat().map((v,i) => i === 0 ? NaN : v))).toThrow('nonfinite')
  })
  it('filters pairs by either selected face through refits, retaining unselected collision partners',()=>{
    const triangles:Triangle3[]=Array.from({length:30},(_,i)=>(i%2?a:b).map(p=>[p[0]+(i%5)*.3,p[1]+Math.floor(i/5)*.2,p[2]+Math.sin(i)*.1]) as Triangle3)
    const positions=triangles.flat(2),index=Array.from({length:positions.length/3},(_,i)=>i),tree=new SurfaceContacts(positions,index)
    const selected=new Set([1,7,16]),query=tree.selectFaces(selected)
    const check=():void=>expect(tree.crossings(1e-7,query)).toEqual(tree.crossings().filter(c=>selected.has(c.a)||selected.has(c.b)))
    check()
    for(let f=0;f<triangles.length;f++) for(const p of triangles[f]) p[0]+=f*.1
    tree.refit(triangles.flat(2));check()
    expect(tree.crossings(1e-7,tree.selectFaces([]))).toEqual([])
    expect(()=>tree.selectFaces([30])).toThrow('out of range')
    expect(()=>new SurfaceContacts(positions,index).crossings(1e-7,query)).toThrow('another hierarchy')
  })
})
