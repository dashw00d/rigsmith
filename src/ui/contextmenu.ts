import { mount, unmount } from 'svelte'
import ContextMenu from './ContextMenu.svelte'

export interface MenuItem {
  label: string
  keys?: string
  danger?: boolean
  disabled?: boolean
  run: () => void
  children?: MenuItem[]
}

let active: (() => void) | null = null

/** Open a row's menu at the pointer, or from Shift+F10 / the keyboard menu key. */
export function contextMenu (node: HTMLElement, items: () => MenuItem[]) {
  let close: (() => void) | null = null
  function open (x: number, y: number): void {
    active?.()
    const target = document.createElement('div')
    document.body.appendChild(target)
    const dismiss = (): void => {
      if (close !== dismiss) return
      close = null
      if (active === dismiss) active = null
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', dismiss)
      void unmount(component)
      target.remove()
      if (node.isConnected) node.focus({ preventScroll: true })
    }
    const outside = (event: PointerEvent): void => { if (!target.contains(event.target as Node)) dismiss() }
    close = dismiss
    active = dismiss
    const component = mount(ContextMenu, { target, props: { items: items(), x, y, close: dismiss } })
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', dismiss)
  }
  const menu = (event: MouseEvent): void => { event.preventDefault(); open(event.clientX, event.clientY) }
  const key = (event: KeyboardEvent): void => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    const r = node.getBoundingClientRect()
    open(r.left, r.bottom)
  }
  node.addEventListener('contextmenu', menu)
  node.addEventListener('keydown', key)
  return { update (next: () => MenuItem[]) { items = next }, destroy () { close?.(); node.removeEventListener('contextmenu', menu); node.removeEventListener('keydown', key) } }
}
