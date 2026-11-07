<script lang="ts">
  // The top bar: the seven steps (each with a tick: done, or needs something, from src/app/status.ts; Ship's from the
  // game units in src/state/ship.svelte.ts), the Forge's button (its board over the workspace), the activity
  // button (jobs running, the server connection; opens the activity drawer) and the settings.
  import { onMount, tick } from 'svelte'
  import { Activity, Anvil, Check, LoaderCircle, Settings2 } from '@lucide/svelte'
  import { app, STEPS, type Step } from '../state/app.svelte.ts'
  import { forge } from '../state/forge.svelte.ts'
  import { ship } from '../state/ship.svelte.ts'
  import { tooltip } from '../ui/tooltip.ts'
  import SettingsPopover from './SettingsPopover.svelte'
  import { stepMark, type ShipFacts, type StepMark } from './status.ts'

  let settingsOpen = $state(false)
  let nav = $state<HTMLElement | null>(null)

  function revealStep (): void {
    const button = nav?.querySelector<HTMLElement>('[aria-current="step"]')
    if (nav !== null && button) nav.scrollLeft = button.offsetLeft - (nav.clientWidth - button.offsetWidth) / 2
  }

  $effect(() => { void app.step; void tick().then(revealStep) })
  onMount(() => {
    const observer = new ResizeObserver(revealStep)
    if (nav !== null) observer.observe(nav)
    return () => { observer.disconnect() }
  })

  const job = $derived(app.selected === null ? undefined : app.jobFor(app.selected.id))

  // (the Ship tick: the game's units and the last builds of the selected character's units, read here too so it shows
  // before the Ship step is opened; load() and build() read app.gameBeat, so these run again when the units or an
  // export change)
  const shipRows = $derived(app.selected === null ? [] : ship.unitsOf(app.selected.id))
  $effect(() => { void ship.load() })
  $effect(() => { for (const r of shipRows) void ship.build(r.name) })
  const shipFacts = $derived.by((): ShipFacts | null => {
    if (ship.status === null) return null
    return {
      units: shipRows.map(r => ({ differs: r.differs, last: ship.builds[r.name]?.last ?? null })),
      failing: shipRows.some(r => ship.checks(r.name).some(x => x.status === 'fail')),
    }
  })

  const marks = $derived(new Map<Step, StepMark>(STEPS.map(s => [s.id, stepMark(app.selected, s.id, job, shipFacts)])))
  const running = $derived(app.activeJobs.length)
  // (failures since the activity drawer was last open: the ones not seen yet)
  let seen = $state(Date.now())
  $effect(() => { void app.jobs; if (app.drawer === 'activity') seen = Date.now() })
  const failed = $derived(app.jobs.filter(j => j.status === 'failed' && (j.finishedAt ?? 0) > seen).length)

  function hint (s: (typeof STEPS)[number]): string {
    const mark = marks.get(s.id)
    return mark === 'done' ? `${s.hint} · done` : mark === 'needs' ? `${s.hint} · needs attention` : s.hint
  }
</script>

