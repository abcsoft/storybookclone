// analytics.js — the ONE browser-side analytics layer (ES module).
//
// It is the only place in the browser that knows vendor globals exist (`fbq`,
// `ttq`, `gtag`/`dataLayer`). Storefront modules call `track()` / `trackOnce()`
// from here and never touch a vendor directly.
//
// CONSENT FIRST. Every vendor library is loaded LAZILY, and only after the
// matching consent category has been granted:
//   * Analytics  -> GA4                       (category: analytics)
//   * Marketing  -> Meta, TikTok, Google Ads  (category: marketing)
// Google Consent Mode v2 defaults are pushed (denied) WITHOUT loading anything,
// so gtag reads them the moment it is legitimately allowed to load. Before a
// decision, ZERO vendor network requests are made.
//
// FAIL OPEN. Every operation is wrapped so a blocked/absent/timed-out vendor
// script can never break the storefront, the cart or checkout. If this module
// throws, the page is unaffected.
//
// PRIVACY. Payloads are reduced to an allowlist and refused outright if a
// forbidden key is present. The regression test in tests intercepts every
// vendor request and fails if any private value appears.

const CONSENT_COOKIE = 'ww_consent'
const CONSENT_VERSION = 1
const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 180
const SEEN_KEY = 'ww_evt_seen'
const ATTR_COOKIE = 'ww_attr'
const ATTR_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
const ATTR_KEYS = ['fbclid', 'ttclid', 'gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']

const FORBIDDEN_KEYS = new Set([
  'name', 'childName', 'age', 'childAge', 'email', 'phone', 'address', 'photo', 'photoUrl', 'photoKey',
  'uploadKey', 'faceId', 'faceCount', 'boundingBox', 'analysis', 'dedication', 'userBookId', 'orderId',
  'paymentId', 'session', 'sessionId', 'token', 'csrf', 'csrfToken'
])
const ALLOWED_KEYS = new Set(['slug', 'sku', 'category', 'variantCode', 'coverType', 'quantity', 'currency', 'valueMinor', 'eventId', 'pageType', 'transactionId', 'items'])

// ---------------------------------------------------------------------------
// tiny, dependency-free helpers
// ---------------------------------------------------------------------------
function noop() {}

function readCookie(name) {
  try {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1') + '=([^;]*)'))
    return match ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

function writeCookie(name, value, maxAgeSeconds) {
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax`
  } catch {
    /* cookies unavailable — nothing to persist, and nothing breaks */
  }
}

function eraseCookie(name) {
  try {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`
    document.cookie = `${name}=; Max-Age=0; Path=/`
  } catch {
    /* ignore */
  }
}

function readConfig() {
  try {
    const el = document.getElementById('ww-marketing-config')
    if (!el || !el.textContent) return null
    return JSON.parse(el.textContent)
  } catch {
    return null
  }
}

function parseConsent(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || Number(parsed.v) !== CONSENT_VERSION) return null
    const ts = Number(parsed.ts)
    if (!Number.isFinite(ts) || ts <= 0) return null
    if (Date.now() - ts > CONSENT_MAX_AGE_SECONDS * 1000) return null
    return { v: CONSENT_VERSION, analytics: parsed.analytics === true, marketing: parsed.marketing === true, ts }
  } catch {
    return null
  }
}

function serializeConsent(state) {
  return JSON.stringify({ v: state.v, analytics: state.analytics, marketing: state.marketing, ts: state.ts })
}

function toMajorUnits(valueMinor) {
  const n = Number(valueMinor)
  if (!Number.isFinite(n)) return undefined
  return Math.round(n) / 100
}

function sanitize(payload) {
  const clean = {}
  const forbidden = []
  if (payload && typeof payload === 'object') {
    for (const key of Object.keys(payload)) {
      if (FORBIDDEN_KEYS.has(key)) {
        forbidden.push(key)
        continue
      }
      if (ALLOWED_KEYS.has(key)) clean[key] = payload[key]
    }
  }
  return { clean, forbidden }
}

function readSeen() {
  try {
    const raw = sessionStorage.getItem(SEEN_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function markSeen(key) {
  try {
    const seen = readSeen()
    seen.add(key)
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)))
  } catch {
    /* storage unavailable — dedupe degrades to in-memory only */
  }
}

