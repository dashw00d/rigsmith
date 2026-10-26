<script lang="ts">
  // The Rig step's marker board: the model drawn flat (front for a person, side for a four-legged body), a few
  // coloured markers on it (static/templates/markers.json), the skeleton they give drawn live as you drag
  // (src/engine/markers.ts). A marker's depth comes from the mesh: the middle of the body where it sits (a pair on
  // a side view: the near leg, mirrored onto the far one). Finger tips go on a view of each hand of their own (its
  // back, along the fingers, cut to the hand). Letting go saves the markers and the joints.
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
  const key = new THREE.DirectionalLight(0xffffff, 1.4)

  const keys = $derived(keysOf(set))
  const hasHands = $derived(set.markers.some(d => d.view === 'hand') && keys.some(k => k.def.view === 'hand' && character.joints?.[`${k.side === 'right' ? 'Right' : 'Left'}HandIndex1`] !== undefined))
  // the markers this view shows: the body's, or one hand's finger tips
  const shown = $derived(keys.filter(k => markerBoard.view === 'body' ? k.def.view !== 'hand' : k.def.view === 'hand' && k.side === markerBoard.view))
  const handPrefix = $derived(markerBoard.view === 'right' ? 'Right' : 'Left')

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
    scene.add(key, key.target)
  }

  /** A hand's view: from the back of the hand (away from the body), the fingers up, cut to a slab around the hand. */
  function handView (prefix: string): { center: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3, size: number } | null {
    const J = Object.keys(joints).length > 0 ? joints : character.joints as Record<string, V3> | undefined
    const at = (n: string): THREE.Vector3 | null => J?.[`${prefix}${n}`] !== undefined ? new THREE.Vector3(...J[`${prefix}${n}`]) : null
    const wrist = at('Hand'); const tip = at('HandMiddle4') ?? at('HandIndex4')
    if (wrist === null || tip === null) return null
    const up = tip.clone().sub(wrist)
    const length = up.length()
    up.normalize()
    const a = at('HandIndex1'); const b = at('HandPinky1') ?? at('HandThumb1')
    const across = a !== null && b !== null ? a.clone().sub(b) : new THREE.Vector3(1, 0, 0)
    across.addScaledVector(up, -across.dot(up)).normalize()
    const normal = new THREE.Vector3().crossVectors(across, up).normalize()
    // (looking at its back: from out beside the body)
    const out = wrist.clone().sub(box.getCenter(new THREE.Vector3())); out.y = 0
    if (normal.dot(out) < 0) normal.negate()
    return { center: wrist.clone().lerp(tip, 0.5), normal, up, size: length }
  }

  function place (): void {
    if (width === 0 || height === 0) return
    const aspect = width / height
    const hand = markerBoard.view === 'body' ? null : handView(handPrefix)
    if (hand !== null) {
      const half = Math.max(hand.size * 0.68, hand.size * 0.68 / aspect)
      camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half
      const d = hand.size * 3
      camera.position.copy(hand.center).addScaledVector(hand.normal, d)
      camera.up.copy(hand.up)
      // (a slab around the hand: the leg beside it neither shows nor takes the rays)
      camera.near = d - hand.size * 0.4; camera.far = d + hand.size * 0.4
      camera.lookAt(hand.center)
      key.position.copy(hand.center).addScaledVector(hand.normal, 2).addScaledVector(hand.up, 1)
      key.target.position.copy(hand.center)
    } else {
      placeBody(aspect)
    }
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    renderer?.setSize(width, height, false)
    renderer?.render(scene, camera)
    frame++
  }

  function placeBody (aspect: number): void {
    const c = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const across = set.view === 'front' ? size.x : size.z
    const half = Math.max(size.y / 2, across / 2 / aspect) * 1.12
    camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half
    const far = size.length() * 2 + 1
    if (set.view === 'front') camera.position.set(c.x, c.y, box.max.z + far)
    else camera.position.set(box.max.x + far, c.y, c.z)
    camera.near = 0.001; camera.far = far * 3
    camera.up.set(0, 1, 0)
    camera.lookAt(c.x, c.y, c.z)
    key.position.set(c.x + (set.view === 'front' ? 0.6 : 3), c.y + 2, c.z + (set.view === 'front' ? 3 : 0.6))
    key.target.position.copy(c)
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
    ray.near = 0; ray.far = camera.far - camera.near
    const hits = ray.intersectObjects(meshes, false).map(h => h.distance)
    ray.far = Infinity
    const along = insideDepth(hits)
    const origin = ray.ray.origin; const dir = ray.ray.direction
    const on = along !== null ? origin.clone().addScaledVector(dir, along) : null
    let p: V3
    if (markerBoard.view !== 'body') {
      // a finger tip: in the middle of the finger under it, else as deep as it was
      const q = on ?? origin.clone().addScaledVector(dir, keep !== undefined ? new THREE.Vector3(...keep).sub(origin).dot(dir) : (camera.far - camera.near) / 2)
      p = [q.x, q.y, q.z]
    } else if (set.view === 'front') {
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

  let ro: ResizeObserver | null = null
  onMount(async () => {
    // (the spinner shows before the board is built: building it takes a moment on a big mesh)
    markerBoard.busy = 'Placing markers'
    await new Promise(r => setTimeout(r, 30))
    try {
      setUp()
    } catch (error) {
      app.toast('error', `The markers didn't open: ${(error as Error).message}`)
    } finally {
      markerBoard.busy = null
    }
  })

  function setUp (): void {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    build()
    const saved = character.markers
    const base = character.joints as Record<string, V3> | undefined
    // the character's own markers if they still belong to its skeleton, else seeded from its joints
    // (a plain copy: the character's own is the app's live state, which can't be cloned as it is)
    if (saved !== undefined && saved.set === setName && base !== undefined && Object.keys(base).every(k => saved.base[k] !== undefined)) markers = $state.snapshot(saved) as Markers
    else if (base !== undefined) markers = seed(setName, set, base, seedOwn)
    const fit = (): void => { width = host.clientWidth; height = host.clientHeight; place() }
    ro = new ResizeObserver(fit)
    ro.observe(host)
    fit()
    solveNow()
  }
  onDestroy(() => {
    ro?.disconnect()
    markerBoard.busy = null
    renderer?.dispose()
    for (const m of meshes) m.geometry.dispose()
  })

  /** A marker's name as the tooltip gives it: what it marks, and which side ("Elbow · right (A)", "Front knee"). */
  function nameOf (k: { def: MarkerDef, side: 'left' | 'right' | null }): string {
    const what = k.def.letter === 'F' ? `Front ${k.def.label.toLowerCase()}` : k.def.letter === 'H' ? `Hind ${k.def.label.toLowerCase()}` : k.def.label.replace(/s$/, '')
    if (!k.def.pair) return what
    if (set.view === 'front') return `${what} · ${k.side === 'right' ? 'right (A)' : 'left (B)'}`
    return `${what} · near ${k.def.letter !== undefined ? 'leg' : 'side'} (the far one mirrored)`
  }
  let hovered = $state<string | null>(null)
  let dragKey = $state<string | null>(null)

  function down (e: PointerEvent, key: string): void {
    dragging = key
    dragKey = key
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
    dragKey = null
    solveNow()
    markerBoard.busy = 'Saving the markers'
    try {
      await app.update(character.id, { markers: $state.snapshot(markers), joints: $state.snapshot(joints), jointsEdited: true })
    } finally {
      markerBoard.busy = null
    }
  }

  // the skeleton as lines: each bone from its parent (on a hand's view, that hand's alone)
  // (not a creature's root: it sits on the ground under the body, holding it, not a bone of it)
  const inView = (name: string): boolean => markerBoard.view === 'body' || name.startsWith(`${handPrefix}Hand`)
  const bones = $derived(Object.entries(parents).flatMap(([c, p]) => p !== null && p !== 'root' && inView(c) && joints[c] !== undefined && joints[p] !== undefined ? [[joints[p], joints[c]] as [V3, V3]] : []))
  $effect(() => { void markerBoard.view; place() })
  const near = (p: V3): boolean => set.view === 'front' || p[0] >= xCenter - 1e-4
</script>

<div class="board" bind:this={host} onpointermove={move} onpointerup={up} role="application" aria-label="Rig markers">
  <canvas bind:this={canvas}></canvas>
  <svg {width} {height}>
    {#each bones as [a, b]}
      {@const pa = toScreen(a)}{@const pb = toScreen(b)}
      <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} class:far={!near(a) || !near(b)} />
    {/each}
    {#each Object.entries(joints).filter(([k]) => k !== 'root' && inView(k)).map(([, j]) => j) as j}
      {@const p = toScreen(j)}
      <circle cx={p.x} cy={p.y} r="2.5" class="joint" class:far={!near(j)} />
    {/each}
    {#if markers !== null}
      {#each shown as k (k.key)}
        {@const at = markers.positions[k.key]}
        {#if at !== undefined}
          {@const p = toScreen(at)}
          <g class="marker" class:on={markerBoard.selected === k.def.id} transform="translate({p.x},{p.y})" onpointerdown={(e) => down(e, k.key)} onpointerenter={() => { hovered = k.key }} onpointerleave={() => { if (hovered === k.key) hovered = null }} role="button" tabindex="-1" aria-label={nameOf(k)}>
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
  {#if markers !== null && (hovered ?? dragKey) !== null}
    {@const k = keys.find(x => x.key === (hovered ?? dragKey))}
    {@const at = k === undefined ? undefined : markers.positions[k.key]}
    {#if k !== undefined && at !== undefined}
      {@const p = toScreen(at)}
      <div class="tip" style="transform: translate({p.x}px, {p.y - 22}px)"><span class="dot" style="background: {k.def.color}"></span>{nameOf(k)}</div>
    {/if}
  {/if}
  {#if hasHands}
    <div class="tabs">
      {#each [['body', 'Body'], ['right', 'Right hand (A)'], ['left', 'Left hand (B)']] as [v, label]}
        <button class:on={markerBoard.view === v} onclick={() => { markerBoard.view = v as 'body' | 'right' | 'left' }}>{label}</button>
      {/each}
    </div>
  {/if}
  <div class="hint">{markerBoard.view === 'body' ? `Drag each marker onto its joint${set.view === 'side' ? ' (the near legs: the far ones follow)' : ''}.` : `Drag each letter onto the very end of its finger${markerBoard.mirror ? ' (the other hand follows, mirrored)' : ''}.`} The skeleton follows; letting go saves it.</div>
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
  .tip { position: absolute; left: 0; top: 0; translate: -50% -100%; display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px; background: rgb(12 14 18 / 92%); border: 1px solid var(--line-strong); color: var(--text-1); font-size: 12px; white-space: nowrap; pointer-events: none; z-index: 2; }
  .tip .dot { width: 8px; height: 8px; border-radius: 50%; }
  .marker text { font-size: 11px; font-weight: 700; text-anchor: middle; fill: #111; pointer-events: none; }
  .hint { position: absolute; left: 14px; bottom: 12px; font-size: 12px; color: var(--text-3); pointer-events: none; }
  .tabs { position: absolute; top: 10px; left: 10px; display: flex; gap: 4px; }
  .tabs button { height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); font-size: 12px; }
  .tabs button.on { border-color: var(--accent); color: var(--accent-strong); }
  .close { position: absolute; top: 10px; right: 10px; width: 30px; height: 30px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); display: grid; place-items: center; }
</style>
