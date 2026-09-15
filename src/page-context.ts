// Per-request page context (V2 Phase 2).
//
// One middleware loads everything the shell needs — the CMS navigation/footer/
// banner, the store country/currency/language context, and the brand overlay
// from `site_settings` — and stashes it in the request-scoped Hono variables.
// Templates then read it synchronously, so no renderer has to thread `env`,
// `db` or a currency through its signature.
//
// It is deliberately ALLOWED TO DEGRADE: if a CMS read fails (e.g. an operator
// dropped a table), the storefront still renders with the built-in defaults
// instead of 500ing. The failure is logged, never hidden behind a fake
// success.

import type { Context } from 'hono'
import { page, type PageMeta } from './layout'
import { loadShell, loadSiteSettings, type StoreShell } from './cms'
import {
  formatMoneyForCurrency,
  readStoreCookies,
  resolveStoreContext,
  type StoreContext
} from './locale'
import { configureBrand } from './brand'
import type { Money } from './pages'

export type PageContextVars = {
  user: unknown
  requestId: string | null
  csrfToken?: string
  shell: StoreShell
  store: StoreContext
  origin: string
}

const EMPTY_SHELL: StoreShell = {
  primaryNav: [],
  mobileNav: [],
  footerColumns: [],
  footerNotes: [],
  announcements: []
}

/** The last-resort store context, used only when the locale tables are unreadable. */
const EMPTY_STORE: StoreContext = {
  country: 'US',
  countryName: 'United States',
  currency: 'USD',
  currencySettings: { code: 'USD', symbol: '$', symbolPosition: 'before', decimalSeparator: '.', thousandsSeparator: ',' },
  countries: [],
  currencies: [],
  languages: [{ code: 'en', name: 'English', nativeName: 'English', direction: 'ltr', fallbackCode: null }],
  htmlLang: 'en',
  dir: 'ltr',
  contentLanguage: 'en',
  hasTranslatedContent: false,
  languagesWithContent: [],
  selected: false
}

/** Loads the shell + store context for this request and stores them on the context. */
export async function loadPageContext(c: Context<any>): Promise<{ shell: StoreShell; store: StoreContext; origin: string }> {
  const db = c.env?.DB as D1Database | undefined
  const origin = new URL(c.req.url).origin
  let shell: StoreShell = EMPTY_SHELL
  let store: StoreContext = EMPTY_STORE

  if (db) {
    try {
      // Settings FIRST: the brand overlay must be applied before anything
      // renders, and the shell/store reads below are independent of it.
      const settings = await loadSiteSettings(db)
      configureBrand(c.env, settings)
      shell = await loadShell(db)
      store = await resolveStoreContext(db, readStoreCookies(c), {
        requestedCountry: c.req.query('country'),
        requestedCurrency: c.req.query('currency'),
        requestedLanguage: c.req.query('lang')
      })
    } catch (err) {
      console.error(`[page-context] CMS/locale read failed, rendering built-in defaults: ${(err as Error)?.message}`)
    }
  }

  c.set('shell', shell)
  c.set('store', store)
  c.set('origin', origin)
  return { shell, store, origin }
}

export function storeOf(c: Context<any>): StoreContext {
  return (c.get('store') as StoreContext) || EMPTY_STORE
}

export function shellOf(c: Context<any>): StoreShell {
  return (c.get('shell') as StoreShell) || EMPTY_SHELL
}

export function originOf(c: Context<any>): string {
  return (c.get('origin') as string) || new URL(c.req.url).origin
}

/** The currency-aware money formatter for this request. */
export function moneyOf(c: Context<any>): Money {
  const store = storeOf(c)
  return (minor: number) => formatMoneyForCurrency(minor, store.currencySettings)
}

export type RenderOptions = {
  active?: string
  description?: string
  status?: number
  meta?: PageMeta
  notFound?: boolean
}

/**
 * Renders a full page. `meta` carries canonical/robots/OG/JSON-LD; when it is
 * omitted the renderer still emits a description and the brand suffix.
 */
export function renderPage(c: Context<any>, title: string, body: string, opts: RenderOptions = {}) {
  const store = storeOf(c)
  const html = page({
    title,
    body,
    description: opts.description,
    active: opts.active,
    loggedIn: !!(c.get('user') as { id?: number } | null),
    shell: shellOf(c),
    store,
    meta: opts.meta,
    path: new URL(c.req.url).pathname,
    notFound: opts.notFound
  })
  return opts.status ? c.html(html, opts.status as any) : c.html(html)
}

/** Legacy positional signature used by the pre-Phase-2 routes. */
export function html(c: Context<any>, title: string, body: string, active?: string, description?: string, status?: number) {
  return renderPage(c, title, body, { active, description, status })
}

/** A missing resource is a genuine 404, never a 200 with a "not found" body (T-07). */
export function htmlNotFound(c: Context<any>) {
  return renderPage(c, 'Not found', notFoundBody(), { status: 404, notFound: true, meta: { robots: 'noindex,follow' } })
}

function notFoundBody(): string {
  return `
  <section class="page-hero">
    <div class="wrap">
      <h1>Page Not Found</h1>
      <p>The page, story or article you are looking for does not exist.</p>
      <p><a class="btn btn-primary" href="/">Return to the home page</a></p>
    </div>
  </section>`
}