function loadScript(src, id) {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) return resolve()
    const s = document.createElement('script')
    s.async = true
    s.src = src
    s.id = id
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('vendor script failed'))
    document.head.appendChild(s)
  })
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
let cfg = null
let consent = null
let inert = false
let revoked = false
const loaded = { meta: false, tiktok: false, google: false }
const ready = { meta: false, tiktok: false, google: false }
const queues = { meta: [], tiktok: [], google: [] }
const adapterMeta = {} // id -> {idValue, purchaseLabel}
let lastPageViewPath = null

function dataLayer() {
  try {
    window.dataLayer = window.dataLayer || []
    return window.dataLayer
  } catch {
    return []
  }
}

/** Google Consent Mode v2 — four signals, all denied by default. */
function pushConsentDefault() {
  const dl = dataLayer()
  const state = { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }
  dl.push(['consent', 'default', state])
}

function pushConsentUpdate() {
  const analytics = consent && consent.analytics ? 'granted' : 'denied'
  const marketing = consent && consent.marketing ? 'granted' : 'denied'
  const dl = dataLayer()
  dl.push(['consent', 'update', { analytics_storage: analytics, ad_storage: marketing, ad_user_data: marketing, ad_personalization: marketing }])
  dl.push({ event: 'consent_update', analytics_storage: analytics, ad_storage: marketing })
}

function categoryAllowed(category) {
  if (inert || revoked) return false
  if (!consent) return false
  return category === 'analytics' ? consent.analytics === true : consent.marketing === true
}

// ---------------------------------------------------------------------------
// adapters — the ONLY code that touches a vendor global
// ---------------------------------------------------------------------------
const ADAPTERS = {
  ga4: {
    category: 'analytics',
    lib: 'google',
    idKey: 'idValue',
    track(name, payload) {
      const gtag = window.gtag
      if (typeof gtag !== 'function') return
      const mapped = GA4_EVENTS[name]
      if (!mapped) return
      gtag('event', mapped, ga4Params(name, payload))
    }
  },
  googleAds: {
    category: 'marketing',
    lib: 'google',
    idKey: 'idValue',
    track(name, payload) {
      // Only a Purchase becomes a Google Ads conversion. It is gated upstream by
      // the purchase gate, so this path is inert unless that gate is open.
      if (name !== 'purchase') return
      const gtag = window.gtag
      if (typeof gtag !== 'function') return
      const label = adapterMeta.googleAds && adapterMeta.googleAds.purchaseLabel
      if (!label) return
      const value = toMajorUnits(payload.valueMinor)
      if (value === undefined) return
      gtag('event', 'conversion', { send_to: `${adapterMeta.googleAds.idValue}/${label}`, value, currency: payload.currency, transaction_id: payload.transactionId })
    }
  },
  meta: {
    category: 'marketing',
    lib: 'meta',
    idKey: 'idValue',
    track(name, payload) {
      const fbq = window.fbq
      if (typeof fbq !== 'function') return
      if (name === 'purchase') {
        const value = toMajorUnits(payload.valueMinor)
        fbq('track', 'Purchase', { value, currency: payload.currency, content_ids: purchaseIds(payload), content_type: 'product', contents: contents(payload) })
        return
      }
      if (name === 'customize_product') {
        fbq('trackCustom', 'CustomizeProduct', { content_ids: ids(payload), content_type: 'product' })
        return
      }
      const mapped = META_EVENTS[name]
      if (!mapped) return
      fbq('track', mapped, metaParams(name, payload))
    }
  },
  tiktok: {
    category: 'marketing',
    lib: 'tiktok',
    idKey: 'idValue',
    track(name, payload) {
      const ttq = window.ttq
      if (!ttq || typeof ttq.track !== 'function') return
      if (name === 'purchase') {
        const value = toMajorUnits(payload.valueMinor)
        ttq.track('Purchase', { value, currency: payload.currency, contents: ttContents(payload), content_type: 'product' })
        return
      }
      const mapped = TIKTOK_EVENTS[name]
      if (!mapped) return
      ttq.track(mapped, tiktokParams(name, payload))
    }
  }
}

const META_EVENTS = {
  page_view: 'PageView',
  view_product: 'ViewContent',
  search: 'Search',
  add_to_cart: 'AddToCart',
  begin_checkout: 'InitiateCheckout',
  registration: 'CompleteRegistration'
}
const TIKTOK_EVENTS = {
  page_view: 'PageView',
  view_product: 'ViewContent',
  search: 'Search',
  add_to_cart: 'AddToCart',
  begin_checkout: 'InitiateCheckout',
  registration: 'CompleteRegistration',
  customize_product: 'CustomizeProduct'
}
const GA4_EVENTS = {
  page_view: 'page_view',
  view_product: 'view_item',
  search: 'search',
  add_to_cart: 'add_to_cart',
  begin_checkout: 'begin_checkout',
  registration: 'sign_up',
  customize_product: 'custom',
  purchase: 'purchase'
}

