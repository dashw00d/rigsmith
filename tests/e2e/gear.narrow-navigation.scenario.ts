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
      await ui.waitFor(() => {
        const nav = document.querySelector<HTMLElement>('nav[aria-label="Workflow"]')!
        const button = nav.querySelector<HTMLElement>('[aria-current="step"]')!
        const n = nav.getBoundingClientRect(); const b = button.getBoundingClientRect()
        return b.left >= n.left - 1 && b.right <= n.right + 1
      }, 10_000)
      assert.equal((await ui.app()).step, step)
    }
    await ui.shot('narrow-nav')
  },
} satisfies Scenario
