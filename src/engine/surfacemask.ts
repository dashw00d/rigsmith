// A mask painted on the model itself, for projection painting: one value per texel of the color texture's layout
// (at most 2048 on a side), so it stays on the surface whatever the camera does, and the views to repaint it from
// can be found afterwards (planViews).
//
// Brushes work on the body as it stands: from the point under the cursor out over the surface (not through the air
// to a sleeve or a cloak close by), the texels of each triangle reached weighed by their distance from it. The smart
// brush keeps only texels near the colour where the stroke began; the wand takes every triangle of that colour joined
// to the one clicked (or, not joined, all of them).
//
// Mask rows follow the texture coordinates (row r is v = (r + 0.5) / height): drawn on the model with flipY off.
import * as THREE from 'three'
import { colorDistance, morph } from './selection.ts'

interface Part {
  mesh: THREE.Mesh
  index: Uint32Array
  uv: Float32Array
  /** rest positions in world space (the bind pose: what the captures and the bake see) */
  rest: Float32Array
  /** vertex -> its point (the first vertex at that position): seams are one point */
  point: Int32Array
  adj: Array<number[] | undefined>
  /** point -> triangles touching it */
  trisOf: Array<number[] | undefined>
  /** triangle -> triangles sharing an edge with it (across seams) */
  triAdj: number[][]
}

export type Value = 0 | 1

const MAX = 2048

export class SurfaceMask {
  readonly width: number
  readonly height: number
  /** 0..255 per texel */
  readonly data: Uint8Array
  /** texels some triangle covers */
  readonly covered: Uint8Array
  /** the mask for drawing (RGBA, every channel the value) */
  readonly texture: THREE.DataTexture
  private readonly rgba: Uint8Array
  /** the texture's colours at the mask's size, rows as the mask's */
  private readonly colors: Uint8ClampedArray
  readonly parts: Part[] = []
  private overlays: THREE.Mesh[] = []
  version = 0

  constructor (texture: THREE.Texture, meshes: THREE.Mesh[]) {
    const image = texture.image as HTMLImageElement | ImageBitmap | HTMLCanvasElement
    const scale = Math.min(1, MAX / Math.max(image.width, image.height))
    this.width = Math.max(1, Math.round(image.width * scale))
    this.height = Math.max(1, Math.round(image.height * scale))
    this.data = new Uint8Array(this.width * this.height)
    this.covered = new Uint8Array(this.width * this.height)
    this.rgba = new Uint8Array(this.width * this.height * 4)
    this.texture = new THREE.DataTexture(this.rgba, this.width, this.height, THREE.RGBAFormat)
    this.texture.flipY = false
    this.texture.magFilter = THREE.LinearFilter
    this.texture.minFilter = THREE.LinearFilter
    this.texture.needsUpdate = true
    // the colours, in mask rows (a flipped texture's image runs the other way)
    const canvas = document.createElement('canvas')
    canvas.width = this.width; canvas.height = this.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    if (texture.flipY) { ctx.translate(0, this.height); ctx.scale(1, -1) }
    ctx.drawImage(image, 0, 0, this.width, this.height)
    this.colors = ctx.getImageData(0, 0, this.width, this.height).data
    for (const mesh of meshes) this.parts.push(partOf(mesh))
    for (let p = 0; p < this.parts.length; p++) {
      const { index } = this.parts[p]
      for (let t = 0; t < index.length / 3; t++) this.raster(p, t, (i) => { this.covered[i] = 1 })
    }
  }

  get any (): boolean { return this.data.some(v => v >= 128) }

  // ---- drawing on the model ---------------------------------------------------------------------

