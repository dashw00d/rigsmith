<script lang="ts">
  // A number typed in. It reports a value only when it is committed (Enter, leaving the field, or an arrow key's
  // step), since each change is usually a command; Escape takes back what was typed. Arrow keys step by `step`
  // (Shift: ten steps, Alt: a tenth).
  interface Props {
    value: number | null
    onchange: (value: number) => void
    min?: number
    max?: number
    step?: number
    /** Decimals shown (the value itself is kept as given). */
    digits?: number
    unit?: string
    /** Its accessible name when no Field labels it. */
    label?: string
    disabled?: boolean
    size?: 'sm' | 'md'
    width?: string
  }
  let { value, onchange, min, max, step = 1, digits, unit, label, disabled = false, size = 'md', width = '84px' }: Props = $props()

  let draft = $state('')
  let editing = $state(false)
  let dirty = false

  const show = (v: number | null): string => (v === null || !Number.isFinite(v) ? '' : digits === undefined ? String(v) : String(Number(v.toFixed(digits))))
  const clamp = (v: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
  function parse (text: string): number | null {
    const n = Number(text.trim().replace(',', '.'))
    return text.trim() === '' || !Number.isFinite(n) ? null : n
  }

  function commit (): void {
    if (!dirty) return
    dirty = false
    const typed = parse(draft)
    // (not a number: back to the value)
    const next = typed === null ? value : clamp(typed)
    if (next !== null && next !== value) onchange(next)
    draft = show(next)
  }

  function nudge (direction: number, event: KeyboardEvent): void {
    // (rounded at 1e-10 so steps of 0.1 don't drift into 0.30000000000000004)
    const next = clamp(Number(((parse(draft) ?? value ?? 0) + direction * step * (event.shiftKey ? 10 : event.altKey ? 0.1 : 1)).toFixed(10)))
    dirty = false
    draft = show(next)
    if (next !== value) onchange(next)
  }

  function onkeydown (event: KeyboardEvent): void {
    if (event.key === 'Enter') commit()
    else if (event.key === 'Escape' && dirty) {
      // (taken back here, so a drawer or dialog around it stays open)
      event.preventDefault()
      dirty = false
      draft = show(value)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      nudge(event.key === 'ArrowUp' ? 1 : -1, event)
    }
  }
</script>

<span class="number {size}" class:disabled style:width>
  <input
    type="text"
    inputmode="decimal"
    role="spinbutton"
    aria-label={label}
    aria-valuenow={value ?? undefined}
    aria-valuemin={min}
    aria-valuemax={max}
    {disabled}
    value={editing ? draft : show(value)}
    onfocus={() => { editing = true; dirty = false; draft = show(value) }}
    oninput={(event) => { draft = event.currentTarget.value; dirty = true }}
    onblur={() => { commit(); editing = false }}
    {onkeydown}
  />
  {#if unit}<span class="unit" aria-hidden="true">{unit}</span>{/if}
</span>

<style>
  .number {
    display: inline-flex;
    align-items: center;
    height: 28px;
    border-radius: var(--r-1);
    border: 1px solid var(--line-strong);
    background: var(--bg-1);
    transition: border-color var(--fast);
  }
  .number:focus-within { border-color: var(--accent); }
  .number.sm { height: 24px; font-size: 12px; }
  .number.disabled { opacity: 0.5; }
  input { flex: 1; min-width: 0; height: 100%; padding: 0 7px; border: 0; background: transparent; text-align: right; font-variant-numeric: tabular-nums; }
  input:focus, input:focus-visible { outline: none; }
  .sm input { padding: 0 5px; }
  .unit { flex: none; padding-right: 7px; color: var(--text-3); font-size: 11.5px; }
</style>