function ids(payload) {
  return payload.slug ? [payload.slug] : undefined
}
function purchaseIds(payload) {
  const items = Array.isArray(payload.items) ? payload.items : []
  const list = items.map((i) => i && i.slug).filter(Boolean)
  return list.length ? list : ids(payload)
}
function contents(payload) {
  const qty = Number(payload.quantity) || 1
  return payload.slug ? [{ id: payload.slug, quantity: qty }] : undefined
}
function ttContents(payload) {
  const qty = Number(payload.quantity) || 1
  return payload.slug ? [{ content_id: payload.slug, content_type: 'product', quantity: qty }] : undefined
}
function metaParams(name, payload) {
  const out = {}
  if (payload.slug) {
    out.content_ids = [payload.slug]
    out.content_type = 'product'
  }
  if (payload.category) out.content_category = payload.category
  if (payload.quantity != null) out.num_items = Number(payload.quantity) || 1
  if (name === 'search') {
    // Only the fact a search happened — never the (potentially personal) term.
    out.search_string = undefined
  }
  if (payload.currency) out.currency = payload.currency
  const value = toMajorUnits(payload.valueMinor)
  if (value !== undefined) out.value = value
  return out
}
function tiktokParams(name, payload) {
  const out = {}
  if (payload.slug) {
    out.contents = ttContents(payload)
    out.content_type = 'product'
  }
  const value = toMajorUnits(payload.valueMinor)
  if (value !== undefined) out.value = value
  if (payload.currency) out.currency = payload.currency
  return out
}
function ga4Params(name, payload) {
  const out = {}
  if (name === 'page_view') {
    out.page_location = location.href
    out.page_title = document.title
    if (payload && payload.pageType) out.page_type = payload.pageType
    return out
  }
  if (payload.slug) {
    out.items = [{ item_id: payload.slug, item_category: payload.category, item_variant: payload.variantCode || payload.coverType }].filter((it) => it.item_category !== undefined || it.item_variant !== undefined || it.item_id)
  }
  if (payload.currency) out.currency = payload.currency
  const value = toMajorUnits(payload.valueMinor)
  if (value !== undefined) out.value = value
  if (name === 'search') out.search_term = undefined
  return out
}

// ---------------------------------------------------------------------------
// adapter loading (NEVER before consent)
// ---------------------------------------------------------------------------
function googleIds() {
  return (cfg.adapters || []).filter((a) => a.id === 'ga4' || a.id === 'googleAds').map((a) => a.idValue)
}

