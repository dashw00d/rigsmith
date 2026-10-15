<script lang="ts">
  import { Check, LoaderCircle, Settings2 } from '@lucide/svelte'
  import { app, STEPS, type Step } from '../state/app.svelte.ts'
  import { tooltip } from '../ui/tooltip.ts'
  import JobsPopover from './JobsPopover.svelte'
  import SettingsPopover from './SettingsPopover.svelte'

  let jobsOpen = $state(false)
  let settingsOpen = $state(false)

  function done (step: Step): boolean {
    const c = app.selected
    if (c === null) return false
    switch (step) {
      case 'import': return c.status !== 'importing' && c.status !== 'error'
      case 'rig': return c.status === 'rigged'
      case 'animate': return c.animations.length > 0
      default: return false
    }
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

  <nav class="steps" aria-label="Workflow">
    {#each STEPS as step, i (step.id)}
      <button class="step" class:active={app.step === step.id} class:done={done(step.id)} onclick={() => { app.step = step.id }} use:tooltip={step.hint}>
        <span class="num">{#if done(step.id) && app.step !== step.id}<Check size={11} strokeWidth={3} />{:else}{i + 1}{/if}</span>
        <span>{step.label}</span>
      </button>
      {#if i < STEPS.length - 1}<span class="sep" aria-hidden="true"></span>{/if}
    {/each}
  </nav>

  <div class="tools">
    <div class="pop-anchor">
      <button class="chip" class:busy={app.activeJobs.length > 0} onclick={() => { jobsOpen = !jobsOpen; settingsOpen = false }} use:tooltip={'Background jobs'}>
        {#if app.activeJobs.length > 0}
          <LoaderCircle size={14} class="spin" />
          <span>{app.activeJobs.length} running</span>
        {:else}
          <span class="dot" class:off={!app.connected}></span>
          <span>{app.connected ? 'Idle' : 'Offline'}</span>
        {/if}
      </button>
      {#if jobsOpen}<JobsPopover onclose={() => { jobsOpen = false }} />{/if}
    </div>
    <div class="pop-anchor">
      <button class="icon-btn" onclick={() => { settingsOpen = !settingsOpen; jobsOpen = false }} aria-label="Settings" use:tooltip={'Settings'}>
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
    grid-template-columns: 272px 1fr 328px;
    align-items: center;
    border-bottom: 1px solid var(--line);
    background: var(--bg-1);
  }
  .brand { display: flex; align-items: center; gap: 9px; padding-left: 16px; font-weight: 650; letter-spacing: -0.01em; font-size: 14px; }
  .steps { display: flex; align-items: center; justify-content: center; gap: 4px; }
  .step {
    display: flex;
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
  .step.done { color: var(--text-2); }
  .step.done .num { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
  .step.active { color: var(--text-1); background: var(--bg-3); }
  .step.active .num { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  .sep { width: 14px; height: 1px; background: var(--line-strong); }
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
  .chip.busy { color: var(--accent-strong); border-color: rgb(142 162 255 / 35%); background: var(--accent-soft); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .dot.off { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
  .icon-btn { width: 30px; height: 30px; display: grid; place-items: center; border-radius: var(--r-2); border: 0; background: transparent; color: var(--text-2); }
  .icon-btn:hover { background: var(--bg-3); color: var(--text-1); }
  :global(.spin) { animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
