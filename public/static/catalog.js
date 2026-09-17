// Catalog filter disclosure (SF-06).
//
// The filter panel is server-rendered as a real `<details open>`, so it works
// with JavaScript disabled: every filter is visible and the form submits
// normally. This module only decides the STARTING state for the visitor's
// screen — the shop's sidebar on a desktop, a collapsed "Filters" toggle on a
// phone, where an open panel used to push the first title two screens down the
// page.
//
// Rules, so the control can never fight the visitor:
//   * at (or above) the sidebar breakpoint the panel is forced open, because
//     that is where the filters are the sidebar rather than a disclosure;
//   * below it the panel starts closed;
//   * once the visitor opens or closes it themselves, their choice is kept for
//     the rest of the visit and a resize no longer overrides it.
const PANEL_ID = 'catalog-filter-panel'
const SIDEBAR_MIN_WIDTH = 1024

export function initCatalogFilters() {
  const panel = document.getElementById(PANEL_ID)
  if (!panel) return

  let visitorChose = false

  const applyBreakpoint = () => {
    if (window.innerWidth >= SIDEBAR_MIN_WIDTH) panel.open = true
    else if (!visitorChose) panel.open = false
  }

  // A click on the summary is the visitor's own decision.
  panel.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('summary')) visitorChose = true
  })

  window.addEventListener('resize', applyBreakpoint)
  applyBreakpoint()
}

document.addEventListener('DOMContentLoaded', initCatalogFilters)
