<script lang="ts">
  // A unit's checks (src/engine/checks.ts): the game's rules that can be told before exporting, each passed or failed
  // in words, failures first. What only the export can measure is said as such (info).
  import { CircleCheck, CircleX, Info, TriangleAlert } from '@lucide/svelte'
  import type { Check, CheckStatus } from '../../engine/checks.ts'
  import { checksSummary } from './text.ts'

  let { checks }: { checks: Check[] } = $props()

  const ORDER: Record<CheckStatus, number> = { fail: 0, warn: 1, pass: 2, info: 3 }
  const sorted = $derived([...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]))
  const summary = $derived(checksSummary(checks))
  const ICONS = { pass: CircleCheck, fail: CircleX, warn: TriangleAlert, info: Info }
  const WORDS: Record<CheckStatus, string> = { pass: 'Passes', fail: 'Fails', warn: 'Warning', info: 'Note' }
</script>

<p class="summary {summary.tone}" role="status">{summary.text}</p>
<ul class="checks">
  {#each sorted as check, i (`${check.rule}-${i}`)}
    {@const Icon = ICONS[check.status]}
    <li class={check.status}>
      <span class="icon" aria-label={WORDS[check.status]}><Icon size={13} /></span>
      <span>{check.text}</span>
    </li>
  {/each}
</ul>

<style>
  .summary { margin: 0; font-size: 12px; font-weight: 600; }
  .summary.ok { color: var(--ok); }
  .summary.warn { color: var(--warn); }
  .summary.error { color: var(--danger); }
  .checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  li { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; color: var(--text-2); }
  .icon { display: grid; place-items: center; height: 16px; flex: none; }
  li.pass .icon { color: var(--ok); }
  li.fail .icon { color: var(--danger); }
  li.fail { color: var(--text-1); }
  li.warn .icon { color: var(--warn); }
  li.info .icon { color: var(--text-4); }
</style>
