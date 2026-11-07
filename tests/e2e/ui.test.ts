// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { UI, selectorDescription } from './ui.ts'
import type { Page } from '../../tools/lib/chrome.ts'

describe('e2e selectors', () => {
  it('reports repeated row IDs and their scope', () => {
    expect(selectorDescription({ testid: 'gear-row', id: 'abc', within: { role: 'dialog', name: 'Gear' } }))
      .toBe('testid="gear-row" data-id="abc" within (role="dialog" name="Gear")')
  })
  it('scopes repeated testids and filters by stable id', async () => {
    const calls: Array<[string, object | undefined]> = []
    const page = { send: async (method: string, params?: object) => {
      calls.push([method, params])
      if (method === 'DOM.getDocument') return { result: { root: { nodeId: 1 } } }
      if (method === 'DOM.querySelectorAll') return { result: { nodeIds: calls.filter(c => c[0] === method).length === 1 ? [2] : [3] } }
      throw new Error(`Unexpected ${method}`)
    } } as unknown as Page
    const ui = new UI(page, '/unused', 'test')
    expect(await ui.count({ testid: 'gear-row', id: 'abc', within: { testid: 'gear-panel' } })).toBe(1)
    expect(calls).toContainEqual(['DOM.querySelectorAll', { nodeId: 1, selector: '[data-testid="gear-panel"]' }])
    expect(calls).toContainEqual(['DOM.querySelectorAll', { nodeId: 2, selector: '[data-testid="gear-row"][data-id="abc"]' }])
  })
  it('uses accessibility roles and exact names instead of text or CSS', async () => {
    const calls: Array<[string, object | undefined]> = []
    const page = { send: async (method: string, params?: object) => {
      calls.push([method, params])
      if (method === 'DOM.getDocument') return { result: { root: { nodeId: 1 } } }
      if (method === 'Accessibility.queryAXTree') return { result: { nodes: [
        { backendDOMNodeId: 4, role: { value: 'button' }, name: { value: 'Save' } },
        { backendDOMNodeId: 5, role: { value: 'button' }, name: { value: 'Save all' } },
      ] } }
      if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { result: { nodeIds: [8] } }
      throw new Error(`Unexpected ${method}`)
    } } as unknown as Page
    const ui = new UI(page, '/unused', 'test')
    expect(await ui.count({ role: 'button', name: 'Save' })).toBe(1)
    expect(calls).toContainEqual(['Accessibility.queryAXTree', { nodeId: 1, role: 'button', accessibleName: 'Save' }])
    expect(calls).toContainEqual(['DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [4] }])
  })
})