function ensureLoaded(lib) {
  if (lib === 'google') {
    if (loaded.google || !googleIds().length) return
    const primary = googleIds()[0]
    loaded.google = true
    loadScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(primary)}`, 'ww-gtag')
      .then(() => {
        window.dataLayer = window.dataLayer || []
        function gtag() {
          window.dataLayer.push(arguments)
        }
        window.gtag = window.gtag || gtag
        window.gtag('js', new Date())
        pushConsentUpdate()
        for (const a of cfg.adapters || []) {
          if (a.id === 'ga4') window.gtag('config', a.idValue, { anonymize_ip: true, send_page_view: false })
          if (a.id === 'googleAds') window.gtag('config', a.idValue)
        }
        ready.google = true
        flushQueue('google')
      })
      .catch(() => {
        loaded.google = false
      })
    return
  }
  if (lib === 'meta') {
    if (loaded.meta) return
    const a = (cfg.adapters || []).find((x) => x.id === 'meta')
    if (!a) return
    loaded.meta = true
    loadScript('https://connect.facebook.net/en_US/fbevents.js', 'ww-fbevents')
      .then(() => {
        if (typeof window.fbq === 'function') {
          window.fbq('init', a.idValue)
          window.fbq('consent', 'grant')
        }
        ready.meta = true
        flushQueue('meta')
      })
      .catch(() => {
        loaded.meta = false
      })
    return
  }
  if (lib === 'tiktok') {
    if (loaded.tiktok) return
    const a = (cfg.adapters || []).find((x) => x.id === 'tiktok')
    if (!a) return
    loaded.tiktok = true
    loadScript('https://analytics.tiktok.com/i18n/pixel/events.js', 'ww-tiktok')
      .then(() => {
        if (window.ttq && typeof window.ttq.load === 'function') window.ttq.load(a.idValue)
        ready.tiktok = true
        flushQueue('tiktok')
      })
      .catch(() => {
        loaded.tiktok = false
      })
  }
}

function flushQueue(lib) {
  const q = queues[lib]
  queues[lib] = []
  for (const fn of q) {
    try {
      fn()
    } catch {
      /* a single queued event must not break the rest */
    }
  }
}

function forEachAdapter(fn) {
  for (const a of cfg.adapters || []) {
    const adapter = ADAPTERS[a.id]
    if (!adapter) continue
    if (!categoryAllowed(adapter.category)) continue
    if (!ready[adapter.lib]) {
      queues[adapter.lib].push(() => {
        if (categoryAllowed(adapter.category)) {
          try {
            adapter.track(...fn.for(a.id))
          } catch {}
        }
      })
      ensureLoaded(adapter.lib)
      continue
    }
    try {
      adapter.track(...fn.for(a.id))
    } catch {
      /* vendor failure must never break the page */
    }
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------
const PURCHASE_GATE_OPEN = false // flipped only by the verified-payment phase

export function track(name, payload) {
  try {
    if (inert || revoked || !cfg || !cfg.enabled) return
    if (name === 'purchase' && !PURCHASE_GATE_OPEN) return // Purchase is safely blocked
    const { clean, forbidden } = sanitize(payload)
    if (forbidden.length) return // refuse rather than leak
    if (!consent) return
    if (!categoryAllowed('analytics') && !categoryAllowed('marketing')) return
    forEachAdapter({
      for: () => [name, clean]
    })
  } catch {
    /* never break the page */
  }
}

/** Fire at most once for a given dedupe key (persisted for the session). */
export function trackOnce(name, payload, dedupeKey) {
  try {
    const key = `${name}:${dedupeKey}`
    const seen = readSeen()
    if (seen.has(key)) return
    markSeen(key)
    track(name, payload)
  } catch {
    /* never break the page */
  }
}

export function getConsent() {
  return consent
}

// ---------------------------------------------------------------------------
// page views (once per distinct navigation; SPA-safe)
// ---------------------------------------------------------------------------
function firePageView() {
  const path = location.pathname + location.search
  if (path === lastPageViewPath) return
  lastPageViewPath = path
  track('page_view', { pageType: cfg.pageType })
  if (cfg.pageType === 'product') {
    const m = location.pathname.match(/^\/(?:books|stickers)\/([^/]+)$/)
    if (m) track('view_product', { slug: decodeURIComponent(m[1]), category: location.pathname.startsWith('/stickers') ? 'sticker' : 'book', currency: document.body?.dataset?.currency || undefined })
  }
  if (cfg.pageType === 'catalog' && location.search) {
    try {
      const q = new URLSearchParams(location.search).get('q')
      if (q) track('search', {}) // never the term itself
    } catch {}
  }
}

function wireHistory() {
  const wrap = (type) => {
    const original = history[type]
    if (typeof original !== 'function') return
    history[type] = function (...args) {
      const result = original.apply(this, args)
      try {
        firePageView()
      } catch {}
      return result
    }
  }
  wrap('pushState')
  wrap('replaceState')
  window.addEventListener('popstate', () => {
    try {
      firePageView()
    } catch {}
  })
}

// ---------------------------------------------------------------------------
// attribution (only with marketing consent; minimal, expiring)
// ---------------------------------------------------------------------------
function captureAttribution() {
  try {
    const params = new URLSearchParams(location.search)
    const found = {}
    for (const key of ATTR_KEYS) {
      const v = params.get(key)
      if (v && v.length <= 100) found[key] = v
    }
    if (!Object.keys(found).length) return
    found.ts = Date.now()
    writeCookie(ATTR_COOKIE, JSON.stringify(found), ATTR_MAX_AGE_SECONDS)
  } catch {
    /* attribution is best-effort and never affects price/ownership/checkout */
  }
}

// ---------------------------------------------------------------------------
// consent UI
// ---------------------------------------------------------------------------
function panel() {
  return document.getElementById('cookie-consent')
}
function hidePanel() {
  const p = panel()
  if (p) p.setAttribute('hidden', '')
}
function showPanel() {
  const p = panel()
  if (!p) return
  p.removeAttribute('hidden')
  const first = p.querySelector('#cookie-save')
  if (first && typeof first.focus === 'function') first.focus()
}

function applyConsent() {
  try {
    pushConsentUpdate()
    if (consent && consent.marketing) {
      captureAttribution()
      if (hasAdapter('meta')) ensureLoaded('meta')
      if (hasAdapter('tiktok')) ensureLoaded('tiktok')
      if (hasAdapter('googleAds')) ensureLoaded('google')
    } else {
      revokeMarketing()
    }
    if (consent && consent.analytics && hasAdapter('ga4')) ensureLoaded('google')
    if (consent && !consent.analytics && !consent.marketing) revoked = true
    else revoked = false
  } catch {
    /* never break the page */
  }
  firePageView()
}

function hasAdapter(id) {
  return !!(cfg && (cfg.adapters || []).some((a) => a.id === id))
}

function revokeMarketing() {
  // Stop sending and clear the vendor cookies we are able to clear.
  try {
    if (window.fbq && typeof window.fbq === 'function') window.fbq('consent', 'revoke')
  } catch {}
  for (const name of ['_fbp', '_fbc', '_gcl_au', '_ga', '_gid', '_tt_enable_cookie', '_ttp', 'ttclid']) {
    eraseCookie(name)
  }
}

function save(state) {
  consent = { v: CONSENT_VERSION, analytics: state.analytics === true, marketing: state.marketing === true, ts: Date.now() }
  writeCookie(CONSENT_COOKIE, serializeConsent(consent), CONSENT_MAX_AGE_SECONDS)
  applyConsent()
  hidePanel()
}

function wireConsentUi() {
  const form = document.getElementById('cookie-consent-form')
  const analyticsBox = document.getElementById('consent-analytics')
  const marketingBox = document.getElementById('consent-marketing')
  const acceptAll = document.getElementById('cookie-accept-all')
  const reject = document.getElementById('cookie-reject')
  const open = document.getElementById('cookie-preferences-open')

  acceptAll?.addEventListener('click', () => save({ analytics: true, marketing: true }))
  reject?.addEventListener('click', () => save({ analytics: false, marketing: false }))
  form?.addEventListener('submit', (e) => {
    e.preventDefault()
    save({ analytics: !!analyticsBox?.checked, marketing: !!marketingBox?.checked })
  })
  open?.addEventListener('click', (e) => {
    e.preventDefault()
    showPanel()
  })
}

// ---- registration: emitted ONLY after a successful account creation ----
function wireRegistration() {
  const form = document.getElementById('register-form') || document.querySelector('form[action="/register"]')
  if (!form) return
  form.addEventListener('submit', async (e) => {
    if (form.dataset.wwHooked) return
    if (!consent || (!consent.analytics && !consent.marketing)) return // let the normal submit happen
    e.preventDefault()
    form.dataset.wwHooked = '1'
    try {
      const res = await fetch(form.action || '/register', { method: 'POST', body: new FormData(form), credentials: 'same-origin', redirect: 'follow' })
      const finalPath = new URL(res.url, location.origin).pathname
      if (res.ok && finalPath !== '/register') {
        trackOnce('registration', {}, 'account')
        location.assign(res.url || '/my-books')
        return
      }
      form.dataset.wwHooked = ''
      form.submit()
    } catch {
      form.dataset.wwHooked = ''
      form.submit()
    }
  })
}

// ---------------------------------------------------------------------------
// init — fail open at every step
// ---------------------------------------------------------------------------
function init() {
  try {
    cfg = readConfig()
    // Always wire the footer's preference entry so a visitor can change their
    // mind even when no vendor is configured.
    wireConsentUi()
    if (!cfg || !cfg.enabled) {
      inert = true
      return
    }
    if (cfg.suppressAutomation && navigator.webdriver) {
      inert = true
      return
    }
    for (const a of cfg.adapters || []) adapterMeta[a.id] = a
    pushConsentDefault() // no network; gtag reads this the moment it loads
    consent = parseConsent(readCookie(CONSENT_COOKIE))
    applyConsent()
    wireHistory()
    wireRegistration()
  } catch {
    inert = true
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

// Expose the shared API for non-module consumers too.
try {
  window.wwAnalytics = { track, trackOnce, getConsent }
} catch {
  /* ignore */
}
