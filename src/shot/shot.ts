// One frame of a character, drawn as the viewer draws it (CharacterView, the lighting rig, shadows, AgX), for
// `node tools/rig.ts shot` (tools/lib/shot.ts opens this page headless and saves the canvas). Query:
//   file    the character's model URL (/files/characters/<id>/rigged.glb?v=...)
//   clip    a clip GLB URL (a library clip), retargeted onto the character in place as the viewer does; none: rest
//   frame   the frame to show (at `fps`, default 30); mode: shaded | clay | weights | xray; size: the square's pixels
//   view    front | back | left | right | three (front-right, from above), or x,y,z: the direction to the eye
//   zoom    1 the whole body; 2 its middle half (around `at`: 0 feet .. 1 head, default 0.5)
//   drop    maps left off, to see which one draws something: albedo (a plain white base), ao, normal, metal
// document.title says DONE (or FAILED: why) when the canvas holds the picture.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CharacterView, type DisplayMode } from '../engine/CharacterView.ts'
import { light, place, tone } from '../engine/lighting.ts'
import { captureRest, retarget } from '../engine/retarget.ts'

const VIEWS: Record<string, [number, number, number]> = {
  front: [0, 0.15, 1], back: [0, 0.15, -1], left: [1, 0.15, 0], right: [-1, 0.15, 0], three: [0.6, 0.35, 1],
}

async function shot (): Promise<void> {
  const q = new URLSearchParams(location.search)
  const size = Number(q.get('size') ?? 800)
  const canvas = document.getElementById('shot') as HTMLCanvasElement
  canvas.width = size; canvas.height = size
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  tone(renderer)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x1b2130)
  const rig = light(scene, renderer, { shadows: true })
  const view = await CharacterView.load(q.get('file')!)
  scene.add(view.root)
  const h = view.height
  // (the Stage's ground shadow and shadow frame, sized to the subject)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.32 }))
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; ground.position.y = view.box.min.y
  scene.add(ground)
  place(rig, h)
  const cam = rig.key.shadow.camera; const s = Math.max(h * 1.5, 0.5)
  cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s; cam.near = 0.01; cam.far = h * 20; cam.updateProjectionMatrix()
  const drop = new Set((q.get('drop') ?? '').split(',').filter(x => x !== ''))
  for (const m of view.meshes) {
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
      if (drop.has('albedo')) mat.map = null
      if (drop.has('ao')) mat.aoMap = null
      if (drop.has('normal')) mat.normalMap = null
      if (drop.has('metal')) { mat.metalnessMap = null; mat.roughnessMap = null; mat.metalness = 0; mat.roughness = 0.8 }
      mat.needsUpdate = true
    }
  }
  view.setMode((q.get('mode') ?? 'shaded') as DisplayMode)
  const clipUrl = q.get('clip')
  if (clipUrl !== null && clipUrl !== '') {
    const src = await new GLTFLoader().loadAsync(clipUrl)
    const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true
    const clip = retarget(src.scene, captureRest(src.scene, isBone), src.animations[0], view.rest!, { fps: 30, inPlace: true })
    const mixer = new THREE.AnimationMixer(view.root)
    mixer.clipAction(clip).play()
    mixer.setTime(Math.min(Number(q.get('frame') ?? 0) / Number(q.get('fps') ?? 30), clip.duration))
  }
  view.root.updateMatrixWorld(true)
  const box = new THREE.Box3()
  for (const m of view.meshes) box.union(new THREE.Box3().setFromObject(m, true))
  const zoom = Number(q.get('zoom') ?? 1)
  const at = Number(q.get('at') ?? 0.5)
  const centre = box.getCenter(new THREE.Vector3())
  if (zoom !== 1) centre.y = box.min.y + at * (box.max.y - box.min.y)
  const extent = Math.max(box.max.y - box.min.y, box.max.x - box.min.x, box.max.z - box.min.z) / zoom
  const name = q.get('view') ?? 'three'
  const dir = new THREE.Vector3(...(VIEWS[name] ?? (name.split(',').map(Number) as [number, number, number]))).normalize()
  const camera = new THREE.PerspectiveCamera(30, 1, h * 0.01, h * 200)
  camera.position.copy(centre).addScaledVector(dir, extent * 0.62 / Math.tan(THREE.MathUtils.degToRad(15)))
  camera.lookAt(centre)
  renderer.render(scene, camera)
}

shot().then(() => { document.title = 'DONE' }, (error: unknown) => { document.title = `FAILED: ${(error as Error).message}` })
