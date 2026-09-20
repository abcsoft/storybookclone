// Central, vendor-neutral MARKETING ANALYTICS configuration.
//
// One module owns three things so nothing can drift apart:
//   1. WHICH vendor adapters exist and whether each is configured — resolved
//      from the Worker ENVIRONMENT ONLY (never hard-coded, never from a DB
//      row an admin can edit into a script tag).
//   2. Whether marketing tracking is switched on at all (the master switch).
//   3. Which public routes may carry tracking, and the exact CSP hosts the
//      configured adapters require.
//
// PRIVACY / SECURITY POSTURE
//   * Every vendor id is validated against a STRICT allowlisted shape. A value
//     that does not match is treated as INVALID: that ONE adapter is disabled
//     (fail closed) and a clear, non-secret diagnostic is produced. A missing
//     id simply means "not configured" — no broken script tag is ever emitted.
//   * IDs are PUBLIC values (they appear in any site's page source), but the
//     admin diagnostics screen still shows only a MASKED form. No secret or
//     token is ever placed in HTML or returned from an API.
//   * There is deliberately NO "custom tracking script" field anywhere: an
//     administrator can never inject raw JS.
//
// The vendor libraries are NEVER loaded by this module (it is server-side and
// makes no outbound request). It only reports configuration; the browser
// bundle (public/static/analytics.js) loads a vendor library only after the
// visitor has granted the matching consent.
import { CONSENT_VERSION } from './consent'

export type AdapterId = 'meta' | 'tiktok' | 'ga4' | 'googleAds'

export type AdapterState = {
  id: AdapterId
  /** True only when an id is present AND matches the allowlisted shape. */
  configured: boolean
  /** A masked, non-secret display form (e.g. `123…45`), or null when absent. */
  masked: string | null
  /** A clear, non-secret validation error, or null when valid/absent. */
  error: string | null
}

export type MarketingConfig = {
  /** The master switch (`MARKETING_TRACKING_ENABLED`). */
  enabled: boolean
  /** Per-adapter resolution state, always all four, in a stable order. */
  adapters: AdapterState[]
  /** Human-readable, non-secret notes for the admin/server diagnostic. */
  diagnostics: string[]
}

/** The narrow environment this module reads. All optional: absence = off. */
export type MarketingEnv = {
  MARKETING_TRACKING_ENABLED?: string
  META_PIXEL_ID?: string
  TIKTOK_PIXEL_ID?: string
  GA4_MEASUREMENT_ID?: string
  GOOGLE_ADS_ID?: string
  GOOGLE_ADS_PURCHASE_LABEL?: string
  ENVIRONMENT?: string
  /**
   * Development-only escape hatch so the automated browser journey can prove
   * the consent-gated request behaviour. It is IGNORED outside an explicitly
   * configured development environment, so a production page never tracks an
   * automated session.
   */
  MARKETING_ALLOW_AUTOMATION?: string
}

/** A truthy env flag. Anything else (including absent) is false. */
export function flagOn(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())
}

// --------------------------------------------------------------------------
// Strict allowlisted id shapes
// --------------------------------------------------------------------------
const META_PIXEL_RE = /^[0-9]{15,16}$/
// TikTok pixel ids are 20-character uppercase alphanumeric strings.
const TIKTOK_PIXEL_RE = /^[A-Z0-9]{20}$/
const GA4_ID_RE = /^G-[A-Z0-9]{6,14}$/
const GOOGLE_ADS_ID_RE = /^AW-[0-9]{6,12}$/
const PURCHASE_LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/

const ID_RULES: Record<AdapterId, { envKey: keyof MarketingEnv; re: RegExp; label: string }> = {
  meta: { envKey: 'META_PIXEL_ID', re: META_PIXEL_RE, label: 'Meta Pixel ID (15–16 digits)' },
  tiktok: { envKey: 'TIKTOK_PIXEL_ID', re: TIKTOK_PIXEL_RE, label: 'TikTok Pixel ID (20 uppercase alphanumeric characters)' },
  ga4: { envKey: 'GA4_MEASUREMENT_ID', re: GA4_ID_RE, label: 'GA4 measurement ID (G-…)' },
  googleAds: { envKey: 'GOOGLE_ADS_ID', re: GOOGLE_ADS_ID_RE, label: 'Google Ads ID (AW-…)' }
}

const ADAPTER_ORDER: AdapterId[] = ['meta', 'tiktok', 'ga4', 'googleAds']

/** A masked display form of an id: enough to recognise, never the whole value. */
export function maskId(value: string): string {
  const s = String(value)
  if (s.length <= 4) return '•'.repeat(s.length)
  return `${s.slice(0, 2)}…${s.slice(-2)}`
}

function resolveAdapter(env: MarketingEnv, id: AdapterId): AdapterState {
  const rule = ID_RULES[id]
  const raw = String(env[rule.envKey] ?? '').trim()
  if (!raw) return { id, configured: false, masked: null, error: null }
  // Google Ads also requires a conversion label to emit purchase conversions;
  // a configured ad id WITHOUT a label still permits non-purchase events, but
  // the purchase conversion simply will not be sent. Validate the label's shape
  // independently so a malformed label cannot smuggle anything.
  if (id === 'googleAds') {
    const label = String(env.GOOGLE_ADS_PURCHASE_LABEL ?? '').trim()
    if (label && !PURCHASE_LABEL_RE.test(label)) {
      return { id, configured: false, masked: maskId(raw), error: `GOOGLE_ADS_PURCHASE_LABEL is not a valid conversion label.` }
    }
  }
  if (!rule.re.test(raw)) {
    return { id, configured: false, masked: maskId(raw), error: `${rule.label} is not a valid format. This adapter is disabled.` }
  }
  return { id, configured: true, masked: maskId(raw), error: null }
}

