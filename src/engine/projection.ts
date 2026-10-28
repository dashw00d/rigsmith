// Projection painting: find the views that see a masked part of the surface, capture what each sees (for an image
// generator to repaint), then project the repainted views back into the texture's layout as a decal: colour, and alpha
// how much it covers. The decal is a look layer (server/routes/look.ts lays it over the texture); a preview lays it
// over the texture here (layOver).
//
// Planning and baking use the bind pose (where the texture's surface is at rest), so a capture must be taken of the
// character at rest too (the painter stops playback first).
import * as THREE from 'three'
import type { CharacterView } from './CharacterView.ts'
import type { Stage } from './Stage.ts'

export interface ProjectionCamera {
  width: number
  height: number
  projection: number[]
  view: number[]
  position: [number, number, number]
  near: number
  far: number
}

type Picture = HTMLImageElement | ImageBitmap | HTMLCanvasElement

/** The texture painted on (first mesh with a color map) and the meshes that use it. */
export function paintTarget (view: CharacterView): { texture: THREE.Texture, meshes: THREE.Mesh[] } | null {
  for (const mesh of view.meshes) {
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial
    const map = material?.map
    if (map !== null && map !== undefined) {
      const meshes = view.meshes.filter(m => {
        const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial
        return mat?.map === map
      })
      return { texture: map, meshes }
    }
  }
  return null
}

// (Blender's bpy.path.clean_name keeps ASCII letters, digits, _ and -, U+00FF and everything above it)
const kept = (c: number): boolean =>
  c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c >= 0xff

/** An image's clean name, Blender's bpy.path.clean_name exactly: what a look layer names its image by. The server's
 * copy is server/glbimages.ts cleanImageName; a test holds the two to the same names. */
export function cleanName (name: string): string {
  let out = ''
  for (const ch of name) out += kept(ch.codePointAt(0)!) ? ch : '_'
  return out
}

// ---- pixels -----------------------------------------------------------------------------------------------------

/** Rows bottom-up (as GL reads them) made top-down (as images go), or back. */
export function flipRows<T extends Uint8Array | Uint8ClampedArray | Float32Array> (pixels: T, width: number, height: number, channels = 4): T {
  const out = new (pixels.constructor as new (n: number) => T)(pixels.length)
  const row = width * channels
  for (let y = 0; y < height; y++) out.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row)
  return out
}

/** RGBA pixels (rows top-down) as a canvas. */
export function canvasOf (pixels: Uint8ClampedArray | Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(width, height)
  image.data.set(pixels)
  ctx.putImageData(image, 0, 0)
  return canvas
}

export async function pngOf (canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise((resolve, reject) => {
    canvas.toBlob(b => { if (b === null) reject(new Error('Could not make a PNG')); else resolve(b) }, 'image/png')
  })
}

/** Images and bitmaps as canvases, so WebGL honors flipY on upload. */
function toCanvas (image: Picture): HTMLCanvasElement {
  if (image instanceof HTMLCanvasElement) return image
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return canvas
}

function readPixels (renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): Uint8ClampedArray {
  const { width, height } = target
  const pixels = new Uint8ClampedArray(width * height * 4)
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
  return flipRows(pixels, width, height)
}

/** `decals` (canvases in the texture's layout) laid over `base` in order, by their alpha: what the look's compose job
 * makes of them, for a preview. */