  /** Show the mask on the model (a tinted layer over the meshes), or take it off. */
  show (on: boolean): void {
    for (const o of this.overlays) o.removeFromParent()
    this.overlays = []
    if (!on) return
    const material = new THREE.MeshBasicMaterial({
      color: 0x7f9bff, transparent: true, opacity: 0.6, alphaMap: this.texture, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    })
    for (const { mesh } of this.parts) {
      let overlay: THREE.Mesh
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
        const skinned = mesh as THREE.SkinnedMesh
        const s = new THREE.SkinnedMesh(skinned.geometry, material)
        s.bindMode = skinned.bindMode
        s.bind(skinned.skeleton, skinned.bindMatrix)
        overlay = s
      } else overlay = new THREE.Mesh(mesh.geometry, material)
      overlay.position.copy(mesh.position); overlay.quaternion.copy(mesh.quaternion); overlay.scale.copy(mesh.scale)
      overlay.frustumCulled = false
      overlay.renderOrder = 5
      overlay.userData.maskOverlay = true
      mesh.parent?.add(overlay)
      this.overlays.push(overlay)
    }
  }

  /** The mask changed: the drawn layer follows. */
  private changed (): void {
    const { data, rgba } = this
    for (let i = 0; i < data.length; i++) { const v = data[i]; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255 }
    this.texture.needsUpdate = true
    this.version++
  }

  // ---- tools ------------------------------------------------------------------------------------

  /** A brush dab at a point on a mesh's surface as it stands (its triangle `face`), `radius` in world units. With
   * `reference` (smart) only texels within `tolerance` of that colour change. */
  dab (meshIndex: number, face: number, at: THREE.Vector3, radius: number, value: Value, reference?: [number, number, number], tolerance = 0.35): void {
    const part = this.parts[meshIndex]
    if (part === undefined) return
    const posed = posedPoints(part)
    // over the surface from the hit triangle: the points within reach (a little past the brush, so a triangle the
    // brush only grazes is still drawn)
    const reach = radius * 1.5
    const dist = new Map<number, number>()
    const heap: Array<[number, number]> = []
    const push = (p: number, d: number): void => {
      if (d >= reach || d >= (dist.get(p) ?? Infinity)) return
      dist.set(p, d); heap.push([p, d])
    }
    for (let k = 0; k < 3; k++) { const p = part.point[part.index[face * 3 + k]]; push(p, posed.get(p)!.distanceTo(at)) }
    while (heap.length > 0) {
      let best = 0
      for (let i = 1; i < heap.length; i++) if (heap[i][1] < heap[best][1]) best = i
      const [p, d] = heap[best]; heap[best] = heap[heap.length - 1]; heap.pop()
      if (d !== dist.get(p)) continue
      for (const q of part.adj[p] ?? []) push(q, d + posed.get(p)!.distanceTo(posed.get(q)!))
    }
    const tris = new Set<number>([face])
    for (const p of dist.keys()) for (const t of part.trisOf[p] ?? []) tris.add(t)
    const limit = 0.04 + tolerance * 0.5
    const corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    const x = new THREE.Vector3()
    for (const t of tris) {
      for (let k = 0; k < 3; k++) corner[k].copy(posed.get(part.point[part.index[t * 3 + k]])!)
      this.raster(this.parts.indexOf(part), t, (i, a, b, c) => {
        if (reference !== undefined && colorDistance(this.colors, i * 4, reference[0], reference[1], reference[2]) > limit) return
        x.set(0, 0, 0).addScaledVector(corner[0], a).addScaledVector(corner[1], b).addScaledVector(corner[2], c)
        const f = 1 - THREE.MathUtils.smoothstep(x.distanceTo(at), radius * 0.75, radius)
        if (f <= 0) return
        const v = Math.round(f * 255)
        this.data[i] = value === 1 ? Math.max(this.data[i], v) : Math.min(this.data[i], 255 - v)
      })
    }
    this.changed()
  }

  /** The texture's colour at texture coordinates (a hit's uv), as the smart brush's and the wand's reference. */
  colorAt (uv: THREE.Vector2): [number, number, number] {
    const i = this.texel(uv.x, uv.y)
    return [this.colors[i * 4], this.colors[i * 4 + 1], this.colors[i * 4 + 2]]
  }

  /** The wand: every triangle near the clicked colour joined to the clicked one (or anywhere, not `contiguous`), its
   * texels of that colour. */
  wand (meshIndex: number, face: number, reference: [number, number, number], mode: 'replace' | 'add' | 'subtract', tolerance: number, contiguous: boolean): void {
    const limit = 0.04 + tolerance * 0.5
    if (mode === 'replace') this.data.fill(0)
    const near = (p: number, t: number): boolean => {
      // (a triangle counts when its middle or any corner is that colour)
      const part = this.parts[p]
      const samples: Array<[number, number]> = []
      let cu = 0; let cv = 0
      for (let k = 0; k < 3; k++) { const i = part.index[t * 3 + k]; samples.push([part.uv[i * 2], part.uv[i * 2 + 1]]); cu += part.uv[i * 2] / 3; cv += part.uv[i * 2 + 1] / 3 }
      samples.push([cu, cv])
      return samples.some(([u, v]) => { const i = this.texel(u, v); return colorDistance(this.colors, i * 4, reference[0], reference[1], reference[2]) <= limit })
    }
    const take = (p: number, t: number): void => {
      this.raster(p, t, (i) => {
        if (colorDistance(this.colors, i * 4, reference[0], reference[1], reference[2]) > limit) return
        this.data[i] = mode === 'subtract' ? 0 : 255
      })
    }
    if (contiguous) {
      const part = this.parts[meshIndex]
      const seen = new Set<number>([face])
      const queue = [face]
      for (let i = 0; i < queue.length; i++) {
        const t = queue[i]
        take(meshIndex, t)
        for (const n of part.triAdj[t]) if (!seen.has(n)) { seen.add(n); if (near(meshIndex, n)) queue.push(n) }
      }
    } else {
      this.parts.forEach((part, p) => { for (let t = 0; t < part.index.length / 3; t++) if (near(p, t)) take(p, t) })
    }
    this.changed()
  }

  /** Grow (> 0) or shrink (< 0) the mask by texels, over the texture's layout. */
  grow (texels: number): void {
    const binary = Uint8Array.from(this.data, v => (v >= 128 ? 1 : 0))
    const out = morph(binary, this.width, this.height, texels)
    for (let i = 0; i < out.length; i++) this.data[i] = out[i] === 1 && this.covered[i] === 1 ? 255 : 0
    this.changed()
  }

  invert (): void {
    for (let i = 0; i < this.data.length; i++) this.data[i] = this.covered[i] === 1 ? 255 - this.data[i] : 0
    this.changed()
  }

  clear (): void { this.data.fill(0); this.changed() }

  /** Set from a saved mask image (a capture's uvmask.png), any size. */
  load (image: HTMLImageElement | HTMLCanvasElement | ImageBitmap): void {
    const canvas = document.createElement('canvas')
    canvas.width = this.width; canvas.height = this.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(image, 0, 0, this.width, this.height)
    const px = ctx.getImageData(0, 0, this.width, this.height).data
    for (let i = 0; i < this.data.length; i++) this.data[i] = px[i * 4]
    this.changed()
  }

  /** The padded mask (below) as a texture laid as this one is: what a view's mask is drawn from, so no seam of the
   * surface shows in it as a line left unpainted. */
  paddedTexture (): THREE.DataTexture {
    const px = this.padded().getContext('2d')!.getImageData(0, 0, this.width, this.height).data
    const texture = new THREE.DataTexture(new Uint8Array(px), this.width, this.height, THREE.RGBAFormat)
    texture.flipY = false
    texture.magFilter = THREE.LinearFilter
    texture.minFilter = THREE.LinearFilter
    texture.needsUpdate = true
    return texture
  }

  /** The mask as an image (rows as the mask's), spread a few texels past each island's edge so sampling it at a
   * texture's own size never fades at a seam. */
  padded (): HTMLCanvasElement {
    const { width: w, height: h } = this
    let current = Uint8Array.from(this.data)
    let filled = Uint8Array.from(this.covered)
    for (let step = 0; step < 3; step++) {
      const next = current.slice(); const nextFilled = filled.slice()
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x
          if (filled[p] === 1) continue
          let best = -1
          for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && filled[q] === 1) best = Math.max(best, current[q])
          if (best >= 0) { next[p] = best; nextFilled[p] = 1 }
        }
      }
      current = next; filled = nextFilled
    }
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')!
    const image = ctx.createImageData(w, h)
    for (let i = 0; i < current.length; i++) { image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = current[i]; image.data[i * 4 + 3] = 255 }
    ctx.putImageData(image, 0, 0)
    return canvas
  }

  dispose (): void {
    this.show(false)
    this.texture.dispose()
  }

  // ---- texels -----------------------------------------------------------------------------------

  private texel (u: number, v: number): number {
    const x = THREE.MathUtils.clamp(Math.floor(u * this.width), 0, this.width - 1)
    const y = THREE.MathUtils.clamp(Math.floor(v * this.height), 0, this.height - 1)
    return y * this.width + x
  }

  /** Each texel whose centre a triangle covers in the texture's layout, with its barycentric weights. */
  raster (part: number, t: number, each: (i: number, a: number, b: number, c: number) => void): void {
    const { index, uv } = this.parts[part]
    const W = this.width; const H = this.height
    const ia = index[t * 3]; const ib = index[t * 3 + 1]; const ic = index[t * 3 + 2]
    const ax = uv[ia * 2] * W; const ay = uv[ia * 2 + 1] * H
    const bx = uv[ib * 2] * W; const by = uv[ib * 2 + 1] * H
    const cx = uv[ic * 2] * W; const cy = uv[ic * 2 + 1] * H
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    if (Math.abs(area) < 1e-12) return
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))); const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)))
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))); const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)))
    const eps = -1e-6
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5
        const wa = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area
        const wb = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area
        const wc = 1 - wa - wb
        if (wa < eps || wb < eps || wc < eps) continue
        each(y * W + x, wa, wb, wc)
      }
    }
  }

  // ---- views ------------------------------------------------------------------------------------

  /** The masked surface as samples at rest (world space): where and which way each faces. At most `limit`. */
  samples (limit = 4000): Array<{ at: THREE.Vector3, normal: THREE.Vector3 }> {
    let masked = 0
    for (let i = 0; i < this.data.length; i++) if (this.data[i] >= 128 && this.covered[i] === 1) masked++
    const every = Math.max(1, Math.ceil(masked / limit))
    const out: Array<{ at: THREE.Vector3, normal: THREE.Vector3 }> = []
    let n = 0
    const seen = new Uint8Array(this.data.length)
    this.parts.forEach((part, p) => {
      const corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
      for (let t = 0; t < part.index.length / 3; t++) {
        for (let k = 0; k < 3; k++) corner[k].fromArray(part.rest, part.index[t * 3 + k] * 3)
        const normal = corner[1].clone().sub(corner[0]).cross(corner[2].clone().sub(corner[0])).normalize()
        this.raster(p, t, (i, a, b, c) => {
          if (this.data[i] < 128 || seen[i] === 1) return
          seen[i] = 1
          if (n++ % every !== 0) return
          out.push({ at: new THREE.Vector3().addScaledVector(corner[0], a).addScaledVector(corner[1], b).addScaledVector(corner[2], c), normal })
        })
      }
    })
    return out
  }
}

