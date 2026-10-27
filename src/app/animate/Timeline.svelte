<script lang="ts">
  import { FlipHorizontal2, Footprints, Pause, Play, Repeat } from '@lucide/svelte'
  import { animator } from '../../state/animator.svelte.ts'
  import { clipEdit } from '../../state/clipedit.svelte.ts'
  import { tooltip } from '../../ui/tooltip.ts'

  let scrubbing = $state(false)
  let wasPlaying = false

  const fps = 30
  // (where the playhead is in the clip: a loop wraps round, a one-shot stays on its last frame at its end)
  const at = $derived(animator.duration > 0 ? (animator.loop ? animator.time % animator.duration : Math.min(Math.max(animator.time, 0), animator.duration)) : 0)
  const progress = $derived(animator.duration > 0 ? at / animator.duration : 0)
  const frames = $derived(Math.max(1, Math.round(animator.duration * fps)))
  const frame = $derived(Math.min(frames, Math.floor(progress * frames + 1e-6)))

  function seekFrom (e: PointerEvent, bar: HTMLElement): void {
    const r = bar.getBoundingClientRect()
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    animator.seek(clipEdit.snapTime(t * animator.duration))
  }

  // (while editing, the playhead is always on a frame: a key is made on a frame, of the pose seen there)
  function togglePlay (): void {
    animator.setPlaying(!animator.playing)
    if (!animator.playing && clipEdit.active) animator.seek(clipEdit.snapTime(animator.time))
  }

  function onKey (e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || animator.current === null) return
    if (e.key === ' ') { e.preventDefault(); togglePlay() }
    if (e.key === ',' || e.key === '.') {
      animator.setPlaying(false)
      animator.seek(clipEdit.snapTime(Math.max(0, Math.min(animator.duration, clipEdit.snapTime(animator.time) + (e.key === '.' ? 1 : -1) / fps))))
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if animator.current}
  <div class="timeline">
    <button class="play" onclick={togglePlay} aria-label={animator.playing ? 'Pause' : 'Play'} use:tooltip={'Space'}>
      {#if animator.playing}<Pause size={15} />{:else}<Play size={15} />{/if}
    </button>
    <div class="info">
      <div class="row">
        <span class="name">{animator.current.name}</span>
        <span class="mono faint">{frame} / {frames}</span>
      </div>
      <div class="bar" role="slider" tabindex="0" aria-label="Scrub" aria-valuenow={Math.round(progress * 100)}
        onpointerdown={(e) => { scrubbing = true; wasPlaying = animator.playing; animator.setPlaying(false); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); seekFrom(e, e.currentTarget as HTMLElement) }}
        onpointermove={(e) => { if (scrubbing) seekFrom(e, e.currentTarget as HTMLElement) }}
        onpointerup={() => { scrubbing = false; if (wasPlaying) animator.setPlaying(true) }}>
        <div class="fill" style="width: {progress * 100}%"></div>
        {#if clipEdit.active}
          <!-- (the frames keyed: a diamond each, the selected bone's bright; press one to go there) -->
          {#each clipEdit.phases as u (u)}
            <button class="key" class:mine={clipEdit.selectedPhases.some(x => Math.abs(x - u) < 1e-4)} style="left: {u * 100}%" aria-label="Key at frame {Math.round(u * animator.duration * fps)}"
              onpointerdown={(e) => { e.stopPropagation(); animator.setPlaying(false); animator.seek(u * animator.duration) }}></button>
          {/each}
        {/if}
        <div class="knob" style="left: {progress * 100}%"></div>
      </div>
    </div>
    <div class="flags">
      <button class:on={animator.loop} onclick={() => { if (clipEdit.active) clipEdit.setLoop(!animator.loop); else animator.setLoop(!animator.loop) }} use:tooltip={'Loop'}><Repeat size={14} /></button>
      <button class:on={animator.inPlace} onclick={() => { animator.inPlace = !animator.inPlace; void animator.refresh() }} use:tooltip={'In place'}><Footprints size={14} /></button>
      <button class:on={animator.mirror} onclick={() => { animator.mirror = !animator.mirror; void animator.refresh() }} use:tooltip={'Mirror left/right'}><FlipHorizontal2 size={14} /></button>
      <select class="mono" value={String(animator.speed)} onchange={(e) => animator.setSpeed(Number((e.target as HTMLSelectElement).value))} aria-label="Playback speed">
        {#each [0.25, 0.5, 1, 1.5, 2] as s}<option value={String(s)}>{s}×</option>{/each}
      </select>
    </div>
  </div>
{/if}

<style>
  .timeline {
    position: absolute;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    width: min(620px, calc(100% - 32px));
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 14px;
    background: var(--overlay);
    backdrop-filter: blur(10px);
    border: 1px solid var(--line-strong);
    box-shadow: 0 10px 40px rgb(0 0 0 / 40%);
    z-index: 3;
  }
  .play { width: 34px; height: 34px; border-radius: 50%; border: 0; background: var(--text-1); color: var(--bg-0); display: grid; place-items: center; flex: none; }
  .play:hover { background: #fff; }
  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
  .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar { position: relative; height: 14px; cursor: pointer; touch-action: none; }
  .bar::before { content: ''; position: absolute; left: 0; right: 0; top: 6px; height: 3px; border-radius: 2px; background: var(--bg-4); }
  .fill { position: absolute; left: 0; top: 6px; height: 3px; border-radius: 2px; background: var(--accent); }
  .key { position: absolute; top: 2px; width: 9px; height: 9px; margin-left: -4.5px; padding: 0; border: 1px solid rgb(0 0 0 / 50%); background: var(--warn, #f5c45e); transform: rotate(45deg); border-radius: 1px; cursor: pointer; z-index: 1; }
  .key.mine { background: #ff7ab8; }
  .knob { position: absolute; top: 2px; width: 11px; height: 11px; margin-left: -5.5px; border-radius: 50%; background: var(--text-1); box-shadow: 0 1px 4px rgb(0 0 0 / 50%); }
  .flags { display: flex; gap: 2px; align-items: center; }
  .flags button { width: 28px; height: 28px; border-radius: 7px; border: 0; background: transparent; color: var(--text-3); display: grid; place-items: center; }
  .flags button:hover { color: var(--text-1); background: var(--bg-3); }
  .flags button.on { color: var(--accent-strong); }
  select { height: 26px; margin-left: 4px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-2); font-size: 11px; }
</style>
