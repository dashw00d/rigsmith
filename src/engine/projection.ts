// Projection painting: capture the current view for an image generator, then project the generated
// image back onto the character's texture (only texels visible from that view, inside the mask).
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

/** File name Blender uses for an image override (bpy.path.clean_name). */
export function cleanName (name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_')
}

function renderTarget (width: number, height: number, srgb = false): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true })
  if (srgb) target.texture.colorSpace = THREE.SRGBColorSpace
  return target
}

/** Images and bitmaps as canvases, so WebGL honors flipY on upload. */
function toCanvas (image: HTMLImageElement | ImageBitmap | HTMLCanvasElement): HTMLCanvasElement {
  if (image instanceof HTMLCanvasElement) return image
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return canvas
}

function readPixels (renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): Uint8ClampedArray {
  const { width, height } = target
  const pixels = new Uint8Array(width * height * 4)
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
  // GL rows go bottom-up; images go top-down.
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) out.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4)
  return out
}

async function toPng (pixels: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(width, height)
  image.data.set(pixels)
  ctx.putImageData(image, 0, 0)
  return await new Promise(resolve => { canvas.toBlob(b => { resolve(b!) }, 'image/png') })
}

export type Pass = 'color' | 'flat' | 'depth' | 'normal' | 'mask'

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
  const target = renderTarget(width, height, true)
  const linearTarget = renderTarget(width, height)
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
  const restore = (saved: Map<THREE.Mesh, THREE.Material | THREE.Material[]>): void => { for (const [m, mat] of saved) m.material = mat }
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
    // Depth normalized to the character itself so the guide uses the full range.
    const sphere = view.box.getBoundingSphere(new THREE.Sphere())
    const distance = camera.position.distanceTo(sphere.center)
    const near = Math.max(distance - sphere.radius, camera.near)
    const far = distance + sphere.radius
    pass('depth', linearTarget, () => new THREE.ShaderMaterial({
      uniforms: { near: { value: near }, far: { value: far } },
      vertexShader: `#include <common>
        #include <skinning_pars_vertex>
        varying float vDepth;
        void main() {
          #include <skinbase_vertex>
          #include <begin_vertex>
          #include <skinning_vertex>
          vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform float near; uniform float far; varying float vDepth;
        void main() { float d = 1.0 - clamp((vDepth - near) / (far - near), 0.0, 1.0); gl_FragColor = vec4(vec3(d), 1.0); }`,
    }))
    pass('normal', linearTarget, () => new THREE.MeshNormalMaterial())
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

/** Render passes of just the character from the current camera, at `size` on the long side, as PNGs. */
export async function captureView (stage: Stage, view: CharacterView, size = 1024): Promise<{ camera: ProjectionCamera, color: Blob, flat: Blob, depth: Blob, normal: Blob }> {
  const aspect = stage.camera.aspect
  const width = Math.round(aspect >= 1 ? size : size * aspect)
  const height = Math.round(aspect >= 1 ? size / aspect : size)
  const { camera, pixels } = renderPasses(stage, view, width, height, ['color', 'flat', 'depth', 'normal'])
  return {
    camera,
    color: await toPng(pixels.color!, width, height),
    flat: await toPng(pixels.flat!, width, height),
    depth: await toPng(pixels.depth!, width, height),
    normal: await toPng(pixels.normal!, width, height),
  }
}

/** Render passes of just the character from `camera`, `size` square, as PNGs; with `mask`, the mask as seen. */
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

export async function captureFrom (stage: Stage, view: CharacterView, camera: THREE.PerspectiveCamera, mask: THREE.Texture, size = 1024): Promise<{ camera: ProjectionCamera, color: Blob, flat: Blob, depth: Blob, normal: Blob, mask: Blob, maskPixels: Uint8ClampedArray }> {
  const { camera: cam, pixels } = renderPasses(stage, view, size, size, ['color', 'flat', 'depth', 'normal', 'mask'], { camera, mask })
  // (the mask over a black background: white to repaint)
  const m = pixels.mask!
  for (let i = 0; i < m.length; i += 4) { const v = m[i + 3] > 0 ? m[i] : 0; m[i] = m[i + 1] = m[i + 2] = v; m[i + 3] = 255 }
  // (hairline cracks between the mesh's triangles show the background through: closed, else each is a line of the
  // surface either side left unpainted)
  closeGaps(m, size, size, 2)
  return {
    camera: cam,
    color: await toPng(pixels.color!, size, size),
    flat: await toPng(pixels.flat!, size, size),
    depth: await toPng(pixels.depth!, size, size),
    normal: await toPng(pixels.normal!, size, size),
    mask: await toPng(m, size, size),
    maskPixels: m,
  }
}