/** A mesh's triangles, texture coordinates, rest shape and connections. */
function partOf (mesh: THREE.Mesh): Part {
  const g = mesh.geometry
  const pos = g.attributes.position
  const uvAttr = g.attributes.uv
  if (uvAttr === undefined) throw new Error('This model has no texture coordinates to paint on')
  const count = pos.count
  const index = g.index !== null ? Uint32Array.from(g.index.array as ArrayLike<number>) : Uint32Array.from({ length: count }, (_, i) => i)
  const uv = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) { uv[i * 2] = uvAttr.getX(i); uv[i * 2 + 1] = uvAttr.getY(i) }
  // at rest, in world space: as the bake places it (skinned: the bind matrix; others: their transform)
  mesh.updateMatrixWorld(true)
  const toWorld = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh).bindMatrix : mesh.matrixWorld
  const rest = new Float32Array(count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < count; i++) v.fromBufferAttribute(pos, i).applyMatrix4(toWorld).toArray(rest, i * 3)
  const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute)
  const tol = 1e-5 * Math.max(box.getSize(new THREE.Vector3()).length(), 1e-6)
  const point = new Int32Array(count)
  const keys = new Map<string, number>()
  for (let i = 0; i < count; i++) {
    const k = `${Math.round(pos.getX(i) / tol)},${Math.round(pos.getY(i) / tol)},${Math.round(pos.getZ(i) / tol)}`
    const at = keys.get(k)
    if (at === undefined) { keys.set(k, i); point[i] = i } else point[i] = at
  }
  const adj: Array<number[] | undefined> = []
  const trisOf: Array<number[] | undefined> = []
  const edges = new Map<string, number[]>()
  const link = (a: number, b: number): void => { if (a !== b && !(adj[a] ??= []).includes(b)) { adj[a]!.push(b); (adj[b] ??= []).push(a) } }
  const tris = index.length / 3
  for (let t = 0; t < tris; t++) {
    const p = [point[index[t * 3]], point[index[t * 3 + 1]], point[index[t * 3 + 2]]]
    for (let k = 0; k < 3; k++) {
      (trisOf[p[k]] ??= []).push(t)
      const a = p[k]; const b = p[(k + 1) % 3]
      link(a, b)
      const key = a < b ? `${a},${b}` : `${b},${a}`
      ;(edges.get(key) ?? edges.set(key, []).get(key)!).push(t)
    }
  }
  const triAdj: number[][] = Array.from({ length: tris }, () => [])
  for (const ts of edges.values()) for (const a of ts) for (const b of ts) if (a !== b) triAdj[a].push(b)
  return { mesh, index, uv, rest, point, adj, trisOf, triAdj }
}

/** Where each point of a mesh is now (posed, world space). */
function posedPoints (part: Part): Map<number, THREE.Vector3> {
  const { mesh, point } = part
  mesh.updateMatrixWorld(true)
  const out = new Map<number, THREE.Vector3>()
  const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh
  const pos = mesh.geometry.attributes.position
  for (let i = 0; i < point.length; i++) {
    if (point[i] !== i) continue
    const v = skinned ? (mesh as THREE.SkinnedMesh).getVertexPosition(i, new THREE.Vector3()) : new THREE.Vector3().fromBufferAttribute(pos, i)
    out.set(i, v.applyMatrix4(mesh.matrixWorld))
  }
  return out
}
