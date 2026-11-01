import * as THREE from 'three'

const stateKey = 'rigsmithMorphState'

interface MorphState {
  dictionary: Record<string, number>
  influences: number[]
  relative: boolean
}

function targetCount (geometry: THREE.BufferGeometry): number {
  const attributes = Object.values(geometry.morphAttributes)
  const count = attributes[0]?.length ?? 0
  if (attributes.some(targets => targets.length !== count)) throw new Error('Morph attribute target counts do not match')
  return count
}

function validateState (geometry: THREE.BufferGeometry, state: MorphState): void {
  const count = targetCount(geometry)
  if (state === null || typeof state !== 'object' || state.dictionary === null || typeof state.dictionary !== 'object' ||
    Array.isArray(state.dictionary) || !Array.isArray(state.influences) || state.influences.length !== count ||
    state.influences.some(weight => typeof weight !== 'number' || !Number.isFinite(weight)) ||
    typeof state.relative !== 'boolean' || state.relative !== geometry.morphTargetsRelative) {
    throw new Error('Morph state does not match geometry target count or mode')
  }
  const indices = Object.values(state.dictionary)
  if (indices.some(index => !Number.isInteger(index) || index < 0 || index >= count) || new Set(indices).size !== count) {
    throw new Error('Morph dictionary does not name every geometry target')
  }
}

function storedState (geometry: THREE.BufferGeometry): MorphState | undefined {
  const state = geometry.userData[stateKey] as MorphState | undefined
  if (state !== undefined) validateState(geometry, state)
  return state
}

function geometryState (geometry: THREE.BufferGeometry): MorphState {
  const stored = storedState(geometry)
  if (stored !== undefined) return stored
  const targets = Object.values(geometry.morphAttributes)[0] ?? []
  const state: MorphState = {
    dictionary: Object.fromEntries(targets.map((target, index) => [target.name || String(index), index])),
    influences: targets.map(() => 0),
    relative: geometry.morphTargetsRelative,
  }
  validateState(geometry, state)
  return state
}

function installState (geometry: THREE.BufferGeometry, state: MorphState): void {
  validateState(geometry, state)
  const copied: MorphState = {
    dictionary: { ...state.dictionary }, influences: [...state.influences], relative: state.relative,
  }
  // BufferGeometry.clone() shares userData in Three, so replace the container before changing private state.
  geometry.userData = { ...geometry.userData, [stateKey]: copied }
  const names = new Array<string>(state.influences.length)
  // The dictionary is authoritative for glTF: GLTFLoader does not name the target attributes. Keep any aliases
  // in the saved dictionary and use one deterministic name per target for Three's mesh reconstruction.
  for (const name of Object.keys(state.dictionary).sort()) names[state.dictionary[name]] ??= name
  for (const targets of Object.values(geometry.morphAttributes)) {
    for (let index = 0; index < targets.length; index++) targets[index].name = names[index]
  }
}

function clearState (geometry: THREE.BufferGeometry): void {
  if (!Object.hasOwn(geometry.userData, stateKey)) return
  geometry.userData = { ...geometry.userData }
  delete geometry.userData[stateKey]
}

/** Clone geometry while carrying the loaded mesh's logical target names and current default weights. */
export function cloneMorphGeometry (mesh: THREE.Mesh): THREE.BufferGeometry {
  const geometry = mesh.geometry.clone()
  if (targetCount(geometry) === 0) { clearState(geometry); return geometry }
  const fallback = geometryState(mesh.geometry)
  installState(geometry, {
    dictionary: mesh.morphTargetDictionary ?? fallback.dictionary,
    influences: mesh.morphTargetInfluences ?? fallback.influences,
    relative: mesh.geometry.morphTargetsRelative,
  })
  return geometry
}

/** Carry only the private morph state through a vertex remap; unrelated raw vertex extras must not follow. */
export function copyMorphState (from: THREE.BufferGeometry, to: THREE.BufferGeometry): THREE.BufferGeometry {
  if (targetCount(from) === 0 || targetCount(to) === 0) { clearState(to); return to }
  const state = storedState(from)
  if (state !== undefined) installState(to, state)
  else clearState(to)
  return to
}

/** Restore loaded defaults after constructing a Mesh or SkinnedMesh, whose constructor resets all weights. */
export function restoreMorphState<T extends THREE.Mesh> (mesh: T): T {
  if (targetCount(mesh.geometry) === 0) { clearState(mesh.geometry); return mesh }
  const state = storedState(mesh.geometry)
  if (state !== undefined) {
    installState(mesh.geometry, state)
    mesh.morphTargetDictionary = { ...state.dictionary }
    mesh.morphTargetInfluences = [...state.influences]
  }
  return mesh
}

/** A shared channel index must mean the same correction and default weight on every merged part. */
export function mergeMorphState (inputs: THREE.BufferGeometry[], output: THREE.BufferGeometry): THREE.BufferGeometry {
  if (inputs.length === 0) return output
  const counts = inputs.map(targetCount)
  if (counts.some(count => count !== counts[0])) throw new Error('Cannot merge different morph target counts')
  if (counts[0] === 0) {
    if (targetCount(output) !== 0) throw new Error('Merged morph target count does not match its parts')
    clearState(output)
    return output
  }
  const states = inputs.map(geometryState)
  const first = states[0]
  const names = Object.keys(first.dictionary)
  for (const state of states.slice(1)) {
    if (state.relative !== first.relative || state.influences.some((weight, index) => weight !== first.influences[index]) ||
      Object.keys(state.dictionary).length !== names.length || names.some(name => state.dictionary[name] !== first.dictionary[name])) {
      throw new Error('Cannot merge incompatible morph channels, default weights or modes')
    }
  }
  if (targetCount(output) !== counts[0]) throw new Error('Merged morph target count does not match its parts')
  // mergeGeometries validates the input mode but currently leaves the output at its default false.
  output.morphTargetsRelative = first.relative
  installState(output, first)
  return output
}
