// One lighting rig for every picture of a character: the viewport (Stage), the offscreen pictures (list thumbnails,
// library card sprites) and any other scene that shows the character (the marker board, the scale room). The same
// sky and ground fill, warm key, cool rim, room reflections and exposure everywhere, so a thumbnail looks like the
// viewport and a change to the light is made once.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

export const LIGHTING = {
  /** AgX tone mapping's exposure. */
  exposure: 1.1,
  /** How strongly the room's reflections light the scene. */
  environment: 0.55,
  hemisphere: { sky: 0xd4dcff, ground: 0x1a1c22, intensity: 0.9 },
  /** Positions are for a subject about 1 tall; place() scales them to the subject. */
  key: { color: 0xfff4e8, intensity: 2.2, position: [2.5, 4, 3] as const },
  rim: { color: 0x8ea2ff, intensity: 1.4, position: [-3, 2.5, -4] as const },
}

export interface LightRig {
  hemisphere: THREE.HemisphereLight
  key: THREE.DirectionalLight
  rim: THREE.DirectionalLight
}

/** The renderer's output as the viewport's: sRGB, AgX at the rig's exposure. */
export function tone (renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.AgXToneMapping
  renderer.toneMappingExposure = LIGHTING.exposure
}

// (an environment map belongs to the WebGL context it was made in: one per renderer, made once)
const environments = new WeakMap<THREE.WebGLRenderer, THREE.Texture>()

/** The room's reflections, made for this renderer. */
export function environment (renderer: THREE.WebGLRenderer): THREE.Texture {
  let texture = environments.get(renderer)
  if (texture === undefined) {
    const pmrem = new THREE.PMREMGenerator(renderer)
    texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    environments.set(renderer, texture)
  }
  return texture
}

/** The rig added to `scene` (with the room's reflections when the renderer that draws it is given). `shadows`: the
 * key light casts them (the viewport's ground catches them). */
export function light (scene: THREE.Scene, renderer?: THREE.WebGLRenderer, o: { shadows?: boolean } = {}): LightRig {
  if (renderer !== undefined) {
    scene.environment = environment(renderer)
    scene.environmentIntensity = LIGHTING.environment
  }
  const { hemisphere: h, key: k, rim: r } = LIGHTING
  const hemisphere = new THREE.HemisphereLight(h.sky, h.ground, h.intensity)
  const key = new THREE.DirectionalLight(k.color, k.intensity)
  key.position.set(...k.position)
  if (o.shadows === true) {
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.bias = -0.0004
    key.shadow.radius = 4
  }
  const rim = new THREE.DirectionalLight(r.color, r.intensity)
  rim.position.set(...r.position)
  scene.add(hemisphere, key, key.target, rim)
  return { hemisphere, key, rim }
}

/** The lights placed for a subject `height` tall standing at the origin (they keep their angles). */
export function place (rig: LightRig, height: number): void {
  rig.key.position.set(...LIGHTING.key.position).multiplyScalar(height)
  rig.rim.position.set(...LIGHTING.rim.position).multiplyScalar(height)
}
