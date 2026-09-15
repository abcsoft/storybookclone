// Country / currency / language resolution for the storefront (V2 Phase 2).
//
// Scope: SF-03, PLT-06, PLT-07.
//
// THE RULES THIS FILE ENFORCES
//   1. Availability is SERVER data. The countries and currencies a visitor may
//      choose come from `countries` / `currency_settings`; a requested value
//      that is not in that set is ignored (the server falls back), never
//      trusted. The browser cannot select a currency the server does not sell
//      in.
//   2. Every price is an INTEGER MINOR UNIT amount in an ISO-4217 currency and
//      comes from the database (product_prices / variant_prices). Nothing is
//      converted client-side and no exchange-rate provider is called: the
//      documented static catalogue prices ARE the prices.
//   3. The choice is PERSISTED in a cookie the server reads on the next
//      request, so the storefront, the cart quote and the order all agree.
//   4. Content localisation is honest: `languages` lists what is configured,
//      and a language with no published content is labelled as such rather
//      than presented as translated.

import { getCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'

export const COUNTRY_COOKIE = 'ww_country'
export const CURRENCY_COOKIE = 'ww_currency'
export const LANGUAGE_COOKIE = 'ww_lang'
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 180

export type CurrencySettings = {
  code: string
  symbol: string
  symbolPosition: 'before' | 'after'
  decimalSeparator: string
  thousandsSeparator: string
}

export type CurrencyOption = CurrencySettings & { enabled: boolean; sortOrder: number }
export type CountryOption = { code: string; name: string; currency: string; sortOrder: number }
export type LanguageOption = { code: string; name: string; nativeName: string; direction: 'ltr' | 'rtl'; fallbackCode: string | null }

export type StoreContext = {
  country: string
  countryName: string
  currency: string
  currencySettings: CurrencySettings
  countries: CountryOption[]
  currencies: CurrencyOption[]
  languages: LanguageOption[]
  /** BCP-47 tag for <html lang>. */
  htmlLang: string
  /** Writing direction of the RESOLVED content language. */
  dir: 'ltr' | 'rtl'
  /** True when the storefront has published content in `contentLanguage`. */
  contentLanguage: string
  hasTranslatedContent: boolean
  /** Languages that have at least one PUBLISHED localization row. */
  languagesWithContent: string[]
  /** Country chosen explicitly by the visitor (false = server default). */
  selected: boolean
}

const FALLBACK_CURRENCY: CurrencySettings = {
  code: 'USD',
  symbol: '$',
  symbolPosition: 'before',
  decimalSeparator: '.',
  thousandsSeparator: ','
}

/**
 * Formats an integer minor-unit amount. `minorUnits` is the currency's own
 * exponent (0 for JPY/KRW), so a zero-exponent currency is never rendered with
 * a fake decimal part.
 */
export function formatMoney(minor: number, settings: CurrencySettings, minorUnits = 2): string {
  const negative = minor < 0
  const abs = BigInt(Math.abs(Math.round(minor)))
  const divisor = 10n ** BigInt(minorUnits)
  const whole = abs / divisor
  const frac = abs % divisor
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, settings.thousandsSeparator)
  const fracText = minorUnits > 0 ? settings.decimalSeparator + frac.toString().padStart(minorUnits, '0') : ''
  const amount = wholeText + fracText
  const withSign = negative ? `-${amount}` : amount
  return settings.symbolPosition === 'after' ? `${withSign} ${settings.symbol}` : `${settings.symbol}${withSign}`
}

/** Parses a price amount into minor units using the currency's own exponent. */
export function toMinor(major: number, minorUnits = 2): number {
  return Math.round(Number(major) * 10 ** minorUnits)
}

/** Currencies with no minor unit; everything else here uses 2. */
export function minorUnitsFor(currency: string): number {
  return currency === 'JPY' || currency === 'KRW' ? 0 : 2
}