export function layOver (base: Picture, decals: HTMLCanvasElement[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = base.width
  canvas.height = base.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(base, 0, 0)
  for (const d of decals) ctx.drawImage(d, 0, 0, base.width, base.height)
  return canvas
}

// ---- capture ----------------------------------------------------------------------------------------------------

export type Pass = 'color' | 'flat' | 'mask'

/** Render passes of just the character from the current camera (or `options.camera`) at an exact size (rows
 * top-down). The mask pass draws `options.mask` (a texture-layout mask) as the camera sees it, white where masked. */
export function renderPasses (stage: Stage, view: CharacterView, width: number, height: number, which: Pass[], options: { camera?: THREE.PerspectiveCamera, mask?: THREE.Texture } = {}): { camera: ProjectionCamera, pixels: Partial<Record<Pass, Uint8ClampedArray>> } {
  const renderer = stage.renderer
  const previousTarget = renderer.getRenderTarget()
  const previousClear = renderer.getClearAlpha()
  const scene = new THREE.Scene()
  scene.environment = stage.scene.environment
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.4))
  const key = new THREE.DirectionalLight(0xffffff, 1.6)
  key.position.copy((options.camera ?? stage.camera).position).add(new THREE.Vector3(0.5, 1, 0.3))
  scene.add(key)
  const parent = view.root.parent
  scene.add(view.root)
  // (the mask's tinted layer on the model is not part of what is captured)
  const overlays: THREE.Object3D[] = []
  view.root.traverse(o => { if (o.userData.maskOverlay === true && o.visible) overlays.push(o) })
  for (const o of overlays) o.visible = false
  const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true })
  target.texture.colorSpace = THREE.SRGBColorSpace
  const linearTarget = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true })
  const pixels: Partial<Record<Pass, Uint8ClampedArray>> = {}
  const swap = (make: (m: THREE.Mesh) => THREE.Material | null): Map<THREE.Mesh, THREE.Material | THREE.Material[]> => {
    const saved = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
    view.root.traverse(o => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || mesh.userData.maskOverlay === true) return
      saved.set(mesh, mesh.material)
      const replacement = make(mesh)
      if (replacement !== null) mesh.material = replacement
    })
    return saved
  }
  const restore = (saved: Map<THREE.Mesh, THREE.Material | THREE.Material[]>): void => {
    for (const [m, mat] of saved) {
      // (the pass's own material goes with it; the textures it drew are the model's and stay)
      if (m.material !== mat && !Array.isArray(m.material)) m.material.dispose()
      m.material = mat
    }
  }
  const camera = (options.camera ?? stage.camera).clone()
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  const pass = (name: Pass, into: THREE.WebGLRenderTarget, material: ((m: THREE.Mesh) => THREE.Material) | null): void => {
    if (!which.includes(name)) return
    const saved = material === null ? null : swap(material)
    renderer.setRenderTarget(into)
    renderer.clear()
    renderer.render(scene, camera)
    pixels[name] = readPixels(renderer, into)
    if (saved !== null) restore(saved)
  }
  try {
    renderer.setClearAlpha(0)
    pass('color', target, null)
    pass('flat', target, m => {
      const source = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial
      return new THREE.MeshBasicMaterial({ map: source.map ?? null, color: source.map !== null && source.map !== undefined ? 0xffffff : source.color })
    })
    if (options.mask !== undefined) {
      const mask = options.mask
      pass('mask', linearTarget, () => new THREE.MeshBasicMaterial({ map: mask, side: THREE.DoubleSide }))
    }
    return {
      camera: {
        width, height,
        projection: camera.projectionMatrix.toArray(),
        view: camera.matrixWorldInverse.toArray(),
        position: camera.position.toArray() as [number, number, number],
        near: camera.near, far: camera.far,
      },
      pixels,
    }
  } finally {
    for (const o of overlays) o.visible = true
    parent?.add(view.root)
    renderer.setRenderTarget(previousTarget)
    renderer.setClearAlpha(previousClear)
    target.dispose()
    linearTarget.dispose()
  }
}

/** A grey mask (RGBA, grey in R) closed: gaps up to 2·`r` pixels wide filled (a max then a min over a square, each
 * done along rows then columns), the mask's edges where they were. */
export function closeGaps (px: Uint8ClampedArray, width: number, height: number, r: number): void {
  const grey = new Uint8Array(width * height)
  for (let i = 0; i < grey.length; i++) grey[i] = px[i * 4]
  const pass = (src: Uint8Array, take: (a: number, b: number) => number, along: 'row' | 'col'): Uint8Array => {
    const out = new Uint8Array(src.length)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = src[y * width + x]
        for (let k = -r; k <= r; k++) {
          const xx = along === 'row' ? x + k : x; const yy = along === 'col' ? y + k : y
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
          v = take(v, src[yy * width + xx])
        }
        out[y * width + x] = v
      }
    }
    return out
  }
  const grown = pass(pass(grey, Math.max, 'row'), Math.max, 'col')
  const closed = pass(pass(grown, Math.min, 'row'), Math.min, 'col')
  for (let i = 0; i < closed.length; i++) px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = closed[i]
}

