// A loaded character in the stage: meshes, skeleton, display modes (shaded / weights / x-ray / clay). It is what the
// viewer (src/state/viewer.svelte.ts) puts on the stage and hands to every area's onLoad hook; it knows only its own
// file (gear and the rest that areas hang on its bones are theirs to add and take off).
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { captureRest, type RestSkeleton } from './retarget.ts'
import type { Stage } from './Stage.ts'

export type DisplayMode = 'shaded' | 'clay' | 'weights' | 'xray'

const loader = new GLTFLoader()

// Distinct, calm bone colors for the weight view (golden-angle hue walk).
function boneColor (index: number): THREE.Color {
  return new THREE.Color().setHSL((index * 0.618034) % 1, 0.78, 0.52)
}

const PAINT_TINT = new THREE.Color(0xff3df0)

export class CharacterView {
  readonly root: THREE.Group
  readonly meshes: THREE.Mesh[] = []
  readonly skinned: THREE.SkinnedMesh[] = []
  /** The skinned primitives of the character's own file, in glTF scene order (depth first; a mesh of several
   * primitives is one per primitive, in order). Painted weights name a primitive by its index here, and the server's
   * weights route reads the file in the same order (it refuses an index out of range). Taken at load, so nothing an
   * area adds later (gear) is ever in it. */
  readonly bodySkinned: readonly THREE.SkinnedMesh[]
  readonly skeleton: THREE.Skeleton | null
  readonly bones = new Map<string, THREE.Bone>()
  readonly box = new THREE.Box3()
  readonly height: number
  /** Bind pose of the skeleton (null for unrigged meshes), with canonical (Mixamo) bone names. */
  rest: RestSkeleton | null
  /** Node name -> canonical name for custom skeletons (see presets/skeletonMap.ts). */
  rename: ((name: string) => string | null) | undefined = undefined
  private readonly originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  private readonly clay = new THREE.MeshStandardMaterial({ color: 0xb9bfcc, roughness: 0.75, metalness: 0, side: THREE.DoubleSide })
  private weightMaterial: THREE.MeshLambertMaterial | null = null
  private skeletonLines: THREE.LineSegments | null = null
  private offSkeletonLines: (() => void) | null = null
  private mode: DisplayMode = 'shaded'
  private highlightBone: string | null = null

  static async load (url: string): Promise<CharacterView> {
    const gltf = await loader.loadAsync(url)
    return new CharacterView(gltf.scene)
  }