/** Bind-pose geometry in world space (skinned meshes: the bind matrix; others: their transform). */
function restGeometry (mesh: THREE.Mesh): THREE.BufferGeometry {
  const g = mesh.geometry.clone()
  g.applyMatrix4((mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh).bindMatrix : mesh.matrixWorld)
  return g
}

const depthVertex = 'uniform mat4 projView; varying float vZ; void main() { vec4 c = projView * modelMatrix * vec4(position, 1.0); vZ = c.z / c.w; gl_Position = c; }'
const depthFragment = 'varying float vZ; void main() { gl_FragColor = vec4(vZ, 0.0, 0.0, 1.0); }'

export interface PlannedView { name: string, camera: THREE.PerspectiveCamera, /** share of the masked surface it paints best */ share: number }

/** The fewest views (at most `most`) that between them see the masked surface squarely: from 48 directions round
 * it, each sample's quality is how squarely it faces the camera where nothing hides it (1 head-on). Views are taken
 * greedily by how much they bring samples up toward `enough` (or what the best view could give them), until all but
 * `short` of them are there or the next view would add less than `minGain` of the whole. Each view is then framed on
 * the samples it paints best. */
export function planViews (renderer: THREE.WebGLRenderer, view: CharacterView, samples: Array<{ at: THREE.Vector3, normal: THREE.Vector3 }>, fov: number, most = 6, enough = 0.6, short = 0.03, minGain = 0.04): PlannedView[] {
  if (samples.length === 0) return []
  const sphere = new THREE.Sphere().setFromPoints(samples.map(s => s.at))
  sphere.radius = Math.max(sphere.radius, 0.05 * view.height)
  const whole = view.box.getBoundingSphere(new THREE.Sphere())
  const size = 256
  const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false })
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
  // greedy: the view adding most over the best each sample has so far
  const best = new Float32Array(samples.length)
  const chosen: number[] = []
  const reachable = new Float32Array(samples.length)
  for (const q of quality) for (let i = 0; i < q.length; i++) reachable[i] = Math.max(reachable[i], q[i])
  // (what each sample needs: seen squarely enough, or as well as any view can; better than that adds nothing, so
  // a view only earns its place by covering what the others don't)
  const need = Float32Array.from(reachable, r => Math.min(enough, r * 0.8))
  while (chosen.length < most) {
    let pick = -1; let gain = 0
    quality.forEach((q, d) => {
      if (chosen.includes(d)) return
      let g = 0
      for (let i = 0; i < q.length; i++) g += Math.max(0, Math.min(q[i], need[i]) - Math.min(best[i], need[i]))
      // (ties go to the squarer view)
      for (let i = 0; i < q.length; i++) g += 1e-3 * Math.max(0, q[i] - best[i])
      if (g > gain) { gain = g; pick = d }
    })
    // (a view that adds little is not worth another image to keep consistent: spots seen only at a glance, a hood's
    // lining through the face opening, are left to what the other views see of them)
    if (pick < 0 || gain < minGain * samples.length) break
    chosen.push(pick)
    for (let i = 0; i < best.length; i++) best[i] = Math.max(best[i], quality[pick][i])
    // (done when nearly every sample is seen squarely enough, or as well as any view could)
    let left = 0
    for (let i = 0; i < best.length; i++) if (reachable[i] > 0 && best[i] < need[i]) left++
    if (left <= short * samples.length) break
  }
  // each view framed on the samples it paints best
  return chosen.map(d => {
    const own = samples.filter((_, i) => quality[d][i] > 0 && chosen.every(e => quality[e][i] <= quality[d][i]))
    const around = own.length >= 3 ? new THREE.Sphere().setFromPoints(own.map(s => s.at)) : sphere.clone()
    // (whole: what else of this view's masked surface it sees, so the frame holds all it will paint)
    const seen = samples.filter((_, i) => quality[d][i] > 0.3)
    if (seen.length >= 3) around.union(new THREE.Sphere().setFromPoints(seen.map(s => s.at)))
    around.radius = Math.max(around.radius, 0.05 * view.height)
    return { name: nameOf(dirs[d]), camera: frame(dirs[d], around), share: own.length / samples.length }
  })
}

