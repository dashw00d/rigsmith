import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'gear.narrow-navigation', character: 'folk-v6-0ba482', step: 'gear',
  async run (ui) {
    await ui.eval(() => {
      const nav = document.querySelector<HTMLElement>('nav[aria-label="Workflow"]')!
      nav.closest<HTMLElement>('header')!.style.width = '500px'
      // Match the app's <=1099px responsive navigation while emulating a narrow viewport.
      nav.style.justifyContent = 'flex-start'
    })
    await ui.waitFor(() => {
      const nav = document.querySelector<HTMLElement>('nav[aria-label="Workflow"]')!
      return nav.scrollWidth > nav.clientWidth
    })
    for (const step of ['ship', 'import', 'motion'] as const) {
      await ui.eval(async (r, next) => { await r.app.go(next) }, step)
      try { await ui.waitFor(() => {
        const nav = document.querySelector<HTMLElement>('nav[aria-label="Workflow"]')!
        const button = nav.querySelector<HTMLElement>('[aria-current="step"]')!
        const n = nav.getBoundingClientRect(); const b = button.getBoundingClientRect()
        // An extra-narrow nav may be narrower than the step itself; then the most possible must be visible.
        return Math.min(n.right, b.right) - Math.max(n.left, b.left) >= Math.min(n.width, b.width) - 1
      }, 10_000) } catch {
        const detail = await ui.eval(() => {
          const nav = document.querySelector<HTMLElement>('nav[aria-label=Workflow]')!
          const b = nav.querySelector<HTMLElement>('[aria-current=step]')!
          const n = nav.getBoundingClientRect(), r = b.getBoundingClientRect()
          return { nav: [n.left, n.right, n.width], button: [r.left, r.right, r.width], scrollLeft: nav.scrollLeft, scrollWidth: nav.scrollWidth }
        })
        throw new Error(`${step} not visible: ${JSON.stringify(detail)}`)
      }
      assert.equal((await ui.app()).step, step)
    }
    await ui.shot('narrow-nav')
  },
} satisfies Scenario