  constructor (root: THREE.Group) {
    this.root = root
    root.traverse(object => {
      if ((object as THREE.Mesh).isMesh) {
        const mesh = object as THREE.Mesh
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.frustumCulled = false
        this.meshes.push(mesh)
        // (both sides drawn: the generated robes and capes are closed shells, and a hem pulled to follow a leg folds its
        // triangles over; drawn one-sided they vanish and show the shell's unlit inside, black shards. The back of a fold
        // shows the cloth's own texture, its normal turned to face the camera)
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.side = THREE.DoubleSide
        this.originalMaterials.set(mesh, mesh.material)
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) this.skinned.push(mesh as THREE.SkinnedMesh)
        if (mesh.geometry.attributes.color !== undefined) this.hadVertexColors.add(mesh.geometry)
      }
      if ((object as THREE.Bone).isBone) this.bones.set(object.name, object as THREE.Bone)
    })
    this.bodySkinned = [...this.skinned]
    this.skeleton = this.skinned[0]?.skeleton ?? null
    root.updateMatrixWorld(true)
    for (const mesh of this.meshes) {
      mesh.geometry.computeBoundingBox()
      this.box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld))
    }
    this.height = Math.max(this.box.max.y - this.box.min.y, 1e-3)
    this.rest = this.skeleton === null ? null : captureRest(root, o => (o as THREE.Bone).isBone === true)
  }

  /** Use a custom bone map (imported non-Mixamo skeletons): rebuilds the canonical rest skeleton. */
  setRename (rename: ((name: string) => string | null) | undefined): void {
    this.rename = rename
    if (this.skeleton === null) return
    // Bones may be posed right now: read the rest from the skeleton's inverse binds.
    const saved = this.skeleton.bones.map(b => [b.position.clone(), b.quaternion.clone(), b.scale.clone()] as const)
    this.skeleton.pose()
    this.rest = captureRest(this.root, o => (o as THREE.Bone).isBone === true, rename)
    this.skeleton.bones.forEach((b, i) => { b.position.copy(saved[i][0]); b.quaternion.copy(saved[i][1]); b.scale.copy(saved[i][2]) })
    this.root.updateMatrixWorld(true)
  }

  addTo (stage: Stage): void {
    stage.content.add(this.root)
    stage.setSubjectSize(this.height)
  }

  get displayMode (): DisplayMode { return this.mode }

  /** True when the imported model itself has vertex colors (the weight view adds its own). */
  readonly hadVertexColors = new Set<THREE.BufferGeometry>()

  setMode (mode: DisplayMode): void {
    this.mode = mode
    for (const mesh of this.meshes) {
      if (mode === 'shaded') mesh.material = this.originalMaterials.get(mesh)!
      else if (mode === 'clay') mesh.material = this.clay
      else if (mode === 'weights') mesh.material = this.weightMat(mesh)
      else if (mode === 'xray') mesh.material = this.xrayMat(mesh)
    }
  }

  /** Show one bone's influence as a heat map (null = all bones colored). */
  setHighlightBone (name: string | null): void {
    this.highlightBone = name
    if (this.mode === 'weights') {
      for (const mesh of this.meshes) this.writeWeightColors(mesh)
    }
  }

  private xrayMats = new Map<THREE.Mesh, THREE.Material>()
  private xrayMat (mesh: THREE.Mesh): THREE.Material {
    let m = this.xrayMats.get(mesh)
    if (m === undefined) {
      const original = this.originalMaterials.get(mesh)
      const source = Array.isArray(original) ? original[0] : original
      const map = (source as THREE.MeshStandardMaterial | undefined)?.map ?? null
      m = new THREE.MeshBasicMaterial({ map, color: map !== null ? 0xffffff : 0x9aa3b5, transparent: true, opacity: 0.32, depthWrite: false })
      this.xrayMats.set(mesh, m)
    }
    return m
  }

  private weightMat (mesh: THREE.Mesh): THREE.Material {
    this.weightMaterial ??= new THREE.MeshLambertMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide })
    this.writeWeightColors(mesh)
    return this.weightMaterial
  }

  private writeWeightColors (mesh: THREE.Mesh): void {
    const geometry = mesh.geometry
    const count = geometry.attributes.position.count
    const colors = new Float32Array(count * 3)
    const skinIndex = geometry.attributes.skinIndex
    const skinWeight = geometry.attributes.skinWeight
    const skinnedMesh = mesh as THREE.SkinnedMesh
    const highlight = this.highlightBone === null || !skinnedMesh.isSkinnedMesh
      ? -1
      : skinnedMesh.skeleton.bones.findIndex(b => b.name === this.highlightBone)
    const color = new THREE.Color()
    const cold = new THREE.Color(0x1d2433)
    const hot = new THREE.Color(0xff6b3d)
    const mid = new THREE.Color(0x8ea2ff)
    for (let i = 0; i < count; i++) {
      if (skinIndex === undefined) { color.set(0x6c7384) } else if (highlight >= 0) {
        let w = 0
        for (let k = 0; k < 4; k++) if (skinIndex.getComponent(i, k) === highlight) w += skinWeight.getComponent(i, k)
        color.copy(cold).lerp(mid, Math.min(w * 2, 1)).lerp(hot, Math.max(w * 2 - 1, 0))
      } else {
        color.setRGB(0, 0, 0)
        for (let k = 0; k < 4; k++) {
          const w = skinWeight.getComponent(i, k)
          if (w > 0) color.add(boneColor(skinIndex.getComponent(i, k)).multiplyScalar(w))
        }
      }
      // (the weight painter's area, tinted over the weights)
      const m = this.paintMasks.get(mesh)?.[i] ?? 0
      if (m > 0) color.lerp(PAINT_TINT, 0.65 * m)
      colors.set([color.r, color.g, color.b], i * 3)
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  }

  /** The weight painter's area per mesh (0..1 per vertex), tinted in the Weights view. */
  readonly paintMasks = new Map<THREE.Mesh, Float32Array>()

  /** Weights changed (painted): the Weights view drawn again. */
  refreshWeights (): void {
    if (this.mode === 'weights') for (const mesh of this.meshes) this.writeWeightColors(mesh)
  }

  /** Bone lines overlay (for rigged characters), updated every frame. */
  showSkeleton (stage: Stage, visible: boolean): void {
    if (this.skeleton === null) return
    if (this.skeletonLines === null) {
      const pairs = this.skeleton.bones.filter(b => (b.parent as THREE.Bone | null)?.isBone === true).length
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pairs * 6), 3))
      this.skeletonLines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xf5c45e, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false }))
      this.skeletonLines.renderOrder = 10
      this.skeletonLines.frustumCulled = false
      stage.scene.add(this.skeletonLines)
      this.offSkeletonLines = stage.onFrame(() => { this.updateSkeletonLines() })
    }
    this.skeletonLines.visible = visible
  }

  private updateSkeletonLines (): void {
    if (this.skeletonLines === null || !this.skeletonLines.visible || this.skeleton === null) return
    const positions = this.skeletonLines.geometry.attributes.position as THREE.BufferAttribute
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    let i = 0
    for (const bone of this.skeleton.bones) {
      const parent = bone.parent as THREE.Bone | null
      if (parent?.isBone !== true) continue
      parent.getWorldPosition(a)
      bone.getWorldPosition(b)
      positions.setXYZ(i++, a.x, a.y, a.z)
      positions.setXYZ(i++, b.x, b.y, b.z)
    }
    positions.needsUpdate = true
  }

  /** Off the stage (or whatever holds it), and every GPU resource it made let go. */
  dispose (stage?: Stage): void {
    if (stage !== undefined) stage.content.remove(this.root)
    this.root.removeFromParent()
    this.offSkeletonLines?.()
    this.offSkeletonLines = null
    if (this.skeletonLines !== null) {
      this.skeletonLines.removeFromParent()
      this.skeletonLines.geometry.dispose()
      ;(this.skeletonLines.material as THREE.Material).dispose()
      this.skeletonLines = null
    }
    this.root.traverse(object => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh) {
        mesh.geometry.dispose()
        const mats = this.originalMaterials.get(mesh)
        for (const m of Array.isArray(mats) ? mats : [mats]) {
          if (m === undefined) continue
          for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose()
          m.dispose()
        }
      }
    })
    for (const m of this.xrayMats.values()) m.dispose()
    this.clay.dispose()
    this.weightMaterial?.dispose()
  }
}
