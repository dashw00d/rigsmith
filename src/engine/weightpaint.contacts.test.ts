import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { SurfaceContacts } from './surface-contacts.ts'
import { WeightPainter } from './weightpaint.ts'

function rig (split: boolean): { root: THREE.Group, cloth: THREE.SkinnedMesh, body: THREE.SkinnedMesh } {
  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'
  const moving = new THREE.Bone(); moving.name = 'Head'; hips.add(moving); root.add(hips)
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton([hips, moving]); skeleton.calculateInverses()
  const cloth = [-1, 0, .6, 1, 0, .6, 0, 1, .6]
  const body = [0, -.5, -.3, 0, 1.5, -.3, 0, .5, .3]
  const mesh = (positions: number[]): THREE.SkinnedMesh => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setIndex(Array.from({ length: positions.length / 3 }, (_, i) => i))
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(positions.length / 3 * 4).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: positions.length / 3 }, () => [1, 0, 0, 0]).flat(), 4))
    const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); root.add(m); root.updateMatrixWorld(true); m.bind(skeleton)
    return m
  }
  const a = mesh(split ? cloth : [...cloth, ...body]); const b = split ? mesh(body) : a
  moving.position.z = -.6; root.updateMatrixWorld(true); skeleton.update()
  return { root, cloth: a, body: b }
}

function layeredRig (): { root: THREE.Group, cloth: THREE.SkinnedMesh, body: THREE.SkinnedMesh, clip: THREE.AnimationClip } {
  const root = new THREE.Group(); const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.z = -.5
  const head = new THREE.Bone(); head.name = 'Head'; head.position.y = 1; hips.add(head); root.add(hips); root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton([hips, head]); skeleton.calculateInverses()
  const sheet = (z: number, half: number, bottom: number, top: number): THREE.SkinnedMesh => {
    const g = new THREE.BufferGeometry(); const positions: number[] = []; const triangles: number[] = []
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) positions.push(-half + x * half, bottom + y * (top - bottom) / 2, z)
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { const a = y * 3 + x; triangles.push(a, a + 1, a + 4, a, a + 4, a + 3) }
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setIndex(triangles)
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(36).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 9 }, () => [1, 0, 0, 0]).flat(), 4))
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); root.add(mesh); root.updateMatrixWorld(true); mesh.bind(skeleton)
    return mesh
  }
  const body = sheet(0, .3, 0, 1); const cloth = sheet(.003, .05, .4, .6)
  const clip = new THREE.AnimationClip('Squat', 1, [new THREE.NumberKeyframeTrack('Head.position[z]', [0, .5, 1], [0, -.2, 0])])
  return { root, body, cloth, clip }
}

