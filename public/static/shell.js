// Shell interactions for the original storefront (V2 Phase 2).
//
// This module is imported by public/static/app.js and owns the accessible
// behaviour of the CMS-driven shell:
//   * the mobile navigation drawer (aria-expanded, Escape to close, focus
//     returns to the toggle);
//   * the search overlay — a real dialog with a focus trap, Escape to close,
//     and live suggestions fetched from the SERVER's catalogue endpoint
//     (never from a hard-coded list);
//   * the country/currency selector, which submits only a value the server
//     already validated, and enhances the form so changing the select applies
//     the choice without a second click.
//
// Everything degrades to plain HTML: with JavaScript disabled the drawer link
// list, the search form (GET /books?q=) and the country form all still work.

function focusables(root) {
  return Array.from(
    root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
  ).filter((el) => el.offsetParent !== null || el === document.activeElement)
}

function trapFocus(root, onEscape) {
  const handler = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onEscape()
      return
    }
    if (event.key !== 'Tab') return
    const items = focusables(root)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  document.addEventListener('keydown', handler)
  return () => document.removeEventListener('keydown', handler)
}

export function initMobileNav() {
  const toggle = document.getElementById('menu-toggle')
  const drawer = document.getElementById('mobile-drawer')
  if (!toggle || !drawer) return
  const setOpen = (open) => {
    if (open) drawer.removeAttribute('hidden')
    else drawer.setAttribute('hidden', '')
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
  }
  toggle.addEventListener('click', () => setOpen(drawer.hasAttribute('hidden')))
}

export function initSearch() {
  const toggle = document.getElementById('search-toggle')
  const overlay = document.getElementById('search-overlay')
  const close = document.getElementById('search-close')
  const input = document.getElementById('search-input')
  const list = document.getElementById('search-suggestions')
  if (!toggle || !overlay || !input) return

  let release = null
  const open = () => {
    overlay.removeAttribute('hidden')
    toggle.setAttribute('aria-expanded', 'true')
    input.focus()
    release = trapFocus(overlay, closeOverlay)
  }
  const closeOverlay = () => {
    overlay.setAttribute('hidden', '')
    toggle.setAttribute('aria-expanded', 'false')
    if (release) release()
    release = null
    toggle.focus()
  }
  toggle.addEventListener('click', () => (overlay.hasAttribute('hidden') ? open() : closeOverlay()))
  close?.addEventListener('click', closeOverlay)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeOverlay()
  })

  // Suggestions come from the live catalogue. Requests are debounced and the
  // previous response is discarded if a newer one has arrived, so a slow reply
  // cannot overwrite a newer list.
  let timer = null
  let requestId = 0
  const render = (items, query) => {
    if (!list) return
    if (!items.length) {
      list.innerHTML = ''
      list.setAttribute('hidden', '')
      input.setAttribute('aria-expanded', 'false')
      return
    }
    list.innerHTML = items
      .map(
        (item) =>
          `<li role="option" aria-selected="false"><a href="${item.href}"><span>${escapeHtml(item.title)}</span><span class="tiny">${escapeHtml(item.price || '')}</span></a></li>`
      )
      .join('')
    list.removeAttribute('hidden')
    input.setAttribute('aria-expanded', 'true')
  }
  input.addEventListener('input', () => {
    const query = input.value.trim()
    if (timer) clearTimeout(timer)
    if (query.length < 2) {
      render([], query)
      return
    }
    timer = setTimeout(async () => {
      const id = ++requestId
      try {
        const res = await fetch(`/api/v1/search/suggest?q=${encodeURIComponent(query)}`, { headers: { Accept: 'application/json' } })
        if (!res.ok || id !== requestId) return
        const data = await res.json()
        if (id !== requestId) return
        render(Array.isArray(data.suggestions) ? data.suggestions : [], query)
      } catch {
        /* a failed suggestion request must never break typing */
      }
    }, 180)
  })
}

export function initLocaleForm() {
  const form = document.querySelector('.locale-form')
  const select = document.getElementById('country-select')
  if (!form || !select) return
  // Progressive enhancement only: the visible "Update" button already works
  // without JavaScript, and it is only hidden once this runs.
  form.classList.add('locale-form-enhanced')
  select.addEventListener('change', () => form.requestSubmit())
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