/** The character from `camera`, `size` square: lit and flat (the texture unlit) as PNGs, and `mask` as the camera
 * sees it (white to repaint, over black) as a PNG and as pixels. */
export async function captureFrom (stage: Stage, view: CharacterView, camera: THREE.PerspectiveCamera, mask: THREE.Texture, size = 1024): Promise<{ camera: ProjectionCamera, color: Blob, flat: Blob, mask: Blob, maskPixels: Uint8ClampedArray }> {
  const { camera: cam, pixels } = renderPasses(stage, view, size, size, ['color', 'flat', 'mask'], { camera, mask })
  const m = pixels.mask!
  for (let i = 0; i < m.length; i += 4) { const v = m[i + 3] > 0 ? m[i] : 0; m[i] = m[i + 1] = m[i + 2] = v; m[i + 3] = 255 }
  // (hairline cracks between the mesh's triangles show the background through: closed, else each is a line of the
  // surface either side left unpainted)
  closeGaps(m, size, size, 2)
  return {
    camera: cam,
    color: await pngOf(canvasOf(pixels.color!, size, size)),
    flat: await pngOf(canvasOf(pixels.flat!, size, size)),
    mask: await pngOf(canvasOf(m, size, size)),
    maskPixels: m,
  }
}

// ---- planning -----------------------------------------------------------------------------------------------------

/** Bind-pose geometry in world space (skinned meshes: the bind matrix; others: their transform). */
function restGeometry (mesh: THREE.Mesh): THREE.BufferGeometry {
  const g = mesh.geometry.clone()
  g.applyMatrix4((mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh).bindMatrix : mesh.matrixWorld)
  return g
}

// (depth as NDC z in red; read texel for texel: not every GPU filters float textures, and one it can't reads as zero)
const depthVertex = 'uniform mat4 projView; varying float vZ; void main() { vec4 c = projView * modelMatrix * vec4(position, 1.0); vZ = c.z / c.w; gl_Position = c; }'
const depthFragment = 'varying float vZ; void main() { gl_FragColor = vec4(vZ, 0.0, 0.0, 1.0); }'
const floatTarget = (width: number, height: number, type: THREE.TextureDataType = THREE.FloatType): THREE.WebGLRenderTarget =>
  new THREE.WebGLRenderTarget(width, height, { type, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false })

export interface PlannedView { name: string, camera: THREE.PerspectiveCamera, /** share of the masked surface it paints best */ share: number }

/**
 * The views to take, as indices into `quality` (per candidate view, each sample's quality: how squarely it faces that
 * view where nothing hides it, 0 unseen). Greedy: each round the view adding most over the best each sample has so far,
 * capped at what the sample needs (`enough`, or 80% of what the best view could give it), until all but `short` of
 * the samples are there, the next view would add less than `minGain` of the whole, or `most` are taken.
 */
export function chooseViews (quality: ArrayLike<number>[], most = 6, enough = 0.6, short = 0.03, minGain = 0.04): number[] {
  const n = quality[0]?.length ?? 0
  if (n === 0) return []
  const best = new Float32Array(n)
  const reachable = new Float32Array(n)
  for (const q of quality) for (let i = 0; i < n; i++) reachable[i] = Math.max(reachable[i], q[i])
  // (what each sample needs: seen squarely enough, or as well as any view can; better than that adds nothing, so a
  // view only earns its place by covering what the others don't)
  const need = Float32Array.from(reachable, r => Math.min(enough, r * 0.8))
  const chosen: number[] = []
  while (chosen.length < most) {
    let pick = -1; let gain = 0
    quality.forEach((q, d) => {
      if (chosen.includes(d)) return
      let g = 0
      for (let i = 0; i < n; i++) g += Math.max(0, Math.min(q[i], need[i]) - Math.min(best[i], need[i]))
      // (ties go to the squarer view)
      for (let i = 0; i < n; i++) g += 1e-3 * Math.max(0, q[i] - best[i])
      if (g > gain) { gain = g; pick = d }
    })
    // (a view that adds little is not worth another image to keep consistent: spots seen only at a glance, a hood's
    // lining through the face opening, are left to what the other views see of them)
    if (pick < 0 || gain < minGain * n) break
    chosen.push(pick)
    for (let i = 0; i < n; i++) best[i] = Math.max(best[i], quality[pick][i])
    // (done when nearly every sample is seen squarely enough, or as well as any view could)
    let left = 0
    for (let i = 0; i < n; i++) if (reachable[i] > 0 && best[i] < need[i]) left++
    if (left <= short * n) break
  }
  return chosen
}

