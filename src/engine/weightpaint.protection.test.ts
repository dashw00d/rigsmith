import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { SurfaceContacts } from './surface-contacts.ts'
import { type PaintPick, WeightPainter } from './weightpaint.ts'

function rig (sheets: Array<[number, number, number, number, number]> = [[-.1, .1, 0, .4, .6]]): { root: THREE.Group, meshes: THREE.SkinnedMesh[] } {
  const root = new THREE.Group()
  const bone = (name: string, at: [number, number, number], parent?: THREE.Bone): THREE.Bone => {
    const b = new THREE.Bone(); b.name = name; b.position.fromArray(at)
    if (parent === undefined) root.add(b); else parent.add(b)
    return b
  }
  const hips = bone('Hips', [0, 1, -.5]); const spine = bone('Spine', [0, .3, 0], hips)
  const head = bone('Head', [0, .3, 0], spine)
  const left = bone('LeftUpLeg', [.08, -.1, 0], hips); const shin = bone('LeftLeg', [0, -.5, 0], left)
  const foot = bone('LeftFoot', [0, -.4, 0], shin)
  const right = bone('RightUpLeg', [-.08, -.1, 0], hips); const rshin = bone('RightLeg', [0, -.5, 0], right)
  const rfoot = bone('RightFoot', [0, -.4, 0], rshin)
  const bones = [hips, spine, head, left, shin, foot, right, rshin, rfoot]
  const meshes = sheets.map(([a, b, z, bottom, top]) => {
    const positions: number[] = []; const index: number[] = []
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) positions.push(a + (b - a) * x / 2, bottom + (top - bottom) * y / 2, z)
    positions.push(...positions.slice(0, 3)) // real UV alias of point 0
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      const p = y * 3 + x; index.push(p, p + 1, p + 4, p === 0 ? 9 : p, p + 4, p + 3)
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setIndex(index)
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(40).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 10 }, () => [1, 0, 0, 0]).flat(), 4))
    const mesh = new THREE.SkinnedMesh(g); root.add(mesh); return mesh
  })
  root.updateMatrixWorld(true)
  meshes.forEach(mesh => mesh.bind(new THREE.Skeleton(bones)))
  return { root, meshes }
}

const all = new Map(Array.from({ length: 9 }, (_, p) => [p, 1]))
const raw = (meshes: THREE.SkinnedMesh[]): number[][][] => meshes.map(mesh => ['position', 'skinIndex', 'skinWeight'].map(k => Array.from(mesh.geometry.attributes[k].array)))
const masks = (p: WeightPainter): number[][] => p.protectedPoints.map(points => [...points].sort((a, b) => a - b))
const slots = (m: THREE.SkinnedMesh, p: number): number[][] => ['position', 'skinIndex', 'skinWeight'].map(k =>
  Array.from({ length: m.geometry.attributes[k].itemSize }, (_, i) => m.geometry.attributes[k].getComponent(p, i)))
const id = (m: THREE.SkinnedMesh, name: string): number => m.skeleton.bones.findIndex(b => b.name === name)
function set (m: THREE.SkinnedMesh, p: number, name: string): void {
  for (const v of p === 0 ? [0, 9] : [p]) {
    m.geometry.attributes.skinIndex.setXYZW(v, id(m, name), 0, 0, 0)
    m.geometry.attributes.skinWeight.setXYZW(v, 1, 0, 0, 0)
  }
}
function protect (p: WeightPainter, part: number, points: ReadonlyMap<number, number>, on = true): void {
  p.begin({ bounded: true, stableSurface: true, preserveSurface: false }); p.protect(part, points, on); p.end()
}
function hit (meshes: THREE.SkinnedMesh[]): PaintPick {
  return { part: 2, point: meshes[2].getVertexPosition(4, new THREE.Vector3()).applyMatrix4(meshes[2].matrixWorld),
    normal: new THREE.Vector3(0, 0, 1), face: [0, 1, 4], distance: 1, points: all }
}

