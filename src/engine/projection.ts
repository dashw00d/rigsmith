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

export type Pass = 'color' | 'flat' | 'depth' | 'normal'

/** Render passes of just the character from the current camera at an exact size (rows top-down). */
export function renderPasses (stage: Stage, view: CharacterView, width: number, height: number, which: Pass[]): { camera: ProjectionCamera, pixels: Partial<Record<Pass, Uint8ClampedArray>> } {
  const renderer = stage.renderer
  const previousTarget = renderer.getRenderTarget()
  const previousClear = renderer.getClearAlpha()
  const scene = new THREE.Scene()
  scene.environment = stage.scene.environment
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.4))
  const key = new THREE.DirectionalLight(0xffffff, 1.6)
  key.position.copy(stage.camera.position).add(new THREE.Vector3(0.5, 1, 0.3))
  scene.add(key)
  const parent = view.root.parent
  scene.add(view.root)
  const target = renderTarget(width, height, true)
  const linearTarget = renderTarget(width, height)
  const pixels: Partial<Record<Pass, Uint8ClampedArray>> = {}
  const swap = (make: (m: THREE.Mesh) => THREE.Material | null): Map<THREE.Mesh, THREE.Material | THREE.Material[]> => {
    const saved = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
    view.root.traverse(o => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      saved.set(mesh, mesh.material)
      const replacement = make(mesh)
      if (replacement !== null) mesh.material = replacement
    })
    return saved
  }
  const restore = (saved: Map<THREE.Mesh, THREE.Material | THREE.Material[]>): void => { for (const [m, mat] of saved) m.material = mat }
  const camera = stage.camera.clone()
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
export function bakeProjection (renderer: THREE.WebGLRenderer, view: CharacterView, cam: ProjectionCamera, result: HTMLImageElement | ImageBitmap | HTMLCanvasElement, mask: HTMLImageElement | ImageBitmap | HTMLCanvasElement): HTMLCanvasElement {
  const target = paintTarget(view)
  if (target === null) throw new Error('This model has no color texture to paint on')
  const source = target.texture.image as HTMLImageElement | ImageBitmap
  const width = source.width
  const height = source.height
  const projection = new THREE.Matrix4().fromArray(cam.projection)
  const viewMatrix = new THREE.Matrix4().fromArray(cam.view)
  const projView = new THREE.Matrix4().multiplyMatrices(projection, viewMatrix)

  // 1) Depth from the capture camera, to reject texels hidden behind other parts of the model.
  const depthTarget = new THREE.WebGLRenderTarget(cam.width, cam.height, { type: THREE.FloatType, format: THREE.RGBAFormat })
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
