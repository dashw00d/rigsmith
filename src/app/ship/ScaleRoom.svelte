<script lang="ts">
  // The scale room: the character at the height it plays at, among the game's own models as the game draws them (its
  // units at the game's unit scale, buildings and props as modelled), to set its height by eye. Saving the height
  // changes Rigsmith's unit only; the game gets it on Export. The game's files are read, never written. Drawn over the
  // viewport (a covering overlay: the stage rests meanwhile) with its own renderer and the viewport's lighting.
  import { onDestroy, onMount, untrack } from 'svelte'
  import * as THREE from 'three'
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
  import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
  import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
  import { X } from '@lucide/svelte'
  import { api, type GameModels } from '../../state/api.ts'
  import { scaleRoom } from '../../state/scaleroom.svelte.ts'
  import { ship } from '../../state/ship.svelte.ts'
  import type { CharacterView } from '../../engine/CharacterView.ts'
  import { SWAPPED } from '../../engine/contract.ts'
  import { light, tone } from '../../engine/lighting.ts'
  import Button from '../../ui/Button.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import NumberField from '../../ui/NumberField.svelte'

  let { view, unit, companion }: { view: CharacterView, unit: string, companion: boolean } = $props()

  // (the units the room starts with beside it: the player's familiar ones)
  const BESIDE = ['warrior', 'spearman', 'archer', 'villager', 'raider', 'caravan', 'bearguard']

  let host: HTMLDivElement
  let canvas: HTMLCanvasElement
  let renderer: THREE.WebGLRenderer | null = null
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 500)
  let controls: OrbitControls | null = null
  const loader = new GLTFLoader()
  let models = $state<GameModels | null>(null)
  let failed = $state<string | null>(null)
  const spec = $derived(ship.spec(unit))
  const saved = $derived(companion ? spec?.companion?.height ?? 2 : spec?.height ?? 2)
  let height = $state(untrack(() => saved))
  let ro: ResizeObserver | null = null
  let me: THREE.Object3D | null = null
  let shown = $state<string[]>([])
  let extra = $state<string[]>([])
  let labels = $state<Array<{ name: string, x: number, y: number, h: number, me?: boolean }>>([])
  const placed = new Map<string, { root: THREE.Object3D, height: number }>()
  const clay = (hex: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.9 })

  // (the other units, not the siege crews)
  const others = $derived(models === null ? [] : models.units.filter(u => u !== unit && !/^siege_/.test(u)))

  async function load (kind: string, name: string): Promise<THREE.Object3D> {
    const g = await loader.loadAsync(`/api/game/models/${kind}/${name}.glb`)
    const root = g.scene
    root.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh !== true) return
      // (one level of detail, and one of the parts the game swaps in by job or look: the body's own head stays)
      if (/_LOD\d/.test(m.name) || (SWAPPED.test(m.name) && !/^HeadBald/.test(m.name))) { m.visible = false; return }
      m.material = clay(kind === 'units' ? 0xb9bcc6 : kind === 'buildings' ? 0x8d7b68 : 0x7d9070)
      m.castShadow = true
      m.frustumCulled = false
    })
    return root
  }

  /** The bounds of what shows (each mesh as bound, before a pose): not the hidden levels and spare parts; a unit's
   * body alone where it has one (the mesh named for it: its weapons and tools don't count to its height). */
  function visibleBox (root: THREE.Object3D, body?: string): THREE.Box3 {
    root.updateMatrixWorld(true)
    const box = new THREE.Box3()
    const named = body !== undefined && root.getObjectByName(body) !== undefined
    root.traverse(o => {
      const m = o as THREE.Mesh
      // (with the head it wears: the villager's is split off to swap)
      if (m.isMesh !== true || !m.visible || (named && m.name !== body && !/^HeadBald/.test(m.name))) return
      let up: THREE.Object3D | null = m.parent; let hidden = false
      while (up !== null) { if (!up.visible) { hidden = true; break } up = up.parent }
      if (hidden) return
      if (m.geometry.boundingBox === null) m.geometry.computeBoundingBox()
      box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld))
    })
    return box
  }

  function layout (): void {
    // the character in the middle; the units in a row both sides; buildings and props behind
    const row = shown.map(n => placed.get(`units/${n}`)).filter(x => x !== undefined)
    let left = -1.6; let right = 1.6
    row.forEach((p, i) => {
      const w = 1.4
      if (i % 2 === 0) { p.root.position.set(right, 0, 0); right += w } else { p.root.position.set(left, 0, 0); left -= w }
    })
    let back = -4
    for (const n of extra) {
      const p = placed.get(n)
      if (p === undefined) continue
      const size = visibleBox(p.root).getSize(new THREE.Vector3())
      p.root.position.set(back + size.x / 2, 0, -3 - size.z / 2)
      back += size.x + 1
    }
  }

  function fitMe (): void {
    if (me === null || models === null) return
    // its game height, drawn at the game's unit scale (as every unit beside it)
    const s = height / view.height * models.visualScale
    me.scale.setScalar(s)
    me.position.set(0, -view.box.min.y * s, 0)
  }

  async function sync (): Promise<void> {
    if (models === null) return
    for (const n of shown) {
      const key = `units/${n}`
      if (placed.has(key)) continue
      const root = await load('units', n)
      root.scale.setScalar(models.visualScale)
      scene.add(root)
      const b = visibleBox(root, n)
      placed.set(key, { root, height: (b.max.y - b.min.y) / models.visualScale })
    }
    for (const key of extra) {
      if (placed.has(key)) continue
      const [kind, name] = key.split('/')
      const root = await load(kind, name)
      scene.add(root)
      const b = visibleBox(root)
      placed.set(key, { root, height: b.max.y - b.min.y })
    }
    for (const [key, p] of placed) p.root.visible = (key.startsWith('units/') && shown.includes(key.slice(6))) || extra.includes(key)
    layout()
    render()
  }

  // (drawn when something changes, not every frame: nothing moves here but the camera)
  function render (): void {
    if (renderer === null) return
    renderer.render(scene, camera)
    const w = canvas.clientWidth; const h = canvas.clientHeight
    const label = (root: THREE.Object3D, name: string, hh: number, mine = false): { name: string, x: number, y: number, h: number, me?: boolean } => {
      const b = visibleBox(root)
      const p = new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2).project(camera)
      return { name, x: (p.x + 1) / 2 * w, y: (1 - p.y) / 2 * h - 14, h: hh, me: mine }
    }
    const out = [...placed.entries()].filter(([, p]) => p.root.visible).map(([k, p]) => label(p.root, k.split('/')[1], p.height))
    if (me !== null) out.push(label(me, unit + (companion ? ' (its companion)' : ''), height, true))
    labels = out
  }

  async function loading (what: string, run: () => Promise<void>): Promise<void> {
    scaleRoom.setBusy(what)
    try { await run() } catch (error) { failed = (error as Error).message } finally { scaleRoom.setBusy(null) }
  }

  onMount(() => {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    tone(renderer)
    scene.background = new THREE.Color(0x1d2027)
    const rig = light(scene, renderer, { shadows: true })
    // (the light from far enough over a row of units and the buildings behind them to shade them all)
    rig.key.position.set(4, 8, 6)
    const sh = rig.key.shadow.camera
    sh.left = -15; sh.right = 15; sh.top = 15; sh.bottom = -15; sh.far = 60
    sh.updateProjectionMatrix()
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), clay(0x3b4049)); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true
    scene.add(ground)
    const grid = new THREE.GridHelper(80, 80, 0x555b66, 0x454a54); (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.35
    scene.add(grid)
    camera.position.set(0, 2.6, 7.5)
    controls = new OrbitControls(camera, canvas)
    controls.target.set(0, 1, 0)
    controls.update()
    controls.addEventListener('change', render)
    const fit = (): void => { const w = host.clientWidth; const h = host.clientHeight; renderer?.setSize(w, h, false); camera.aspect = w / Math.max(h, 1); camera.updateProjectionMatrix(); render() }
    ro = new ResizeObserver(fit); ro.observe(host); fit()
    // the character as it stands now (a copy: the one on stage is left alone)
    me = cloneSkinned(view.root)
    me.position.set(0, 0, 0); me.quaternion.identity()
    me.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh === true) { m.castShadow = true; m.frustumCulled = false } })
    scene.add(me)
    void loading("Loading the game's units", async () => {
      models = await api.gameModels()
      shown = others.filter(u => BESIDE.includes(u))
      fitMe()
      await sync()
    })
    render()
  })
  onDestroy(() => {
    scaleRoom.setBusy(null)
    ro?.disconnect()
    controls?.dispose()
    scene.traverse(o => {
      const m = o as THREE.Mesh
      // (the copy of the character shares the stage's geometry and textures: only what this room made goes)
      if (m.isMesh === true && !isMine(m)) m.geometry.dispose()
    })
    renderer?.dispose()
  })
  function isMine (o: THREE.Object3D): boolean {
    let up: THREE.Object3D | null = o
    while (up !== null) { if (up === me) return true; up = up.parent }
    return false
  }

  // (on a change of height only: the drawing writes its labels, so it runs untracked)
  $effect(() => { void height; untrack(() => { fitMe(); render() }) })

  function toggleUnit (u: string): void { shown = shown.includes(u) ? shown.filter(x => x !== u) : [...shown, u]; void loading(`Loading ${u}`, sync) }
  function addExtra (key: string): void { if (key === '' || extra.includes(key)) return; extra = [...extra, key]; void loading(`Loading ${key.split('/')[1]}`, sync) }
  async function save (): Promise<void> {
    const h = Math.round(height * 100) / 100
    if (spec === null) return
    const done = companion && spec.companion !== undefined
      ? await ship.patch(unit, { companion: { ...spec.companion, height: h } })
      : await ship.patch(unit, { height: h })
    if (done) height = h
  }
  function onkeydown (event: KeyboardEvent): void {
    if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement)) scaleRoom.close()
  }