/** The fewest views (at most `most`) that between them see the masked surface squarely: from 48 directions round
 * it, each sample's quality is how squarely it faces the camera where nothing hides it (1 head-on); chooseViews
 * picks among them, and each view is then framed on the samples it paints best. */
export function planViews (renderer: THREE.WebGLRenderer, view: CharacterView, samples: Array<{ at: THREE.Vector3, normal: THREE.Vector3 }>, fov: number, most = 6, enough = 0.6, short = 0.03, minGain = 0.04): PlannedView[] {
  if (samples.length === 0) return []
  const sphere = new THREE.Sphere().setFromPoints(samples.map(s => s.at))
  sphere.radius = Math.max(sphere.radius, 0.05 * view.height)
  const whole = view.box.getBoundingSphere(new THREE.Sphere())
  const size = 256
  const target = floatTarget(size, size)
  const material = new THREE.ShaderMaterial({ uniforms: { projView: { value: new THREE.Matrix4() } }, vertexShader: depthVertex, fragmentShader: depthFragment, side: THREE.DoubleSide })
  const scene = new THREE.Scene()
  const geometries = view.meshes.map(restGeometry)
  for (const g of geometries) scene.add(new THREE.Mesh(g, material))
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const previous = renderer.getRenderTarget()
  const clearColor = renderer.getClearColor(new THREE.Color()); const clearAlpha = renderer.getClearAlpha()
  const frame = (dir: THREE.Vector3, around: THREE.Sphere): THREE.PerspectiveCamera => {
    const cam = new THREE.PerspectiveCamera(fov, 1, 0.01, 100)
    const distance = around.radius / Math.sin(THREE.MathUtils.degToRad(fov) / 2) * 1.12
    cam.position.copy(around.center).addScaledVector(dir, distance)
    cam.up.set(0, 1, 0)
    if (Math.abs(dir.y) > 0.92) cam.up.set(0, 0, dir.y > 0 ? -1 : 1)
    cam.lookAt(around.center)
    cam.near = Math.max(distance * 0.02, 1e-3)
    cam.far = distance + 2 * whole.radius + whole.center.distanceTo(around.center)
    cam.updateProjectionMatrix(); cam.updateMatrixWorld()
    return cam
  }
  // candidate directions, evenly round the sphere
  const dirs: THREE.Vector3[] = []
  const N = 48
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N; const r = Math.sqrt(1 - y * y); const a = i * Math.PI * (3 - Math.sqrt(5))
    dirs.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r))
  }
  const quality: Float32Array[] = []
  const depth = new Float32Array(size * size * 4)
  const clip = new THREE.Vector4()
  try {
    renderer.setClearColor(0xff0000, 1)   // (nothing there: as far as can be)
    for (const dir of dirs) {
      const cam = frame(dir, sphere)
      const projView = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
      material.uniforms.projView.value = projView
      renderer.setRenderTarget(target); renderer.clear(); renderer.render(scene, ortho)
      renderer.readRenderTargetPixels(target, 0, 0, size, size, depth)
      const q = new Float32Array(samples.length)
      samples.forEach((s, i) => {
        const facing = s.normal.dot(cam.position.clone().sub(s.at).normalize())
        if (facing < 0.15) return
        clip.set(s.at.x, s.at.y, s.at.z, 1).applyMatrix4(projView)
        if (clip.w <= 0) return
        const x = clip.x / clip.w; const y = clip.y / clip.w; const z = clip.z / clip.w
        if (Math.abs(x) > 1 || Math.abs(y) > 1) return
        const px = Math.min(size - 1, Math.floor((x * 0.5 + 0.5) * size)); const py = Math.min(size - 1, Math.floor((y * 0.5 + 0.5) * size))
        // (the nearest surface within a pixel: a sample on an edge may fall in its neighbour's)
        let nearest = Infinity
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const qx = THREE.MathUtils.clamp(px + dx, 0, size - 1); const qy = THREE.MathUtils.clamp(py + dy, 0, size - 1)
          nearest = Math.min(nearest, depth[(qy * size + qx) * 4])
        }
        if (z <= Math.max(nearest, depth[(py * size + px) * 4]) + 0.004) q[i] = facing
      })
      quality.push(q)
    }
  } finally {
    renderer.setRenderTarget(previous)
    renderer.setClearColor(clearColor, clearAlpha)
    target.dispose(); material.dispose()
    for (const g of geometries) g.dispose()
  }
  const chosen = chooseViews(quality, most, enough, short, minGain)
  // each view framed on the samples it paints best
  return chosen.map(d => {
    const own = samples.filter((_, i) => quality[d][i] > 0 && chosen.every(e => quality[e][i] <= quality[d][i]))
    const around = own.length >= 3 ? new THREE.Sphere().setFromPoints(own.map(s => s.at)) : sphere.clone()
    // (whole: what else of this view's masked surface it sees, so the frame holds all it will paint)
    const seen = samples.filter((_, i) => quality[d][i] > 0.3)
    if (seen.length >= 3) around.union(new THREE.Sphere().setFromPoints(seen.map(s => s.at)))
    around.radius = Math.max(around.radius, 0.05 * view.height)
    return { name: viewName(dirs[d]), camera: frame(dirs[d], around), share: own.length / samples.length }
  })
}

