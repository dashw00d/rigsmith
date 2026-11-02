<script lang="ts">
  // The last rig as decisions: each stage of the rig job (the joints, Blender's weights, volume heat, the previous rig,
  // the pose optimizer, the painting), what it chose and why; then the warnings the decisions don't already say.
  import { CircleCheck, TriangleAlert } from '@lucide/svelte'
  import { templateInfo } from '../../engine/templates.ts'
  import type { Character, FingerLevel } from '../../state/api.ts'
  import { changedSinceRig } from '../skeleton/joints.ts'
  import { decisionsOf, notesOf } from './report.ts'

  let { character }: { character: Character } = $props()

  const LEVELS: Record<FingerLevel, string> = { none: 'no finger bones', one: 'one finger chain', two: 'the mitten (thumb and one chain)', three: 'thumb, index and one chain for the other three', full: 'every finger' }

  const report = $derived(character.skin.report ?? null)
  const human = $derived(character.skeleton.template === 'human')
  const bones = $derived(character.skin.bones ?? character.source.stats?.bones)
  const read = $derived(report === null ? null : decisionsOf(report))
  const notes = $derived(report === null ? [] : notesOf(report))
  const moved = $derived(changedSinceRig(character)?.moved.length ?? 0)
  // (a rig that failed since this one: it stayed, and the failure says why)
  const failed = $derived(character.status !== 'error' && character.error !== undefined && character.error !== '' ? character.error.split('\n')[0] : null)
</script>

<div class="card">
  <strong><CircleCheck size={14} /> Rigged with the {human ? 'Mixamo' : templateInfo(character.skeleton.template).label.toLowerCase()} skeleton</strong>
  <span class="muted">
    {[report !== null ? `${report.seconds.toFixed(1)} s` : null, bones !== undefined ? `${bones} bones` : null, human ? LEVELS[character.skeleton.fingerLevel] : null].filter(x => x !== null).join(' · ')}
  </span>
</div>

{#if moved > 0}
  <div class="warn-line"><TriangleAlert size={14} /><span>{moved} {moved === 1 ? 'joint has' : 'joints have'} moved since this rig: rig again in the Skeleton step to use {moved === 1 ? 'it' : 'them'}.</span></div>
{/if}
{#if failed !== null}
  <div class="warn-line"><TriangleAlert size={14} /><span>The last rig didn't finish, so this one stayed: {failed}</span></div>
{/if}

{#if read !== null && read.decisions.length > 0}
  <ol class="decisions">
    {#each read.decisions as d, i (i)}
      <li>
        <span class="stage">{d.stage}</span>
        <span class="choice">{d.choice}</span>
        {#if d.why !== ''}<span class="why">{d.why}</span>{/if}
      </li>
    {/each}
  </ol>
  {#if read.older}<p class="faint small">From a rig made before the reasons were kept: rig again to see why each was chosen.</p>{/if}
{:else if report === null}
  <p class="faint small">No report was kept for this rig.</p>
{/if}

{#each notes as w, i (i)}
  <div class="warn-line"><TriangleAlert size={14} /><span>{w}</span></div>
{/each}

<style>
  .small { font-size: 12px; margin: 0; }
  .card { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: var(--r-2); background: var(--ok-soft); border: 1px solid rgb(95 211 154 / 20%); }
  .card strong { color: var(--ok); font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .card span { font-size: 12px; }
  .warn-line { display: flex; gap: 8px; align-items: flex-start; color: var(--warn); font-size: 12.5px; }
  .warn-line :global(svg) { flex: none; margin-top: 2px; }
  .decisions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .decisions li { display: grid; grid-template-columns: 96px 1fr; column-gap: 10px; row-gap: 1px; font-size: 12px; }
  .stage { color: var(--text-3); grid-row: span 2; }
  .choice { color: var(--text-1); font-weight: 550; }
  .why { grid-column: 2; color: var(--text-3); }
</style>