describe('finite triangle contact guard', () => {
  it.each([false, true])('limits a rigidly translated, intact triangle entering a body (split primitives=%s)', split => {
    const { cloth, body } = rig(split)
    const meshes = split ? [cloth, body] : [cloth]
    const original = meshes.map(m => ({ indices: m.geometry.attributes.skinIndex.array.slice(), weights: m.geometry.attributes.skinWeight.array.slice() }))
    const painter = new WeightPainter(meshes, n => n, new Set([cloth])); painter.mirror = false
    painter.begin({ bounded: true, preserveSurface: true })
    painter.add(0, new Map([[0, 1], [1, 1], [2, 1]]), 1, 1); painter.end()
    expect(painter.limitedCount).toBe(3)
    for (const p of [0, 1, 2]) {
      const z = cloth.getVertexPosition(p, new THREE.Vector3()).z
      expect(z).toBeGreaterThan(.3)
      expect(z).toBeLessThan(.6)
    }
    for (let v = split ? 0 : 3; v < body.geometry.attributes.position.count; v++) expect(body.geometry.attributes.skinIndex.getX(v)).toBe(0)
    expect(painter.stepBack()).toBe(true)
    meshes.forEach((m, i) => {
      expect(m.geometry.attributes.skinIndex.array).toEqual(original[i].indices)
      expect(m.geometry.attributes.skinWeight.array).toEqual(original[i].weights)
    })
  })

  it('does not freeze an unrelated edit because another face pair already intersects', () => {
    const before = [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, -.5, -.3), new THREE.Vector3(0, 1.5, -.3), new THREE.Vector3(0, .5, .3)]
    const contacts = new SurfaceContacts([[0, 1, 2], [3, 4, 5]])
    const now = before.map(v => v.clone()); now[0].x -= .1
    expect(contacts.newContacts(new Set([0]), p => now[p], p => before[p], true).size).toBe(0)
  })

  it('limits a crossing in the playing clip while leaving the paused scene untouched', () => {
    const { root, cloth, body } = rig(true)
    const head = root.getObjectByName('Head')!; head.position.z = 0; root.updateMatrixWorld(true)
    const clip = new THREE.AnimationClip('Squat', 2, [new THREE.NumberKeyframeTrack('Head.position[z]', [0, 1, 2], [0, -.6, 0])])
    const painter = new WeightPainter([cloth, body], n => n, new Set([cloth])); painter.mirror = false
    painter.begin({ bounded: true, preserveSurface: true, animation: { root, clip } })
    painter.add(0, new Map([[0, 1], [1, 1], [2, 1]]), 1, 1); painter.end()
    expect(head.position.z).toBe(0)
    expect(painter.limitedCount).toBe(3)
    head.position.z = -.6; root.updateMatrixWorld(true)
    for (const p of [0, 1, 2]) expect(cloth.getVertexPosition(p, new THREE.Vector3()).z).toBeGreaterThan(.3)
  })

  it('checks a provisional drag over the clip on release, from the exact stroke source', () => {
    const { root, cloth, body } = rig(true)
    const head = root.getObjectByName('Head')!; head.position.z = 0; root.updateMatrixWorld(true)
    const clip = new THREE.AnimationClip('Squat', 2, [new THREE.NumberKeyframeTrack('Head.position[z]', [0, 1, 2], [0, -.6, 0])])
    const original = cloth.geometry.attributes.skinWeight.array.slice()
    const painter = new WeightPainter([cloth, body], n => n, new Set([cloth])); painter.mirror = false
    painter.begin({ bounded: true, preserveSurface: true, deferClip: true, animation: { root, clip } })
    painter.add(0, new Map([[0, .3], [1, .3], [2, .3]]), 1, 1)
    painter.add(0, new Map([[0, 1], [1, 1], [2, 1]]), 1, 1)
    expect(painter.weights(0, 0).get(1)).toBe(1)
    for (const publish of [() => painter.edits(), () => painter.shapeEdits(), () => painter.saved()]) expect(publish).toThrow('Release the brush')
    painter.end()
    expect(head.position.z).toBe(0)
    expect(painter.contactLimitedCount).toBe(3)
    expect(painter.edits()).toHaveLength(3)
    head.position.z = -.6; root.updateMatrixWorld(true)
    for (const p of [0, 1, 2]) expect(cloth.getVertexPosition(p, new THREE.Vector3()).z).toBeGreaterThan(.3)
    expect(painter.stepBack()).toBe(true)
    expect(cloth.geometry.attributes.skinWeight.array).toEqual(original)
    expect(painter.stepBack()).toBe(false)
    expect(painter.contactLimitedCount).toBe(0)
  })

  it('validates coupled weight and Lift edits on the same points as one release transaction', () => {
    const { root, cloth, body, clip } = layeredRig(); const points = new Map(Array.from({ length: 9 }, (_, p) => [p, 1]))
    const original = [cloth, body].map(m => Object.fromEntries(['position', 'skinIndex', 'skinWeight'].map(k => [k, m.geometry.attributes[k].array.slice()])))
    const painter = new WeightPainter([body, cloth], n => n, new Set([cloth])); painter.mirror = false
    painter.begin({ bounded: true, preserveSurface: true, deferClip: true, animation: { root, clip } })
    painter.add(1, points, 1, .2)
    painter.lift(1, points, .02, 1, new Set(points.keys()))
    expect(cloth.geometry.attributes.position.getZ(4)).toBeCloseTo(.02)
    painter.end()
    expect(painter.weights(1, 4).get(1)).toBeGreaterThan(0)
    expect(painter.weights(1, 4).get(1)).toBeLessThan(.2)
    expect(cloth.geometry.attributes.position.getZ(4)).toBeGreaterThan(.003)
    expect(cloth.geometry.attributes.position.getZ(4)).toBeLessThan(.02)
    const head = root.getObjectByName('Head')!; head.position.z = -.2; root.updateMatrixWorld(true)
    expect(cloth.getVertexPosition(4, new THREE.Vector3()).z).toBeGreaterThan(.00075)
    expect(painter.stepBack()).toBe(true)
    for (const [i, mesh] of [cloth, body].entries()) for (const k of ['position', 'skinIndex', 'skinWeight']) expect(mesh.geometry.attributes[k].array).toEqual(original[i][k])
    expect(painter.stepBack()).toBe(false)
  })

  it('omits an empty deferred gesture without adding a clip validation or Undo entry', () => {
    const { root, cloth, body, clip } = layeredRig()
    const painter = new WeightPainter([body, cloth]); painter.mirror = false
    painter.begin({ bounded: true, preserveSurface: true, deferClip: true, animation: { root, clip } }); painter.end()
    expect(painter.editedCount).toBe(0)
    expect(painter.limitedCount).toBe(0)
    expect(painter.stepBack()).toBe(false)
  })

  it('checks a brief collision between the previous 60 Hz probes', () => {
    const { root, cloth, body } = rig(true); const head = root.getObjectByName('Head')!
    head.position.z = 0; root.updateMatrixWorld(true)
    const clip = new THREE.AnimationClip('Quick bend', 1, [new THREE.NumberKeyframeTrack('Head.position[z]', [0, .3, 37 / 120, 19 / 60, 1], [0, 0, -.6, 0, 0])])
    const painter = new WeightPainter([cloth, body], n => n); painter.mirror = false
    painter.begin({ bounded: true, preserveSurface: true, deferClip: true, animation: { root, clip } })
    painter.add(0, new Map([[0, 1], [1, 1], [2, 1]]), 1, 1); painter.end()
    head.position.z = -.6; root.updateMatrixWorld(true)
    for (const p of [0, 1, 2]) expect(cloth.getVertexPosition(p, new THREE.Vector3()).z).toBeGreaterThan(.3)
  })

  it('keeps the preview visible and serialization locked until asynchronous validation commits', async () => {
    const { root, cloth, body } = rig(true); const head = root.getObjectByName('Head')!
    head.position.z = 0; root.updateMatrixWorld(true)
    const clip = new THREE.AnimationClip('Squat', 2, [new THREE.NumberKeyframeTrack('Head.position[z]', [0, 1, 2], [0, -.6, 0])])
    const painter = new WeightPainter([cloth, body], n => n); painter.mirror = false
    painter.begin({ bounded: true, preserveSurface: true, deferClip: true, animation: { root, clip } })
    painter.add(0, new Map([[0, 1], [1, 1], [2, 1]]), 1, 1)
    let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve })
    const checking = painter.endAsync(async () => await pause)
    expect(painter.weights(0, 0).get(1)).toBe(1)
    expect(() => painter.edits()).toThrow('finish its check')
    expect(() => painter.begin()).toThrow('Wait for the stroke check')
    release(); expect(await checking).toBe(true)
    expect(painter.edits()).toHaveLength(3)
    head.position.z = -.6; root.updateMatrixWorld(true)
    for (const p of [0, 1, 2]) expect(cloth.getVertexPosition(p, new THREE.Vector3()).z).toBeGreaterThan(.3)
    expect(painter.stepBack()).toBe(true)
  })

  it('cancels an asynchronous check without letting its late result change a newer stroke', async () => {
    const { root, cloth, body, clip } = layeredRig()
    const painter = new WeightPainter([body, cloth], n => n); painter.mirror = false
    const points = new Map(Array.from({ length: 9 }, (_, p) => [p, 1]))
    painter.begin({ bounded: true, preserveSurface: true, deferClip: true, animation: { root, clip } }); painter.add(1, points, 1, .2)
    let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve })
    const checking = painter.endAsync(async () => await pause)
    expect(painter.stepBack()).toBe(true)
    painter.begin({ bounded: true }); painter.add(1, points, 1, .1); painter.end()
    const beforeLateReply = cloth.geometry.attributes.skinWeight.array.slice()
    release(); expect(await checking).toBe(false)
    expect(cloth.geometry.attributes.skinWeight.array).toEqual(beforeLateReply)
    expect(painter.stepBack()).toBe(true)
    expect(painter.weights(1, 4)).toEqual(new Map([[0, 1]]))
    expect(painter.stepBack()).toBe(false)
  })

  it('restores the failed asynchronous stroke while retaining earlier painting', async () => {
    const { root, cloth, body, clip } = layeredRig()
    const painter = new WeightPainter([body, cloth], n => n); painter.mirror = false
    const points = new Map(Array.from({ length: 9 }, (_, p) => [p, 1]))
    painter.begin({ bounded: true }); painter.add(1, points, 1, .1); painter.end()
    const earlier = cloth.geometry.attributes.skinWeight.array.slice()
    painter.begin({ bounded: true, preserveSurface: true, deferClip: true, animation: { root, clip } }); painter.add(1, points, 1, .2)
    await expect(painter.endAsync(async () => { throw new Error('scheduler failed') })).rejects.toThrow('scheduler failed')
    expect(cloth.geometry.attributes.skinWeight.array).toEqual(earlier)
    expect(painter.edits()).toHaveLength(9)
    expect(painter.stepBack()).toBe(true)
    expect(painter.stepBack()).toBe(false)
  })

  it('exempts only the existing pair and checks later proposal positions afresh', () => {
    const before = [new THREE.Vector3(-1, 0, .6), new THREE.Vector3(1, 0, .6), new THREE.Vector3(0, 1, .6),
      new THREE.Vector3(0, -.5, -.3), new THREE.Vector3(0, 1.5, -.3), new THREE.Vector3(0, .5, .3)]
    const contacts = new SurfaceContacts([[0, 1, 2], [3, 4, 5]])
    const now = before.map(v => v.clone()); const active = new Set([0, 1, 2])
    expect(contacts.newContacts(active, p => now[p], p => before[p], true).size).toBe(0)
    for (const p of active) now[p].z = 0
    expect([...contacts.newContacts(active, p => now[p], p => before[p], true)].sort()).toEqual([0, 1, 2])
    for (const p of active) now[p].z = .45
    expect(contacts.newContacts(active, p => now[p], p => before[p], false).size).toBe(0)
  })

  it('shares immutable topology while keeping pose bounds and baseline exemptions independent', () => {
    const before = [new THREE.Vector3(-1, 0, .6), new THREE.Vector3(1, 0, .6), new THREE.Vector3(0, 1, .6),
      new THREE.Vector3(0, -.5, -.3), new THREE.Vector3(0, 1.5, -.3), new THREE.Vector3(0, .5, .3)]
    const active = new Set([0, 1, 2]); const first = new SurfaceContacts([[0, 1, 2], [3, 4, 5]])
    const second = new SurfaceContacts(first)
    const after = before.map(v => v.clone()); for (const p of active) after[p].z = 0
    expect(first.newContacts(active, p => after[p], p => before[p], true)).toEqual(active)
    const far = after.map(v => v.clone().addScalar(100))
    expect(second.newContacts(active, p => far[p], p => far[p], true).size).toBe(0)
    expect(first.newContacts(active, p => after[p], p => before[p], false)).toEqual(active)
  })

  it('refreshes unchanged points when an earlier limit postpones a new proposal contact check', () => {
    const before = [new THREE.Vector3(-1, 0, .6), new THREE.Vector3(1, 0, .6), new THREE.Vector3(0, 1, .6),
      new THREE.Vector3(100, -.5, -.3), new THREE.Vector3(100, 1.5, -.3), new THREE.Vector3(100, .5, .3)]
    const active = new Set([0, 1, 2]); const contacts = new SurfaceContacts([[0, 1, 2], [3, 4, 5]])
    expect(contacts.newContacts(active, p => before[p], p => before[p], true).size).toBe(0)
    const after = before.map(v => v.clone())
    for (const p of active) after[p].z = 0
    for (const p of [3, 4, 5]) after[p].x = 0
    expect(contacts.newContacts(active, p => after[p], p => before[p], true, active).size).toBe(0)
    expect(contacts.newContacts(active, p => after[p], p => before[p], false)).toEqual(active)
  })

  it.each([1e-5, 1, 1e5])('does not cull a double-precision contact after float32 bounds refit (scale=%s)', scale => {
    const z = 1.00000008 * scale
    const before = [new THREE.Vector3(-1, -1, 2 * scale), new THREE.Vector3(1, -1, 2 * scale), new THREE.Vector3(0, 1, 2 * scale),
      new THREE.Vector3(-.2, -.2, z), new THREE.Vector3(.2, -.2, z), new THREE.Vector3(0, .2, z)]
    const faces: Array<[number, number, number]> = [[0, 1, 2], [3, 4, 5]]
    for (let i = 0; i < 30; i++) {
      const p = before.length; const x = 10 + i * 3
      before.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x + 1, 0, z), new THREE.Vector3(x, 1, z))
      faces.push([p, p + 1, p + 2])
    }
    const active = new Set([0, 1, 2]); const contacts = new SurfaceContacts(faces)
    expect(contacts.newContacts(active, p => before[p], p => before[p], true).size).toBe(0)
    const now = before.map(v => v.clone()); for (const p of active) now[p].z = z
    expect(contacts.newContacts(active, p => now[p], p => before[p], false)).toEqual(active)
    expect(new SurfaceContacts(contacts).newContacts(active, p => now[p], p => before[p], true)).toEqual(active)
  })

  it.each([
    { name: 'collinear', a: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], shift: [0, 1, 0], apart: 10 },
    { name: 'underflowed normal', a: [[0, 0, 0], [1, 1e-200, 0], [2, 0, 0]], shift: [0, 1, 0], apart: 10 },
    { name: 'overflowed normal', a: [[0, 0, 0], [1e78, 0, 0], [0, 1e78, 0]], shift: [0, 0, 1e78], apart: 1e79 },
  ])('retains conservative predicate results for $name triangles', ({ a, shift, apart }) => {
    const after = [...a.map(p => new THREE.Vector3(...p)), ...a.map(p => new THREE.Vector3(...p).add(new THREE.Vector3(...shift)))]
    const before = after.map(p => p.clone()); for (const p of [3, 4, 5]) before[p].x += apart
    const active = new Set([0, 1, 2]); const contacts = new SurfaceContacts([[0, 1, 2], [3, 4, 5]])
    expect(contacts.newContacts(active, p => after[p], p => before[p], true)).toEqual(active)
  })

  it('excludes physical seam neighbours without welding a separate coincident point', () => {
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(.2, .2, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(-1, 0, 0)]
    const before = points.map(v => v.clone())
    for (const p of [3, 4, 5]) before[p].z = 1
    const faces: Array<[number, number, number]> = [[0, 1, 2], [4, 5, 3]]
    const active = new Set([3, 4, 5])
    expect(new SurfaceContacts(faces).newContacts(active, p => points[p], p => before[p], true)).toEqual(active)
    // Addresses, not posed coincidences, define attachment exemptions. No baseline contact is needed to skip a
    // physical alias duplicated by a material primitive.
    expect(new SurfaceContacts(faces, p => p === 4 ? 0 : p).newContacts(active, p => points[p], () => {
      throw new Error('Physical seam pair should be excluded before baseline lookup')
    }, true).size).toBe(0)
  })
})