/** A view direction in words, from the character's side (it faces +z, its left is +x). */
function nameOf (dir: THREE.Vector3): string {
  const up = dir.y > 0.6 ? 'above' : dir.y < -0.6 ? 'below' : ''
  const h = Math.hypot(dir.x, dir.z)
  if (h < 0.3) return up
  const a = THREE.MathUtils.radToDeg(Math.atan2(dir.x, dir.z))
  const names = ['front', 'front-left', 'left', 'back-left', 'back', 'back-right', 'right', 'front-right']
  const side = names[((Math.round(a / 45) % 8) + 8) % 8]
  return up !== '' ? `${up} ${side}` : side
}

/** Buffers for edge-aware selection at the viewport's pixel size. */
export function analyzeView (stage: Stage, view: CharacterView, width: number, height: number): { color: Uint8ClampedArray, normal: Uint8ClampedArray, depth: Uint8ClampedArray } {
  const { pixels } = renderPasses(stage, view, width, height, ['flat', 'normal', 'depth'])
  const depthRgba = pixels.depth!
  const depth = new Uint8ClampedArray(width * height)
  for (let i = 0; i < depth.length; i++) depth[i] = depthRgba[i * 4 + 3] > 0 ? depthRgba[i * 4] : 0
  return { color: pixels.flat!, normal: pixels.normal!, depth }
}

/**
 * Project `result` (an image the size of the capture) through the capture camera onto the texture.
 * Texels count when they are inside the mask, face the camera and are not hidden behind other geometry.
 * Returns the new texture as a canvas (original texture with the projection blended in).
 */