/**
 * Resolve the whole configuration from the environment. Pure and synchronous,
 * so it is cheap to call per request and trivial to unit test.
 */
export function resolveMarketingConfig(env: MarketingEnv | undefined): MarketingConfig {
  const e: MarketingEnv = env ?? {}
  const enabled = flagOn(e.MARKETING_TRACKING_ENABLED)
  const adapters = ADAPTER_ORDER.map((id) => resolveAdapter(e, id))
  const diagnostics: string[] = []
  if (!enabled) {
    diagnostics.push('Marketing tracking is switched off (MARKETING_TRACKING_ENABLED is not set). No vendor script is loaded.')
  }
  for (const a of adapters) {
    if (a.error) diagnostics.push(`${a.id}: ${a.error}`)
  }
  const configuredCount = adapters.filter((a) => a.configured).length
  if (enabled && configuredCount === 0) {
    diagnostics.push('Marketing tracking is enabled but no adapter id is configured, so nothing is loaded.')
  }
  return { enabled, adapters, diagnostics }
}

export function adapterState(config: MarketingConfig, id: AdapterId): AdapterState {
  return config.adapters.find((a) => a.id === id) ?? { id, configured: false, masked: null, error: null }
}

/** True when at least one adapter is configured AND the master switch is on. */
export function marketingActive(config: MarketingConfig): boolean {
  return config.enabled && config.adapters.some((a) => a.configured)
}

/**
 * The dev-only automation escape hatch. It is armed ONLY when the explicit flag
 * is set AND the environment is an explicitly configured development one.
 */
export function automationAllowed(env: MarketingEnv | undefined): boolean {
  return flagOn(env?.MARKETING_ALLOW_AUTOMATION) && String(env?.ENVIRONMENT ?? '') === 'development'
}

// --------------------------------------------------------------------------
// Route / privacy rules
// --------------------------------------------------------------------------
//
// Tracking is permitted ONLY on an explicit allowlist of PUBLIC storefront
// routes. Everything else — /admin*, /api*, the account and library surfaces,
// private photo/download and reader routes, order-success (which carries a
// guest capability token), and every token-landing route — is refused by
// default. This is deliberately FAIL-CLOSED: a newly added private route is
// untracked until someone consciously adds it here.
const TRACKABLE_EXACT = new Set(['/'])
const TRACKABLE_PREFIXES = [
  '/books',
  '/stickers',
  '/collections',
  '/cart',
  '/checkout',
  '/faqs',
  '/support',
  '/how-it-works',
  '/contact',
  '/blog',
  '/login',
  '/register',
  '/forgot-password'
]

/** Routes that must NEVER carry tracking, even if a prefix above would match. */
const DENY_PREFIXES = [
  '/admin',
  '/api',
  '/my',
  '/account',
  '/order-success',
  '/photos',
  '/reset-password',
  '/verify-email'
]

export function marketingPathAllowed(pathname: string): boolean {
  const path = pathname || '/'
  if (DENY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return false
  if (TRACKABLE_EXACT.has(path)) return true
  return TRACKABLE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
}

// --------------------------------------------------------------------------
// Browser bootstrap (the ONLY server→browser marketing payload)
// --------------------------------------------------------------------------

export type MarketingBootstrapAdapter = { id: AdapterId; idValue: string; purchaseLabel?: string }

export type MarketingBootstrap = {
  /** Bootstrap schema version, matching the consent version. */
  v: number
  /** True whenever any adapter is configured and a route is allowed. */
  enabled: boolean
  /** When true the browser bundle must stay inert in an automated session. */
  suppressAutomation: boolean
  /** Only the adapters that are configured AND valid. */
  adapters: MarketingBootstrapAdapter[]
  /** Allowlisted public page category, derived from the path (never user input). */
  pageType: string
}

/** A coarse, non-sensitive page category derived from a PUBLIC path only. */
export function pageTypeForPath(pathname: string): string {
  const path = pathname || '/'
  if (path === '/') return 'home'
  if (path === '/cart') return 'cart'
  if (path === '/checkout') return 'checkout'
  if (path.startsWith('/collections')) return 'collection'
  if (/^\/books\/[^/]+$/.test(path) || /^\/stickers\/[^/]+$/.test(path)) return 'product'
  if (path.startsWith('/books') || path.startsWith('/stickers')) return 'catalog'
  if (path.startsWith('/blog')) return 'blog'
  if (path.startsWith('/support')) return 'support'
  return 'page'
}

/**
 * Build the inline bootstrap the browser bundle reads, or null when there is
 * nothing to do (master switch off, no adapter configured, or a disallowed
 * route). Only PUBLIC vendor ids are included; no secret ever is.
 */
export function marketingBootstrap(env: MarketingEnv | undefined, pathname: string): MarketingBootstrap | null {
  const config = resolveMarketingConfig(env)
  if (!marketingActive(config)) return null
  if (!marketingPathAllowed(pathname)) return null
  const adapters: MarketingBootstrapAdapter[] = []
  for (const a of config.adapters) {
    if (!a.configured) continue
    const rule = ID_RULES[a.id]
    const idValue = String((env ?? {})[rule.envKey] ?? '').trim()
    if (!idValue) continue
    const entry: MarketingBootstrapAdapter = { id: a.id, idValue }
    if (a.id === 'googleAds') {
      const label = String(env?.GOOGLE_ADS_PURCHASE_LABEL ?? '').trim()
      if (label) entry.purchaseLabel = label
    }
    adapters.push(entry)
  }
  return {
    v: CONSENT_VERSION,
    enabled: true,
    suppressAutomation: !automationAllowed(env),
    adapters,
    pageType: pageTypeForPath(pathname)
  }
}
