import { expect, it } from 'vitest'
import scenario from './classes.tab.scenario.ts'
import type { UI } from './ui.ts'
it('opens the classes tab independently of the shared-workspace count', async () => {
  document.body.innerHTML = '<div data-testid="class-tab"><button data-tab="classes"><span>Dynamic classes</span><span>2</span></button></div>'
  const stopped = new Error('opened classes')
  const ui = {
    waitFor: async () => {},
    eval: async (fn: (r: never) => unknown) => fn({} as never),
    click: async (selector: unknown) => { expect(selector).toEqual({ role: 'tab', name: 'Dynamic classes 2' }); throw stopped },
  } as unknown as UI
  await expect(scenario.run(ui)).rejects.toBe(stopped)
})
