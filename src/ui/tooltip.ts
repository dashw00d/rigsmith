// `use:tooltip={'text'}`: a styled tooltip that appears after a short hover delay, or when the element takes the
// keyboard's focus (so a hint is never mouse-only). Escape hides it.
let tip: HTMLDivElement | null = null
let timer: ReturnType<typeof setTimeout> | undefined

function element (): HTMLDivElement {
  if (tip === null) {
    tip = document.createElement('div')
    tip.className = 'rs-tooltip'
    tip.setAttribute('role', 'tooltip')
    Object.assign(tip.style, {
      position: 'fixed', zIndex: '1000', pointerEvents: 'none', padding: '5px 8px', borderRadius: '6px',
      background: '#232833', color: '#e9ebf1', font: '500 11.5px/1.35 var(--font)', maxWidth: '260px',
      boxShadow: '0 6px 24px rgb(0 0 0 / 50%), 0 0 0 1px #2c3240', opacity: '0', transition: 'opacity 120ms',
    })
    document.body.appendChild(tip)
  }
  return tip
}

export function tooltip (node: HTMLElement, text: string | undefined | null) {
  let current = text
  const show = (): void => {
    if (current === undefined || current === null || current === '') return
    clearTimeout(timer)
    timer = setTimeout(() => {
      const t = element()
      t.textContent = current ?? ''
      const r = node.getBoundingClientRect()
      t.style.opacity = '1'
      const w = t.offsetWidth
      const h = t.offsetHeight
      let top = r.bottom + 8
      if (top + h > window.innerHeight - 8) top = r.top - h - 8
      t.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`
      t.style.top = `${top}px`
    }, 380)
  }
  const hide = (): void => {
    clearTimeout(timer)
    if (tip !== null) tip.style.opacity = '0'
  }
  // (focus from a click shows nothing more than the hover did; focus from the keyboard is :focus-visible)
  const focus = (): void => { if (node.matches(':focus-visible')) show() }
  const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') hide() }
  node.addEventListener('pointerenter', show)
  node.addEventListener('pointerleave', hide)
  node.addEventListener('pointerdown', hide)
  node.addEventListener('focus', focus)
  node.addEventListener('blur', hide)
  node.addEventListener('keydown', key)
  return {
    update (next: string | undefined | null) { current = next },
    destroy () {
      hide()
      node.removeEventListener('pointerenter', show)
      node.removeEventListener('pointerleave', hide)
      node.removeEventListener('pointerdown', hide)
      node.removeEventListener('focus', focus)
      node.removeEventListener('blur', hide)
      node.removeEventListener('keydown', key)
    },
  }
}