export function formatMoneyForCurrency(minor: number, settings: CurrencySettings): string {
  return formatMoney(minor, settings, minorUnitsFor(settings.code))
}

type Row = Record<string, unknown>

export async function loadCountries(db: D1Database): Promise<CountryOption[]> {
  const { results } = await db
    .prepare(
      `SELECT c.code, c.name, c.currency, c.sort_order
         FROM countries c
         JOIN currency_settings cs ON cs.code = c.currency AND cs.enabled = 1
        WHERE c.active = 1
        ORDER BY c.sort_order, c.code`
    )
    .all<Row>()
  return (results || []).map((r) => ({
    code: String(r.code),
    name: String(r.name),
    currency: String(r.currency),
    sortOrder: Number(r.sort_order) || 0
  }))
}

export async function loadCurrencies(db: D1Database): Promise<CurrencyOption[]> {
  const { results } = await db
    .prepare(
      `SELECT cs.code, cs.symbol, cs.symbol_position, cs.decimal_separator, cs.thousands_separator, cs.enabled, cs.sort_order
         FROM currency_settings cs ORDER BY cs.sort_order, cs.code`
    )
    .all<Row>()
  return (results || []).map(toCurrencyOption)
}

function toCurrencyOption(r: Row): CurrencyOption {
  return {
    code: String(r.code),
    symbol: String(r.symbol),
    symbolPosition: (String(r.symbol_position) === 'after' ? 'after' : 'before') as 'before' | 'after',
    decimalSeparator: String(r.decimal_separator || '.'),
    thousandsSeparator: String(r.thousands_separator || ','),
    enabled: Number(r.enabled) === 1,
    sortOrder: Number(r.sort_order) || 0
  }
}

export async function loadLanguages(db: D1Database): Promise<LanguageOption[]> {
  const { results } = await db
    .prepare('SELECT code, name, native_name, direction, fallback_code FROM languages WHERE active = 1 ORDER BY code')
    .all<Row>()
  return (results || []).map((r) => ({
    code: String(r.code),
    name: String(r.name),
    nativeName: String(r.native_name),
    direction: (String(r.direction) === 'rtl' ? 'rtl' : 'ltr') as 'ltr' | 'rtl',
    fallbackCode: r.fallback_code == null ? null : String(r.fallback_code)
  }))
}

/**
 * The languages that GENUINELY have published content. Two indexed DISTINCT
 * lookups, and the answer is only ever true because a published row exists —
 * an "active" language with no translations is not reported as translated.
 */
export async function loadLanguagesWithContent(db: D1Database): Promise<Set<string>> {
  const withContent = new Set<string>()
  const { results } = await db.prepare("SELECT DISTINCT language_code FROM product_localizations WHERE status = 'published'").all<Row>()
  for (const r of results || []) withContent.add(String(r.language_code))
  const { results: pageRows } = await db.prepare("SELECT DISTINCT language_code FROM cms_page_localizations WHERE status = 'published'").all<Row>()
  for (const r of pageRows || []) withContent.add(String(r.language_code))
  return withContent
}

export type ResolveStoreOptions = {
  /** Country requested by the visitor (?country=), validated against the DB. */
  requestedCountry?: string
  requestedCurrency?: string
  requestedLanguage?: string
  /** Write the resolved choice back as a cookie (only on an explicit choice). */
  persist?: boolean
}

/**
 * Resolves the store context for a request. Unknown/disabled values are
 * IGNORED and the server's first enabled country/currency is used instead, so
 * a caller can never widen availability by asking for it.
 */