/** A view direction in words, from the character's side (it faces +z, its left is +x). */
export function viewName (dir: { x: number, y: number, z: number }): string {
  const up = dir.y > 0.6 ? 'above' : dir.y < -0.6 ? 'below' : ''
  const h = Math.hypot(dir.x, dir.z)
  if (h < 0.3) return up
  const a = THREE.MathUtils.radToDeg(Math.atan2(dir.x, dir.z))
  const names = ['front', 'front-left', 'left', 'back-left', 'back', 'back-right', 'right', 'front-right']
  const side = names[((Math.round(a / 45) % 8) + 8) % 8]
  return up !== '' ? `${up} ${side}` : side
}

// ---- baking -------------------------------------------------------------------------------------------------------

/**
 * Texels outside every UV island (`covered` 0) next to the islands take their neighbours' average, ring by ring out
 * to `rings` texels, so a texture filtered or mipmapped across an island's border blends the new paint, not the old.
 * Colour is averaged by alpha (a clear neighbour has no colour to give), alpha as it is. In place on RGBA `pixels`
 * (any layout, `covered` laid the same).
 */
export function dilateGutters (pixels: Uint8ClampedArray, covered: Uint8Array, width: number, height: number, rings: number): void {
  const known = Uint8Array.from(covered)
  let front: number[] = []
  // (the first ring: uncovered texels touching a covered one)
  for (let i = 0; i < known.length; i++) if (known[i] === 0 && touches(known, i, width, height)) front.push(i)
  for (let ring = 0; ring < rings && front.length > 0; ring++) {
    const values: Array<[number, number, number, number]> = front.map(i => {
      let r = 0; let g = 0; let b = 0; let a = 0
      let n = 0
      neighbours(i, width, height, j => {
        if (known[j] === 0) return
        const w = pixels[j * 4 + 3]
        r += pixels[j * 4] * w; g += pixels[j * 4 + 1] * w; b += pixels[j * 4 + 2] * w; a += w
        n++
      })
      return a === 0 ? [0, 0, 0, 0] : [r / a, g / a, b / a, a / n]
    })
    front.forEach((i, f) => { for (let k = 0; k < 4; k++) pixels[i * 4 + k] = values[f][k] })
    for (const i of front) known[i] = 1
    const next = new Set<number>()
    for (const i of front) neighbours(i, width, height, j => { if (known[j] === 0) next.add(j) })
    front = [...next]
  }
}