<header class="bar">
  <div class="brand">
    <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
      <path d="M16 7v8m0 0-6 5m6-5 6 5" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" fill="none" />
      <circle cx="16" cy="7" r="2.8" fill="var(--side-center)" />
      <circle cx="10" cy="20.5" r="2.8" fill="var(--side-left)" />
      <circle cx="22" cy="20.5" r="2.8" fill="var(--side-right)" />
      <circle cx="16" cy="15" r="1.9" fill="var(--text-1)" />
    </svg>
    <span>Rigsmith</span>
  </div>

  <nav class="steps" aria-label="Workflow" bind:this={nav}>
    {#each STEPS as step, i (step.id)}
      {@const mark = marks.get(step.id) ?? null}
      <button data-testid="bar-step-{step.id}" class="step {mark ?? ''}" class:active={app.step === step.id} aria-current={app.step === step.id ? 'step' : undefined}
        onclick={() => { void app.go(step.id) }} use:tooltip={hint(step)}>
        <span class="num">
          {#if mark === 'done' && app.step !== step.id}<Check size={11} strokeWidth={3} />{:else}{i + 1}{/if}
          {#if mark === 'needs'}<i class="needs" aria-hidden="true"></i>{/if}
        </span>
        <span>{step.label}</span>
        {#if mark !== null}<span class="sr-only">({mark === 'done' ? 'done' : 'needs attention'})</span>{/if}
      </button>
      {#if i < STEPS.length - 1}<span class="sep" aria-hidden="true"></span>{/if}
    {/each}
  </nav>

  <div class="tools">
    <button class="chip" class:open={forge.open} aria-pressed={forge.open} onclick={() => { forge.toggle() }}
      use:tooltip={forge.open ? 'Back to the character' : 'The Forge: sets of gear made stage by stage'}>
      <Anvil size={14} />
      <span>Forge</span>
    </button>
    <button data-testid="bar-activity" class="chip" class:busy={running > 0} class:open={app.drawer === 'activity'} aria-pressed={app.drawer === 'activity'}
      aria-label="Activity: {running > 0 ? `${running} running` : app.connected ? 'connected' : 'offline'}"
      onclick={() => { app.toggleDrawer('activity') }}
      use:tooltip={app.connected ? 'Activity: jobs and this character\'s history' : 'The server is not answering: reconnecting'}>
      {#if running > 0}
        <LoaderCircle size={14} class="spin" />
        <span>{running} running</span>
      {:else}
        <span class="dot" class:off={!app.connected}></span>
        <Activity size={14} />
        <span>{app.connected ? 'Activity' : 'Offline'}</span>
      {/if}
      {#if failed > 0 && running === 0}<span class="failed" aria-hidden="true">{failed}</span>{/if}
    </button>
    <div class="pop-anchor">
      <button class="icon-btn" class:open={settingsOpen} onclick={() => { settingsOpen = !settingsOpen }} aria-label="Settings" aria-expanded={settingsOpen} use:tooltip={'Settings'}>
        <Settings2 size={16} />
      </button>
      {#if settingsOpen}<SettingsPopover onclose={() => { settingsOpen = false }} />{/if}
    </div>
  </div>
</header>

<style>
  .bar {
    height: 48px;
    flex: none;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 16px;
    align-items: center;
    border-bottom: 1px solid var(--line);
    background: var(--bg-1);
  }
  .brand { display: flex; align-items: center; gap: 9px; padding-left: 16px; font-weight: 650; letter-spacing: -0.01em; font-size: 14px; }
  .steps { position: relative; display: flex; align-items: center; justify-content: center; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .step {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 12px 0 6px;
    border: 0;
    border-radius: 16px;
    background: transparent;
    color: var(--text-3);
    font-weight: 550;
    transition: background var(--fast), color var(--fast);
  }
  .step:hover { color: var(--text-1); background: var(--bg-3); }
  .num {
    position: relative;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 650;
    background: var(--bg-3);
    color: var(--text-3);
    border: 1px solid var(--line-strong);
    transition: all var(--fast);
  }
  .needs { position: absolute; top: -2px; right: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 2px var(--bg-1); }
  .step.done { color: var(--text-2); }
  .step.done .num { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
  .step.needs { color: var(--text-2); }
  .step.active { color: var(--text-1); background: var(--bg-3); }
  .step.active .num { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  .sep { width: 14px; height: 1px; background: var(--line-strong); flex: none; }
  .tools { display: flex; justify-content: flex-end; align-items: center; gap: 6px; padding-right: 12px; }
  .pop-anchor { position: relative; }
  .chip {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 11px;
    border-radius: 14px;
    border: 1px solid var(--line-strong);
    background: var(--bg-2);
    color: var(--text-2);
    font-size: 12px;
    font-weight: 500;
  }
  .chip:hover, .chip.open { color: var(--text-1); background: var(--bg-3); }
  .chip.busy { color: var(--accent-strong); border-color: rgb(142 162 255 / 35%); background: var(--accent-soft); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .dot.off { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
  .failed { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--danger-soft); color: var(--danger); font-size: 10.5px; font-weight: 650; display: grid; place-items: center; }
  .icon-btn { width: 30px; height: 30px; display: grid; place-items: center; border-radius: var(--r-2); border: 0; background: transparent; color: var(--text-2); }
  .icon-btn:hover, .icon-btn.open { background: var(--bg-3); color: var(--text-1); }
  :global(.spin) { animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 1099px) { .bar { gap: 8px; } .brand span { display: none; } .steps { justify-content: flex-start; } .step { gap: 5px; padding-right: 8px; } .sep { width: 6px; } }
  @media (max-width: 599px) { .brand { padding-left: 8px; } .chip span:not(.dot):not(.failed) { display: none; } .chip { padding: 0 7px; } .tools { padding-right: 6px; gap: 2px; } }
</style>