</script>

<svelte:window {onkeydown} />

<div class="room" bind:this={host}>
  <canvas bind:this={canvas}></canvas>
  {#each labels as l}
    <div class="label" class:me={l.me} style="transform: translate({l.x}px, {l.y}px)">{l.name} <span>{l.h.toFixed(2)}</span></div>
  {/each}
  <div class="panel">
    <strong>{unit}{companion ? ' · its companion' : ''}</strong>
    <div class="height">
      <span>Height</span>
      <input type="range" min="0.5" max="4" step="0.01" bind:value={height} aria-label="Height" />
      <NumberField value={height} onchange={(v) => { height = v }} min={0.3} max={10} step={0.05} digits={2} label="Height" size="sm" width="64px" />
    </div>
    <div class="row">
      <Button size="sm" variant="primary" disabled={spec === null || Math.abs(height - saved) < 1e-6} onclick={save}>Save height</Button>
      <Button size="sm" variant="ghost" disabled={Math.abs(height - saved) < 1e-6} onclick={() => { height = saved }}>Back to {saved}</Button>
    </div>
    <p class="faint">Units as the game draws them (×{models?.visualScale ?? 1}); buildings and props as modelled. Saving changes
      Rigsmith's unit; the game gets it on Export.</p>
    {#if failed !== null}<p class="error">{failed}</p>{/if}
    {#if scaleRoom.busy !== null}<p class="faint">{scaleRoom.busy}…</p>{/if}
    {#if models !== null}
      <div class="chips" aria-label="Units beside it">
        {#each others as u (u)}<button class:on={shown.includes(u)} aria-pressed={shown.includes(u)} onclick={() => toggleUnit(u)}>{u}</button>{/each}
      </div>
      <select aria-label="Add a building or prop" onchange={(e) => { addExtra((e.target as HTMLSelectElement).value); (e.target as HTMLSelectElement).value = '' }}>
        <option value="">+ a building or prop…</option>
        <optgroup label="Buildings">{#each models.buildings as b}<option value="buildings/{b}">{b}</option>{/each}</optgroup>
        <optgroup label="Props">{#each models.props as p}<option value="props/{p}">{p}</option>{/each}</optgroup>
      </select>
    {/if}
  </div>
  <div class="close"><IconButton label="Close the scale room" hint="Close (Esc)" variant="secondary" onclick={() => scaleRoom.close()}><X size={16} /></IconButton></div>
</div>

<style>
  .room { position: absolute; inset: 0; z-index: 6; background: #1d2027; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .label { position: absolute; left: 0; top: 0; font-size: 11px; color: var(--text-2); white-space: nowrap; pointer-events: none; translate: -50% -100%; }
  .label span { color: var(--text-4); }
  .label.me { color: var(--accent-strong); font-weight: 600; }
  .panel { position: absolute; left: 12px; top: 12px; width: 300px; display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: var(--r-2); background: rgb(20 22 28 / 88%); border: 1px solid var(--line-strong); font-size: 12px; color: var(--text-2); }
  .height { display: flex; align-items: center; gap: 8px; }
  .height input[type=range] { flex: 1; }
  .row { display: flex; gap: 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chips button, select { height: 24px; padding: 0 8px; border-radius: 12px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); font-size: 11px; }
  select { border-radius: var(--r-1); height: 26px; font-size: 12px; }
  .chips button.on { border-color: var(--accent); color: var(--accent-strong); background: var(--accent-soft); }
  .faint { margin: 0; font-size: 11px; }
  .error { margin: 0; font-size: 11px; color: var(--danger); }
  .close { position: absolute; top: 10px; right: 10px; }
</style>