function neighbours (i: number, width: number, height: number, each: (j: number) => void): void {
  const x = i % width; const y = (i - x) / width
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy
    if (yy < 0 || yy >= height) continue
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx
      if ((dx === 0 && dy === 0) || xx < 0 || xx >= width) continue
      each(yy * width + xx)
    }
  }
}

function touches (known: Uint8Array, i: number, width: number, height: number): boolean {
  let hit = false
  neighbours(i, width, height, j => { if (known[j] === 1) hit = true })
  return hit
}

/** How far past an island's border the bake's colour reaches: enough for the texture's first few mip levels. */
export const gutterOf = (width: number, height: number): number => Math.max(4, Math.round(Math.max(width, height) / 256))

// The paint target's triangles drawn in texture space (a texel's place in the image), each fragment knowing where it
// is in the world at rest and which way it faces.
const unwrapVertex = `uniform mat4 projView; uniform float flipV;
  varying vec4 vClip; varying vec3 vNormal; varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vClip = projView * world;
    vec2 t = vec2(uv.x, flipV > 0.5 ? uv.y : 1.0 - uv.y);
    gl_Position = vec4(t * 2.0 - 1.0, 0.0, 1.0);
  }`

/**
 * Several views' results projected into the texture's layout together, as a decal the texture's size (rows as its
 * image's): each texel takes the views that see it (inside their mask, facing them, not hidden), weighted toward the
 * one that sees it most squarely; its colour is their blend and its alpha how far `uvMask` (the mask in the texture's
 * layout) says to replace what is there (0 where no view saw it). Past each island's border the colour and alpha run
 * on a few texels (dilateGutters).
 */