describe('session point protection', () => {
  it('protects/unprotects UV aliases with exact mask Undo and no edit payload or empty Undo steps', () => {
    const { meshes } = rig(); const p = new WeightPainter(meshes); p.mirror = false; const before = raw(meshes)
    protect(p, 0, new Map([[9, .2]]))
    expect(masks(p)).toEqual([[0]]); expect(p.protectedCount).toBe(1)
    expect(p.editedCount).toBe(0); expect(p.edits()).toEqual([]); expect(p.shapeEdits()).toEqual([])
    protect(p, 0, new Map([[0, 1]])) // already protected: no extra undo
    protect(p, 0, new Map([[0, 0], [1, -1], [2, NaN], [3, Infinity], [99, 1]]))
    protect(p, 0, new Map([[9, 1]]), false)
    expect(p.protectedCount).toBe(0)
    expect(p.stepBack()).toBe(true); expect(masks(p)).toEqual([[0]])
    expect(p.stepBack()).toBe(true); expect(p.protectedCount).toBe(0)
    expect(p.stepBack()).toBe(false); expect(raw(meshes)).toEqual(before)
  })

  it('clears protection in one independent Undo step and keeps it across saved() without serializing it', () => {
    const { meshes } = rig(); const p = new WeightPainter(meshes); p.mirror = false
    protect(p, 0, new Map([[0, 1], [4, 1]])); const locked = masks(p)
    p.clearProtection(); expect(p.protectedCount).toBe(0)
    expect(p.stepBack()).toBe(true); expect(masks(p)).toEqual(locked)
    p.saved(); expect(masks(p)).toEqual(locked); expect(p.edits()).toEqual([]); expect(p.shapeEdits()).toEqual([])
    expect(p.stepBack()).toBe(false)
    p.clearProtection(); p.clearProtection()
    expect(p.stepBack()).toBe(true); expect(masks(p)).toEqual(locked); expect(p.stepBack()).toBe(false)
    expect(new WeightPainter(meshes).protectedCount).toBe(0)
  })

  it('propagates protection across material seams, including readonly copies, and pins every UV member', () => {
    const { meshes } = rig([[-.2, 0, .008, .4, .6], [0, .2, .008, .4, .6]])
    const p = new WeightPainter(meshes, undefined, new Set([meshes[0]])); p.mirror = false
    protect(p, 0, new Map([[5, 1], [9, 1]]))
    expect(p.protectedPoints[0].has(5)).toBe(true); expect(p.protectedPoints[1].has(3)).toBe(true)
    const before = raw(meshes); const seam = slots(meshes[0], 5)
    p.begin(); p.add(0, all, id(meshes[0], 'Head'), 1); p.end()
    expect(slots(meshes[0], 5)).toEqual(seam); expect(slots(meshes[0], 0)).toEqual(before[0].map(a => a.slice(0, a.length / 10)))
    expect(slots(meshes[0], 9)).toEqual(slots(meshes[0], 0)); expect(raw(meshes)[1]).toEqual(before[1])
    expect(p.weights(0, 4).get(id(meshes[0], 'Head'))).toBe(1)
    expect(p.stepBack()).toBe(true); expect(raw(meshes)).toEqual(before)
    protect(p, 1, new Map([[3, 1]]), false) // can erase an alias even though that primitive is readonly
    expect(p.protectedPoints[0].has(5)).toBe(false); expect(p.protectedPoints[1].has(3)).toBe(false)
  })

  it('mirrors a Protect gesture, but an already protected twin stays fixed during weight brushes and Copy side', () => {
    const { meshes } = rig(); const p = new WeightPainter(meshes); const m = meshes[0]
    protect(p, 0, new Map([[3, 1]])); expect(masks(p)).toEqual([[3, 5]])
    expect(p.stepBack()).toBe(true)
    p.mirror = false; protect(p, 0, new Map([[3, 1]])); p.mirror = true
    const locked = slots(m, 3)
    p.begin(); p.add(0, new Map([[5, 1]]), id(m, 'Head'), 1); p.end()
    expect(p.weights(0, 5)).toEqual(new Map([[id(m, 'Head'), 1]])); expect(slots(m, 3)).toEqual(locked)
    p.copySide(1); expect(slots(m, 3)).toEqual(locked)
    expect(p.edits().some(e => e.vertex === 3)).toBe(false)
  })

  it.each(['follow', 'cloth', 'lift'] as const)('keeps protected lining and donor raw data fixed during coupled %s layers', tool => {
    const { meshes } = rig([[-.3, .3, 0, 0, 1], [-.06, .06, .004, .4, .6], [-.06, .06, .008, .4, .6]])
    for (let v = 0; v < 9; v++) set(meshes[0], v, 'LeftUpLeg')
    const p = new WeightPainter(meshes); p.mirror = false
    protect(p, 0, all); protect(p, 1, all); const before = raw(meshes)
    const calls: number[][] = []
    const original = SurfaceContacts.prototype.newContactSteps
    const spy = vi.spyOn(SurfaceContacts.prototype, 'newContactSteps').mockImplementation(function * (this: SurfaceContacts, ...args) {
      calls.push([...args[0]]); return yield * original.apply(this, args)
    })
    try {
      p.begin({ bounded: true, preserveSurface: true }); p.paintLayers(tool, hit(meshes), .2, 1, .02); p.end()
    } finally { spy.mockRestore() }
    expect(raw(meshes).slice(0, 2)).toEqual(before.slice(0, 2)); expect(raw(meshes)[2]).not.toEqual(before[2])
    expect(p.edits().every(e => e.mesh === 2)).toBe(true); expect(p.shapeEdits().every(e => e.mesh === 2)).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
    // Flattened addresses reserve ten vertex slots per part, including the UV alias. Protected points are fixed
    // body/lining, rather than moving ghost proposals that could unnecessarily limit the outer sheet.
    expect(calls.flat().every(key => key >= 20)).toBe(true)
    expect(p.stepBack()).toBe(true); expect(raw(meshes)).toEqual(before); expect(p.protectedCount).toBe(18)
  })

  it('leaves a protected selected Heal point pinned and selected, then heals it after unprotecting', () => {
    const { meshes } = rig(); const m = meshes[0]
    for (let v = 0; v < 9; v++) set(m, v, 'LeftUpLeg')
    set(m, 4, 'Head'); const p = new WeightPainter(meshes); p.mirror = false
    p.mark(0, new Map([[4, 1]])); protect(p, 0, new Map([[4, 1]])); const before = raw(meshes)
    expect(p.heal()).toBe(0); expect(raw(meshes)).toEqual(before); expect(p.area[0].has(4)).toBe(true)
    expect(p.stepBack()).toBe(true); expect(p.protectedCount).toBe(0) // empty Heal added no Undo
    expect(p.heal()).toBe(1); expect(p.weights(0, 4)).toEqual(new Map([[id(m, 'LeftUpLeg'), 1]]))
    expect(p.stepBack()).toBe(true); expect(raw(meshes)).toEqual(before); expect(p.area[0].has(4)).toBe(true)
  })

  it('pins an explicitly included body point in fused source geometry without relying on a body/layer classification', () => {
    const { root, meshes } = rig([[-.3, .3, 0, 0, 1], [-.06, .06, .004, .4, .6], [-.06, .06, .008, .4, .6]])
    for (let v = 0; v < 9; v++) set(meshes[0], v, 'LeftUpLeg')
    const g = new THREE.BufferGeometry()
    for (const [name, size] of [['position', 3], ['skinIndex', 4], ['skinWeight', 4]] as const) {
      const values = meshes.flatMap(m => Array.from(m.geometry.attributes[name].array))
      g.setAttribute(name, name === 'skinIndex' ? new THREE.Uint16BufferAttribute(values, size) : new THREE.Float32BufferAttribute(values, size))
    }
    g.setIndex(meshes.flatMap((m, q) => Array.from(m.geometry.index!.array, v => v + q * 10)))
    const fused = new THREE.SkinnedMesh(g); root.add(fused); root.updateMatrixWorld(true); fused.bind(meshes[0].skeleton)
    const p = new WeightPainter([fused]); p.mirror = false
    protect(p, 0, new Map([[4, 1]])); const locked = slots(fused, 4)
    const receivers = new Map([...p.parts[0].members.keys()].map(point => [point, 1]))
    p.begin({ bounded: true }); p.cloth(0, receivers, 1, new Set(receivers.keys())); p.end()
    expect(slots(fused, 4)).toEqual(locked)
    expect(p.editedCount).toBeGreaterThan(0); expect(p.edits().some(e => e.vertex === 4)).toBe(false)
    p.begin({ bounded: true }); expect(p.lift(0, new Map([[4, 1]]), .02, 1, new Set([4]))).toBe(0); p.end()
    expect(slots(fused, 4)).toEqual(locked); expect(p.shapeEdits()).toEqual([])
  })

  it('keeps protected layers unchanged through one deferred release containing both weight and Lift proposals', () => {
    const { root, meshes } = rig([[-.3, .3, 0, 0, 1], [-.06, .06, .004, .4, .6], [-.06, .06, .008, .4, .6]])
    for (let v = 0; v < 9; v++) set(meshes[0], v, 'LeftUpLeg')
    const p = new WeightPainter(meshes); p.mirror = false
    protect(p, 0, all); protect(p, 1, all); const before = raw(meshes)
    const clip = new THREE.AnimationClip('Leg bend', .1, [new THREE.NumberKeyframeTrack('LeftUpLeg.position[z]', [0, .05, .1], [0, -.01, 0])])
    p.begin({ bounded: true, preserveSurface: true, deferClip: true, animation: { root, clip } })
    p.paintLayers('follow', hit(meshes), .2, 1); p.paintLayers('lift', hit(meshes), .2, 1, .02); p.end()
    expect(raw(meshes).slice(0, 2)).toEqual(before.slice(0, 2))
    expect(p.edits().length).toBeGreaterThan(0); expect(p.shapeEdits().length).toBeGreaterThan(0)
    expect(p.edits().every(e => e.mesh === 2)).toBe(true); expect(p.shapeEdits().every(e => e.mesh === 2)).toBe(true)
    expect(p.stepBack()).toBe(true); expect(raw(meshes)).toEqual(before); expect(p.protectedCount).toBe(18)
  })

  it('forbids mixed protection/geometry gestures and clear commands in an open stroke', () => {
    const { meshes } = rig(); const p = new WeightPainter(meshes); p.mirror = false
    expect(() => p.protect(0, all)).toThrow('Begin a protection stroke')
    p.begin({ preserveSurface: true }); expect(() => p.protect(0, all)).toThrow('Finish the weight'); p.end()
    p.begin(); p.add(0, new Map([[4, 1]]), id(meshes[0], 'Head'), 1)
    expect(() => p.protect(0, all)).toThrow('Finish the weight'); expect(() => p.clearProtection()).toThrow('Finish the current stroke'); p.end()
    p.begin(); p.protect(0, new Map([[0, 1]])); const before = raw(meshes)
    expect(() => p.add(0, new Map([[4, 1]]), id(meshes[0], 'Head'), 1)).toThrow('Finish the protection stroke')
    expect(() => p.mark(0, all)).toThrow('Finish the protection stroke'); expect(() => p.clearArea()).toThrow('Finish the protection stroke')
    expect(() => p.saved()).toThrow('Release the brush'); expect(raw(meshes)).toEqual(before); p.end()
    expect(p.stepBack()).toBe(true); expect(p.stepBack()).toBe(true); expect(p.editedCount).toBe(0)
  })

  it('blocks mask changes during async validation and preserves earlier protection when that stroke is cancelled', async () => {
    const { root, meshes } = rig(); const p = new WeightPainter(meshes); p.mirror = false
    protect(p, 0, new Map([[0, 1]])); const locked = masks(p); const before = raw(meshes)
    const clip = new THREE.AnimationClip('Move', 1, [new THREE.NumberKeyframeTrack('Head.position[z]', [0, .5, 1], [0, -.1, 0])])
    p.begin({ bounded: true, preserveSurface: true, deferClip: true, animation: { root, clip } })
    p.add(0, new Map([[4, 1]]), id(meshes[0], 'Head'), .2)
    let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve })
    const checking = p.endAsync(async () => await pause); const preview = raw(meshes)
    for (const change of [() => p.protect(0, all), () => p.clearProtection(), () => p.mark(0, all), () => p.clearArea()]) expect(change).toThrow('Wait for the stroke check')
    expect(raw(meshes)).toEqual(preview); expect(masks(p)).toEqual(locked)
    expect(p.stepBack()).toBe(true); expect(raw(meshes)).toEqual(before); expect(masks(p)).toEqual(locked)
    p.begin(); p.add(0, new Map([[4, 1]]), id(meshes[0], 'Head'), .1); p.end(); const newer = raw(meshes)
    release(); expect(await checking).toBe(false); expect(raw(meshes)).toEqual(newer); expect(masks(p)).toEqual(locked)
    expect(p.stepBack()).toBe(true); expect(raw(meshes)).toEqual(before); expect(masks(p)).toEqual(locked)
    expect(p.stepBack()).toBe(true); expect(p.protectedCount).toBe(0); expect(p.stepBack()).toBe(false)
  })
})