export function bakeProjection (renderer: THREE.WebGLRenderer, view: CharacterView, cam: ProjectionCamera, result: HTMLImageElement | ImageBitmap | HTMLCanvasElement, mask: HTMLImageElement | ImageBitmap | HTMLCanvasElement, base?: HTMLImageElement | ImageBitmap | HTMLCanvasElement): HTMLCanvasElement {
  const target = paintTarget(view)
  if (target === null) throw new Error('This model has no color texture to paint on')
  const source = base ?? target.texture.image as HTMLImageElement | ImageBitmap
  const width = source.width
  const height = source.height
  const projection = new THREE.Matrix4().fromArray(cam.projection)
  const viewMatrix = new THREE.Matrix4().fromArray(cam.view)
  const projView = new THREE.Matrix4().multiplyMatrices(projection, viewMatrix)

  // 1) Depth from the capture camera, to reject texels hidden behind other parts of the model. (Sampled texel for
  // texel: not every GPU filters float textures, and one it can't filter reads as zero, hiding everything.)
  const depthTarget = new THREE.WebGLRenderTarget(cam.width, cam.height, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false })
  const depthScene = new THREE.Scene()
  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: { projView: { value: projView } },
    vertexShader: 'uniform mat4 projView; varying float vZ; void main() { vec4 c = projView * modelMatrix * vec4(position, 1.0); vZ = c.z / c.w; gl_Position = c; }',
    fragmentShader: 'varying float vZ; void main() { gl_FragColor = vec4(vZ, 0.0, 0.0, 1.0); }',
  })
  const restGeometry = (mesh: THREE.Mesh): THREE.BufferGeometry => {
    // Bind-pose geometry in world space (skinned meshes: the bind matrix; others: their transform).
    const g = mesh.geometry.clone()
    g.applyMatrix4((mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh).bindMatrix : mesh.matrixWorld)
    return g
  }
  const allGeometry = view.meshes.map(restGeometry)
  for (const g of allGeometry) depthScene.add(new THREE.Mesh(g, depthMaterial))
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const previous = renderer.getRenderTarget()
  renderer.setRenderTarget(depthTarget)
  const clearColor = renderer.getClearColor(new THREE.Color())
  const clearAlpha = renderer.getClearAlpha()
  renderer.setClearColor(0xff0000, 1) // background depth = far
  renderer.clear()
  depthMaterial.depthTest = true
  renderer.render(depthScene, ortho)

  // 2) Unwrap to UV space: original texture, then the projection blended on top.
  const out = new THREE.WebGLRenderTarget(width, height)
  const original = new THREE.Texture(source)
  original.flipY = target.texture.flipY
  original.colorSpace = THREE.NoColorSpace
  original.needsUpdate = true
  const resultTexture = new THREE.Texture(toCanvas(result))
  resultTexture.colorSpace = THREE.NoColorSpace
  resultTexture.needsUpdate = true
  const maskTexture = new THREE.Texture(toCanvas(mask))
  maskTexture.needsUpdate = true
  const flipY = target.texture.flipY
  const copy = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { map: { value: original }, flipV: { value: flipY ? 1 : 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D map; uniform float flipV; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vec2(vUv.x, flipV > 0.5 ? vUv.y : 1.0 - vUv.y)); }',
    depthTest: false,
  }))
  const project = new THREE.ShaderMaterial({
    uniforms: {
      projView: { value: projView }, camPos: { value: new THREE.Vector3(...cam.position) },
      resultMap: { value: resultTexture }, maskMap: { value: maskTexture }, depthMap: { value: depthTarget.texture },
      flipV: { value: flipY ? 1 : 0 },
    },
    vertexShader: `uniform mat4 projView; uniform float flipV;
      varying vec4 vClip; varying vec3 vNormal; varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vClip = projView * world;
        vec2 t = vec2(uv.x, flipV > 0.5 ? uv.y : 1.0 - uv.y);
        gl_Position = vec4(t * 2.0 - 1.0, 0.0, 1.0);
      }`,
    fragmentShader: `uniform sampler2D resultMap; uniform sampler2D maskMap; uniform sampler2D depthMap; uniform vec3 camPos;
      varying vec4 vClip; varying vec3 vNormal; varying vec3 vWorld;
      void main() {
        vec3 ndc = vClip.xyz / vClip.w;
        vec2 s = ndc.xy * 0.5 + 0.5;
        if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || vClip.w <= 0.0) discard;
        float facing = dot(normalize(vNormal), normalize(camPos - vWorld));
        if (facing <= 0.05) discard;
        float sceneZ = texture2D(depthMap, s).r;
        if (ndc.z > sceneZ + 0.002) discard;
        float m = texture2D(maskMap, s).r;
        vec4 c = texture2D(resultMap, s);
        float a = m * c.a * smoothstep(0.05, 0.35, facing);
        if (a <= 0.003) discard;
        gl_FragColor = vec4(c.rgb, a);
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const uvScene = new THREE.Scene()
  uvScene.add(copy)
  for (const mesh of target.meshes) {
    const g = restGeometry(mesh)
    const m = new THREE.Mesh(g, project)
    m.renderOrder = 1
    uvScene.add(m)
  }
  renderer.setRenderTarget(out)
  renderer.render(uvScene, ortho)

  // 3) Read back into a canvas (rows flipped to image order).
  const pixels = new Uint8Array(width * height * 4)
  renderer.readRenderTargetPixels(out, 0, 0, width, height, pixels)
  renderer.setRenderTarget(previous)
  renderer.setClearColor(clearColor, clearAlpha)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(width, height)
  for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4)
  ctx.putImageData(image, 0, 0)

  for (const g of allGeometry) g.dispose()
  depthTarget.dispose()
  out.dispose()
  original.dispose()
  resultTexture.dispose()
  maskTexture.dispose()
  project.dispose()
  depthMaterial.dispose()
  return canvas
}

/**
 * Several views' results projected onto the texture together: each texel takes the views that see it (inside their
 * mask, facing them, not hidden), weighted toward the one that sees it most squarely, and replaces the original as
 * far as `uvMask` (the mask in the texture's layout) says. Returns the new texture as a canvas.
 */
export function bakeViews (renderer: THREE.WebGLRenderer, view: CharacterView, views: Array<{ camera: ProjectionCamera, result: HTMLImageElement | ImageBitmap | HTMLCanvasElement, mask: HTMLImageElement | ImageBitmap | HTMLCanvasElement }>, uvMask: HTMLCanvasElement | HTMLImageElement, base?: HTMLImageElement | ImageBitmap | HTMLCanvasElement): HTMLCanvasElement {
  const target = paintTarget(view)
  if (target === null) throw new Error('This model has no color texture to paint on')
  // (the texture as it was: while a preview shows, the model's own is that preview)
  const source = base ?? target.texture.image as HTMLImageElement | ImageBitmap
  const width = source.width
  const height = source.height
  const flipY = target.texture.flipY
  const previous = renderer.getRenderTarget()
  const clearColor = renderer.getClearColor(new THREE.Color())
  const clearAlpha = renderer.getClearAlpha()
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const allGeometry = view.meshes.map(restGeometry)
  const paintGeometry = target.meshes.map(restGeometry)
  // (read back texel for texel: nearest, since not every GPU filters half floats; an unfilterable one reads black)
  // (each pass adds to the sum: a render must not clear it first)
  const autoClear = renderer.autoClear
  renderer.autoClear = false
  const accum = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false })
  const disposables: Array<{ dispose: () => void }> = [accum, ...allGeometry, ...paintGeometry]
  try {
    renderer.setRenderTarget(accum)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    for (const v of views) {
      const projView = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().fromArray(v.camera.projection), new THREE.Matrix4().fromArray(v.camera.view))
      // depth from this view, to leave texels hidden behind other parts
      const depthTarget = new THREE.WebGLRenderTarget(v.camera.width, v.camera.height, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false })
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
        vertexShader: `uniform mat4 projView; uniform float flipV;
          varying vec4 vClip; varying vec3 vNormal; varying vec3 vWorld;
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            vWorld = world.xyz;
            vNormal = normalize(mat3(modelMatrix) * normal);
            vClip = projView * world;
            vec2 t = vec2(uv.x, flipV > 0.5 ? uv.y : 1.0 - uv.y);
            gl_Position = vec4(t * 2.0 - 1.0, 0.0, 1.0);
          }`,
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
    // the original, with the blended views over it as far as the mask goes
    const out = new THREE.WebGLRenderTarget(width, height)
    disposables.push(out)
    const original = new THREE.Texture(source); original.flipY = flipY; original.colorSpace = THREE.NoColorSpace; original.needsUpdate = true
    const mask = new THREE.Texture(toCanvas(uvMask)); mask.flipY = false; mask.needsUpdate = true
    disposables.push(original, mask)
    const composite = new THREE.ShaderMaterial({
      uniforms: { map: { value: original }, accum: { value: accum.texture }, uvMask: { value: mask }, flipV: { value: flipY ? 1 : 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D map; uniform sampler2D accum; uniform sampler2D uvMask; uniform float flipV; varying vec2 vUv;
        void main() {
          // (this target's rows run up from v = 0; the image's texture coordinates as the model reads them)
          vec2 t = vec2(vUv.x, flipV > 0.5 ? vUv.y : 1.0 - vUv.y);
          vec4 o = texture2D(map, vec2(vUv.x, flipV > 0.5 ? vUv.y : 1.0 - vUv.y));
          vec4 a = texture2D(accum, vUv);
          float m = texture2D(uvMask, t).r;
          // (any view that saw it at all paints it: a lining seen only at a slant takes that view's paint rather than
          // keeping its old colour beside the new)
          float k = a.a > 0.0 ? m * clamp(a.a / 0.0005, 0.0, 1.0) : 0.0;
          gl_FragColor = vec4(mix(o.rgb, a.rgb / max(a.a, 1e-5), k), o.a);
        }`,
      depthTest: false,
    })
    disposables.push(composite)
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), composite)
    const scene = new THREE.Scene(); scene.add(plane)
    renderer.setRenderTarget(out)
    renderer.render(scene, ortho)
    const pixels = new Uint8Array(width * height * 4)
    renderer.readRenderTargetPixels(out, 0, 0, width, height, pixels)
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    const ctx = canvas.getContext('2d')!
    const image = ctx.createImageData(width, height)
    for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4)
    ctx.putImageData(image, 0, 0)
    return canvas
  } finally {
    renderer.autoClear = autoClear
    renderer.setRenderTarget(previous)
    renderer.setClearColor(clearColor, clearAlpha)
    for (const d of disposables) d.dispose()
  }
}