export function bakeViews (renderer: THREE.WebGLRenderer, view: CharacterView, views: Array<{ camera: ProjectionCamera, result: Picture, mask: Picture }>, uvMask: HTMLCanvasElement | HTMLImageElement): HTMLCanvasElement {
  const target = paintTarget(view)
  if (target === null) throw new Error('This model has no color texture to paint on')
  const image = target.texture.image as Picture
  const width = image.width
  const height = image.height
  const flipY = target.texture.flipY
  const previous = renderer.getRenderTarget()
  const clearColor = renderer.getClearColor(new THREE.Color())
  const clearAlpha = renderer.getClearAlpha()
  const autoClear = renderer.autoClear
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const allGeometry = view.meshes.map(restGeometry)
  const paintGeometry = target.meshes.map(restGeometry)
  // (each pass adds to the sum: a render must not clear it first)
  renderer.autoClear = false
  const accum = floatTarget(width, height, THREE.HalfFloatType)
  const disposables: Array<{ dispose: () => void }> = [accum, ...allGeometry, ...paintGeometry]
  try {
    renderer.setRenderTarget(accum)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    for (const v of views) {
      const projView = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().fromArray(v.camera.projection), new THREE.Matrix4().fromArray(v.camera.view))
      // depth from this view, to leave texels hidden behind other parts
      const depthTarget = floatTarget(v.camera.width, v.camera.height)
      const depthMaterial = new THREE.ShaderMaterial({ uniforms: { projView: { value: projView } }, vertexShader: depthVertex, fragmentShader: depthFragment, side: THREE.DoubleSide })
      const depthScene = new THREE.Scene()
      for (const g of allGeometry) depthScene.add(new THREE.Mesh(g, depthMaterial))
      renderer.setRenderTarget(depthTarget)
      renderer.setClearColor(0xff0000, 1)
      renderer.clear()
      renderer.render(depthScene, ortho)
      const resultTexture = new THREE.Texture(toCanvas(v.result)); resultTexture.colorSpace = THREE.NoColorSpace; resultTexture.needsUpdate = true
      const maskTexture = new THREE.Texture(toCanvas(v.mask)); maskTexture.needsUpdate = true
      const project = new THREE.ShaderMaterial({
        uniforms: { projView: { value: projView }, camPos: { value: new THREE.Vector3(...v.camera.position) }, resultMap: { value: resultTexture }, maskMap: { value: maskTexture }, depthMap: { value: depthTarget.texture }, flipV: { value: flipY ? 1 : 0 } },
        vertexShader: unwrapVertex,
        fragmentShader: `uniform sampler2D resultMap; uniform sampler2D maskMap; uniform sampler2D depthMap; uniform vec3 camPos;
          varying vec4 vClip; varying vec3 vNormal; varying vec3 vWorld;
          void main() {
            vec3 ndc = vClip.xyz / vClip.w;
            vec2 s = ndc.xy * 0.5 + 0.5;
            if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || vClip.w <= 0.0) discard;
            float facing = dot(normalize(vNormal), normalize(camPos - vWorld));
            if (facing <= 0.05) discard;
            if (ndc.z > texture2D(depthMap, s).r + 0.002) discard;
            vec4 c = texture2D(resultMap, s);
            // (squarer views count far more: a grazing view's paint is stretched)
            float w = texture2D(maskMap, s).r * c.a * facing * facing * facing;
            if (w <= 0.000001) discard;
            gl_FragColor = vec4(c.rgb * w, w);
          }`,
        // (a plain sum: each view's weighted colour and its weight, added as they are)
        transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      })
      const uvScene = new THREE.Scene()
      for (const g of paintGeometry) uvScene.add(new THREE.Mesh(g, project))
      renderer.setRenderTarget(accum)
      renderer.render(uvScene, ortho)
      depthTarget.dispose(); depthMaterial.dispose(); resultTexture.dispose(); maskTexture.dispose(); project.dispose()
    }
    // the decal: the views' blend, and how much of it goes on (mask strength where any view saw the texel)
    const out = new THREE.WebGLRenderTarget(width, height)
    disposables.push(out)
    const mask = new THREE.Texture(toCanvas(uvMask)); mask.flipY = false; mask.needsUpdate = true
    disposables.push(mask)
    const composite = new THREE.ShaderMaterial({
      uniforms: { accum: { value: accum.texture }, uvMask: { value: mask }, flipV: { value: flipY ? 1 : 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D accum; uniform sampler2D uvMask; uniform float flipV; varying vec2 vUv;
        void main() {
          // (this target's rows run up from v = 0; the image's texture coordinates as the model reads them)
          vec2 t = vec2(vUv.x, flipV > 0.5 ? vUv.y : 1.0 - vUv.y);
          vec4 a = texture2D(accum, vUv);
          // (any view that saw it at all paints it: a lining seen only at a slant takes that view's paint rather than
          // keeping its old colour beside the new)
          float k = a.a > 0.0 ? texture2D(uvMask, t).r * clamp(a.a / 0.0005, 0.0, 1.0) : 0.0;
          gl_FragColor = k > 0.0 ? vec4(a.rgb / max(a.a, 1e-5), k) : vec4(0.0);
        }`,
      depthTest: false,
      // (the alpha written as it is, not blended: it is the decal's)
      blending: THREE.NoBlending,
    })
    disposables.push(composite)
    const quad = new THREE.PlaneGeometry(2, 2)
    disposables.push(quad)
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(quad, composite))
    renderer.setRenderTarget(out)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.render(scene, ortho)
    const pixels = readPixels(renderer, out)
    // where the islands are (white wherever a paint-target triangle lies), for the gutter
    const flat = new THREE.ShaderMaterial({
      uniforms: { projView: { value: new THREE.Matrix4() }, flipV: { value: flipY ? 1 : 0 } },
      vertexShader: unwrapVertex, fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }', side: THREE.DoubleSide, blending: THREE.NoBlending,
    })
    disposables.push(flat)
    const islandScene = new THREE.Scene()
    for (const g of paintGeometry) islandScene.add(new THREE.Mesh(g, flat))
    renderer.setRenderTarget(out)
    renderer.clear()
    renderer.render(islandScene, ortho)
    const coverage = readPixels(renderer, out)
    const covered = new Uint8Array(width * height)
    for (let i = 0; i < covered.length; i++) covered[i] = coverage[i * 4] > 127 ? 1 : 0
    dilateGutters(pixels, covered, width, height, gutterOf(width, height))
    return canvasOf(pixels, width, height)
  } finally {
    renderer.autoClear = autoClear
    renderer.setRenderTarget(previous)
    renderer.setClearColor(clearColor, clearAlpha)
    for (const d of disposables) d.dispose()
  }
}
