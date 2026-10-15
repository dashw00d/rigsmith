// The 3D stage: renderer, camera, orbit controls, lighting, ground. One per viewport.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

type FrameCallback = (dt: number) => void

export class Stage {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.01, 200)
  readonly controls: OrbitControls
  readonly content = new THREE.Group()
  private readonly ground: THREE.Group
  private readonly key: THREE.DirectionalLight
  private readonly callbacks = new Set<FrameCallback>()
  private readonly clock = new THREE.Clock()
  private readonly resizeObserver: ResizeObserver
  private framing: { from: THREE.Vector3, to: THREE.Vector3, targetFrom: THREE.Vector3, targetTo: THREE.Vector3, t: number } | null = null

  constructor (readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.AgXToneMapping
    this.renderer.toneMappingExposure = 1.1
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.display = 'block'

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.55

    this.scene.add(new THREE.HemisphereLight(0xd4dcff, 0x1a1c22, 0.9))
    this.key = new THREE.DirectionalLight(0xfff4e8, 2.2)
    this.key.position.set(2.5, 4, 3)
    this.key.castShadow = true
    this.key.shadow.mapSize.set(2048, 2048)
    this.key.shadow.bias = -0.0004
    this.key.shadow.radius = 4
    this.scene.add(this.key, this.key.target)
    const rim = new THREE.DirectionalLight(0x8ea2ff, 1.4)
    rim.position.set(-3, 2.5, -4)
    this.scene.add(rim)

    this.ground = this.makeGround()
    this.scene.add(this.ground, this.content)

    this.camera.position.set(1.6, 1.2, 3.2)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.target.set(0, 0.5, 0)
    this.controls.screenSpacePanning = true

    this.resizeObserver = new ResizeObserver(() => { this.resize() })
    this.resizeObserver.observe(container)
    this.resize()
    this.renderer.setAnimationLoop(() => { this.tick() })
  }

  private makeGround (): THREE.Group {
    const group = new THREE.Group()
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.32 }))
    shadow.rotation.x = -Math.PI / 2
    shadow.receiveShadow = true
    group.add(shadow)
    // Fading circular grid drawn in a shader so it never shows a hard edge.
    const grid = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uScale: { value: 1 } },
        vertexShader: `varying vec2 vPos; uniform float uScale;
          void main() { vPos = position.xy * uScale; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `varying vec2 vPos; uniform float uScale;
          float line(vec2 p, float size) { vec2 g = abs(fract(p / size - 0.5) - 0.5) / fwidth(p / size); return 1.0 - min(min(g.x, g.y), 1.0); }
          void main() {
            float fade = 1.0 - smoothstep(0.15, 0.5, length(vPos) / uScale);
            float a = line(vPos, uScale * 0.05) * 0.10 + line(vPos, uScale * 0.25) * 0.16;
            gl_FragColor = vec4(vec3(0.62, 0.68, 0.85), a * fade);
          }`,
      }),
    )
    grid.rotation.x = -Math.PI / 2
    grid.name = 'grid'
    grid.renderOrder = -1
    group.add(grid)
    return group
  }

  /** Scale ground grid and shadows to the subject's size. */
  setSubjectSize (height: number): void {
    const grid = this.ground.getObjectByName('grid') as THREE.Mesh
    grid.scale.setScalar(height * 6)
    ;(grid.material as THREE.ShaderMaterial).uniforms.uScale.value = height * 6
    const s = Math.max(height * 1.5, 0.5)
    const cam = this.key.shadow.camera
    cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s
    cam.near = 0.01; cam.far = height * 20
    cam.updateProjectionMatrix()
    this.key.position.set(height * 2.5, height * 4, height * 3)
    this.camera.near = height * 0.01
    this.camera.far = height * 200
    this.camera.updateProjectionMatrix()
  }

  /** Smoothly move the camera to frame a box (three-quarter front view). */
  frame (box: THREE.Box3, instant = false): void {
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(size.y, size.x * 0.9, size.z) * 0.62
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05
    const direction = new THREE.Vector3(0.38, 0.16, 1).normalize()
    const to = center.clone().addScaledVector(direction, distance)
    if (instant) {
      this.camera.position.copy(to)
      this.controls.target.copy(center)
      this.framing = null
      return
    }
    this.framing = { from: this.camera.position.clone(), to, targetFrom: this.controls.target.clone(), targetTo: center, t: 0 }
  }

  onFrame (callback: FrameCallback): () => void {
    this.callbacks.add(callback)
    return () => { this.callbacks.delete(callback) }
  }

  private resize (): void {
    const { clientWidth: w, clientHeight: h } = this.container
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h, false)
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private tick (): void {
    const dt = Math.min(this.clock.getDelta(), 0.1)
    if (this.framing !== null) {
      const f = this.framing
      f.t = Math.min(1, f.t + dt * 2.2)
      const e = 1 - Math.pow(1 - f.t, 3)
      this.camera.position.lerpVectors(f.from, f.to, e)
      this.controls.target.lerpVectors(f.targetFrom, f.targetTo, e)
      if (f.t >= 1) this.framing = null
    }
    this.controls.update()
    // One failing callback must never stop the loop (that would freeze the viewport for good).
    for (const callback of this.callbacks) {
      try {
        callback(dt)
      } catch (error) {
        if (!this.failed.has(callback)) {
          this.failed.add(callback)
          console.error('Frame callback failed', error)
        }
      }
    }
    try {
      this.renderer.render(this.scene, this.camera)
    } catch (error) {
      if (!this.renderFailed) console.error('Render failed', error)
      this.renderFailed = true
    }
  }

  private readonly failed = new WeakSet<FrameCallback>()
  private renderFailed = false

  /** Screen position (CSS px within the container) of a world point. */
  project (point: THREE.Vector3): { x: number, y: number, visible: boolean } {
    const p = point.clone().project(this.camera)
    return { x: (p.x + 1) / 2 * this.container.clientWidth, y: (1 - p.y) / 2 * this.container.clientHeight, visible: p.z < 1 }
  }

  async snapshot (width = 256, height = 256): Promise<Blob> {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const src = this.renderer.domElement
    const side = Math.min(src.width, src.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, width, height)
    return await new Promise(resolve => { canvas.toBlob(b => { resolve(b!) }, 'image/webp', 0.9) })
  }

  dispose (): void {
    this.renderer.setAnimationLoop(null)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
