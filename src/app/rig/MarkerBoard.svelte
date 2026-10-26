<script lang="ts">
  // The Rig step's marker board: the model drawn flat (front for a person, side for a four-legged body), a few
  // coloured markers on it (static/templates/markers.json), the skeleton they give drawn live as you drag
  // (src/engine/markers.ts). A marker's depth comes from the mesh: the middle of the body where it sits (a pair on
  // a side view: the near leg, mirrored onto the far one). Letting go saves the markers and the joints.
  import { onDestroy, onMount } from 'svelte'
  import * as THREE from 'three'
  import { X } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import type { CharacterView } from '../../engine/CharacterView.ts'
  import { insideDepth, jointsFrom, keysOf, mirrorX, seed, type MarkerDef, type Markers, type MarkerSet, type V3 } from '../../engine/markers.ts'
  import { markerBoard } from '../../state/markers.svelte.ts'

  let { character, view, set, setName, parents }: { character: Character, view: CharacterView, set: MarkerSet, setName: string, parents: Record<string, string | null> } = $props()

  let host: HTMLDivElement
  let canvas: HTMLCanvasElement
  let width = $state(0)
  let height = $state(0)
  let renderer: THREE.WebGLRenderer | null = null
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 100)
  const ray = new THREE.Raycaster()
  const meshes: THREE.Mesh[] = []
  const box = new THREE.Box3()
  let xCenter = 0
  let markers = $state<Markers | null>(null)
  let joints = $state<Record<string, V3>>({})
  let dragging: string | null = null
  let frame = $state(0)   // (bumped when the camera changes: the overlay re-projects)

  const keys = $derived(keysOf(set))

  function build (): void {
    const toLocal = new THREE.Matrix4().copy(view.root.matrixWorld).invert()
    const clay = new THREE.MeshStandardMaterial({ color: 0xd8d8dd, roughness: 0.92, metalness: 0, side: THREE.DoubleSide })
    view.root.updateMatrixWorld(true)
    for (const m of view.meshes) {
      // (at rest: a skinned body's bind shape, else the mesh as it lies)
      const g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, m.matrixWorld))
      const mesh = new THREE.Mesh(g, clay)
      scene.add(mesh)
      meshes.push(mesh)
      g.computeBoundingBox()
      box.union(g.boundingBox!)
    }
    xCenter = 0.5 * (box.min.x + box.max.x)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3d46, 1.6))
    const key = new THREE.DirectionalLight(0xffffff, 1.4)
    key.position.set(set.view === 'front' ? 0.6 : 3, 2, set.view === 'front' ? 3 : 0.6)
    scene.add(key)
  }

  function place (): void {
    if (width === 0 || height === 0) return
    const c = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const across = set.view === 'front' ? size.x : size.z
    const aspect = width / height
    const half = Math.max(size.y / 2, across / 2 / aspect) * 1.12
    camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half
    const far = size.length() * 2 + 1
    if (set.view === 'front') camera.position.set(c.x, c.y, box.max.z + far)
    else camera.position.set(box.max.x + far, c.y, c.z)
    camera.near = 0.001; camera.far = far * 3
    camera.lookAt(c.x, c.y, c.z)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    renderer?.setSize(width, height, false)
    renderer?.render(scene, camera)
    frame++
  }

  const toScreen = (p: V3): { x: number, y: number } => {
    void frame
    const v = new THREE.Vector3(...p).project(camera)
    return { x: (v.x + 1) / 2 * width, y: (1 - v.y) / 2 * height }
  }

  /** The point in the body under a screen point, for a marker: its depth from the mesh (or `keep`'s). */
  function toBody (x: number, y: number, def: MarkerDef, keep: V3 | undefined): V3 {
    const ndc = new THREE.Vector2(x / width * 2 - 1, 1 - y / height * 2)
    ray.setFromCamera(ndc, camera)
    const hits = ray.intersectObjects(meshes, false).map(h => h.distance)
    const along = insideDepth(hits)
    const origin = ray.ray.origin; const dir = ray.ray.direction
    const on = along !== null ? origin.clone().addScaledVector(dir, along) : null
    let p: V3
    if (set.view === 'front') {
      const flat = origin.clone()
      p = [flat.x, flat.y, on?.z ?? keep?.[2] ?? 0]
      if (def.mid) p[0] = xCenter
    } else {
      // a pair on the side view takes its depth from the mesh where the ray crosses a limb (a leg below the body),
      // else (through the chest, the shoulder) it keeps its own way out from the middle
      const limb = hits.length >= 2 && hits[1] - hits[0] < 0.45 * (box.max.x - box.min.x)
      p = [limb && on !== null ? on.x : keep?.[0] ?? xCenter, origin.y, origin.z]
      if (def.mid) p[0] = xCenter
      // (a pair goes on the near side, its left: a far leg hit where the near one isn't counts mirrored)
      else if (p[0] < xCenter) p[0] = 2 * xCenter - p[0]
    }
    return p.map(v => Math.round(v * 1e5) / 1e5) as V3
  }

  /** The groin (a marker of its own) under the body: straight up from the ground between the legs. */
  function seedOwn (def: MarkerDef): V3 | null {
    if (def.id !== 'groin') return null
    const hips = character.joints?.Hips
    if (hips === undefined) return null
    ray.set(new THREE.Vector3(xCenter, box.min.y - 0.01, hips[2]), new THREE.Vector3(0, 1, 0))
    const hit = ray.intersectObjects(meshes, false)[0]
    return hit !== undefined && hit.point.y < hips[1] ? [xCenter, hit.point.y, hips[2]] : null
  }

  function solveNow (): void {
    if (markers === null) return
    joints = jointsFrom(set, markers, parents, xCenter)
  }

  onMount(() => {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    build()
    const saved = character.markers
    const base = character.joints as Record<string, V3> | undefined
    // the character's own markers if they still belong to its skeleton, else seeded from its joints
    if (saved !== undefined && saved.set === setName && base !== undefined && Object.keys(base).every(k => saved.base[k] !== undefined)) markers = structuredClone(saved) as Markers
    else if (base !== undefined) markers = seed(setName, set, base, seedOwn)
    const fit = (): void => { width = host.clientWidth; height = host.clientHeight; place() }
    const ro = new ResizeObserver(fit)
    ro.observe(host)
    fit()
    solveNow()
    return () => ro.disconnect()
  })
  onDestroy(() => {
    renderer?.dispose()
    for (const m of meshes) m.geometry.dispose()
  })

  function down (e: PointerEvent, key: string): void {
    dragging = key
    markerBoard.selected = key.replace(/_[lr]$/, '')
    try { (e.target as Element).setPointerCapture(e.pointerId) } catch { /* (a pointer that can't be captured still drags over the board) */ }
    e.preventDefault()
  }
  function move (e: PointerEvent): void {
    if (dragging === null || markers === null) return
    const k = keys.find(x => x.key === dragging)
    if (k === undefined) return
    const r = host.getBoundingClientRect()
    const p = toBody(e.clientX - r.left, e.clientY - r.top, k.def, markers.positions[k.key])
    markers.positions[k.key] = p
    // (a pair on a front view: the other side follows, mirrored)
    if (k.def.pair && set.view === 'front' && markerBoard.mirror) {
      const other = k.key.endsWith('_l') ? `${k.def.id}_r` : `${k.def.id}_l`
      if (markers.positions[other] !== undefined) markers.positions[other] = mirrorX(p, xCenter)
    }
    solveNow()
  }
  async function up (): Promise<void> {
    if (dragging === null || markers === null) return
    dragging = null
    solveNow()
    await app.update(character.id, { markers: $state.snapshot(markers), joints: $state.snapshot(joints), jointsEdited: true })
  }

  // the skeleton as lines: each bone from its parent
  // (not a creature's root: it sits on the ground under the body, holding it, not a bone of it)
  const bones = $derived(Object.entries(parents).flatMap(([c, p]) => p !== null && p !== 'root' && joints[c] !== undefined && joints[p] !== undefined ? [[joints[p], joints[c]] as [V3, V3]] : []))
  const near = (p: V3): boolean => set.view === 'front' || p[0] >= xCenter - 1e-4