export async function resolveStoreContext(
  db: D1Database,
  cookieValues: { country?: string; currency?: string; lang?: string },
  opts: ResolveStoreOptions = {}
): Promise<StoreContext> {
  const countries = await loadCountries(db)
  const currencies = await loadCurrencies(db)
  const languages = await loadLanguages(db)
  const withContent = await loadLanguagesWithContent(db)

  const enabledCurrencies = currencies.filter((c) => c.enabled)
  const byCountry = new Map(countries.map((c) => [c.code.toUpperCase(), c]))
  const byCurrency = new Map(enabledCurrencies.map((c) => [c.code.toUpperCase(), c]))

  const pick = (v: string | undefined) => (v ? v.trim().toUpperCase() : '')
  const requestedCountry = pick(opts.requestedCountry)
  let chosen = requestedCountry ? byCountry.get(requestedCountry) : undefined
  let selected = !!chosen

  if (!chosen) {
    const fromCookie = pick(cookieValues.country)
    chosen = (fromCookie ? byCountry.get(fromCookie) : undefined) || undefined
  }
  if (!chosen) {
    const cookieCurrency = pick(cookieValues.currency)
    if (cookieCurrency && byCurrency.has(cookieCurrency)) {
      chosen = countries.find((c) => c.currency.toUpperCase() === cookieCurrency)
    }
  }
  if (!chosen) {
    const requested = pick(opts.requestedCurrency)
    if (requested && byCurrency.has(requested)) chosen = countries.find((c) => c.currency.toUpperCase() === requested)
  }

  // Server default: the first enabled country, or a currency-only fallback when
  // no country is configured at all (an empty `countries` table must not break
  // the storefront).
  if (!chosen) {
    chosen = countries[0]
    selected = false
  }
  let currencyCode = chosen ? chosen.currency.toUpperCase() : enabledCurrencies[0]?.code || FALLBACK_CURRENCY.code
  if (!byCurrency.has(currencyCode)) currencyCode = enabledCurrencies[0]?.code || FALLBACK_CURRENCY.code
  const currencySettings = byCurrency.get(currencyCode) || { ...FALLBACK_CURRENCY, enabled: true, sortOrder: 0 }

  const contentLanguage = 'en'
  const requestedLanguage = (opts.requestedLanguage || cookieValues.lang || '').trim()
  const activeLanguage = languages.find((l) => l.code === (requestedLanguage || contentLanguage)) || languages.find((l) => l.code === contentLanguage)
  const hasTranslatedContent = withContent.has(activeLanguage?.code || contentLanguage)

  return {
    country: chosen ? chosen.code : 'US',
    countryName: chosen ? chosen.name : 'United States',
    currency: currencySettings.code,
    currencySettings,
    countries,
    currencies,
    languages,
    htmlLang: activeLanguage ? activeLanguage.code : contentLanguage,
    // Direction follows the RESOLVED language's own row. With no RTL content
    // published, this stays 'ltr' — an RTL shell with LTR text would be worse
    // than no RTL support at all.
    dir: hasTranslatedContent && activeLanguage?.direction === 'rtl' ? 'rtl' : 'ltr',
    contentLanguage,
    hasTranslatedContent,
    languagesWithContent: [...withContent],
    selected
  }
}

/** Persists the visitor's explicit choice. Called only after validation. */
export function persistStoreChoice(
  c: Context,
  choice: { country?: string; currency?: string; lang?: string },
  env: { ENVIRONMENT?: string } | undefined
) {
  const secure = (env?.ENVIRONMENT || '').toLowerCase() === 'production'
  const base = { path: '/', httpOnly: false, sameSite: 'Lax' as const, secure, maxAge: LOCALE_COOKIE_MAX_AGE }
  if (choice.country) setCookie(c, COUNTRY_COOKIE, choice.country.toUpperCase(), base)
  if (choice.currency) setCookie(c, CURRENCY_COOKIE, choice.currency.toUpperCase(), base)
  if (choice.lang) setCookie(c, LANGUAGE_COOKIE, choice.lang, base)
}

export function readStoreCookies(c: Context) {
  return {
    country: getCookie(c, COUNTRY_COOKIE),
    currency: getCookie(c, CURRENCY_COOKIE),
    lang: getCookie(c, LANGUAGE_COOKIE)
  }
}