</script>

<div class="board" bind:this={host} onpointermove={move} onpointerup={up} role="application" aria-label="Rig markers">
  <canvas bind:this={canvas}></canvas>
  <svg {width} {height}>
    {#each bones as [a, b]}
      {@const pa = toScreen(a)}{@const pb = toScreen(b)}
      <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} class:far={!near(a) || !near(b)} />
    {/each}
    {#each Object.entries(joints).filter(([k]) => k !== 'root').map(([, j]) => j) as j}
      {@const p = toScreen(j)}
      <circle cx={p.x} cy={p.y} r="2.5" class="joint" class:far={!near(j)} />
    {/each}
    {#if markers !== null}
      {#each keys as k (k.key)}
        {@const at = markers.positions[k.key]}
        {#if at !== undefined}
          {@const p = toScreen(at)}
          <g class="marker" class:on={markerBoard.selected === k.def.id} transform="translate({p.x},{p.y})" onpointerdown={(e) => down(e, k.key)} role="button" tabindex="-1" aria-label={k.def.label}>
            <circle r="13" class="halo" style="stroke: {k.def.color}" />
            <circle r="9" style="fill: {k.def.color}" class="dot" />
            {#if k.def.letter ?? (k.def.pair && set.view === 'front')}
              <text dy="4">{k.def.letter ?? (k.side === 'right' ? 'A' : 'B')}</text>
            {/if}
          </g>
        {/if}
      {/each}
    {/if}
  </svg>
  <div class="hint">Drag each marker onto its joint{set.view === 'side' ? ' (the near legs: the far ones follow)' : ''}. The skeleton follows; letting go saves it.</div>
  <button class="close" onclick={() => { markerBoard.open = false }} aria-label="Close markers"><X size={16} /></button>
</div>

<style>
  .board { position: absolute; inset: 0; z-index: 5; background: #1d1f24; touch-action: none; }
  canvas, svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  line { stroke: rgb(142 162 255 / 85%); stroke-width: 2; }
  line.far { stroke: rgb(142 162 255 / 30%); stroke-dasharray: 3 3; }
  .joint { fill: #8ea2ff; }
  .joint.far { fill: rgb(142 162 255 / 35%); }
  .marker { cursor: grab; }
  .marker .halo { fill: rgb(0 0 0 / 25%); stroke-width: 2; opacity: 0.9; }
  .marker .dot { stroke: rgb(0 0 0 / 45%); stroke-width: 1; }
  .marker.on .halo { stroke-width: 3.5; }
  .marker text { font-size: 11px; font-weight: 700; text-anchor: middle; fill: #111; pointer-events: none; }
  .hint { position: absolute; left: 14px; bottom: 12px; font-size: 12px; color: var(--text-3); pointer-events: none; }
  .close { position: absolute; top: 10px; right: 10px; width: 30px; height: 30px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); display: grid; place-items: center; }
</style>
