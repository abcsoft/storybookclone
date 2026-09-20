// The narrowest Content-Security-Policy the configured adapters require.
//
// Only EXACT official hostnames are ever added — never a wildcard, never a
// scheme-only source. A host appears here ONLY when the matching adapter is both
// configured AND the master switch is on, so a site with no marketing
// configured serves byte-for-byte the same CSP it always did.
//
// The browser bundle loads vendor libraries ONLY after consent (Google Consent
// Mode v2 basic behaviour), so these hosts are necessary but not sufficient:
// nothing connects to them before the visitor says yes.
import { adapterState, flagOn, resolveMarketingConfig, type MarketingEnv } from './config'

export type VendorSources = {
  scriptSrc: string[]
  imgSrc: string[]
  connectSrc: string[]
  frameSrc: string[]
}

// Exact hostnames per vendor. Kept as data so the CSP test can assert them.
type VendorHosts = {
  readonly scriptSrc: readonly string[]
  readonly imgSrc: readonly string[]
  readonly connectSrc: readonly string[]
  readonly frameSrc: readonly string[]
}

export const VENDOR_HOSTS = {
  meta: {
    scriptSrc: ['https://connect.facebook.net'],
    imgSrc: ['https://www.facebook.com'],
    connectSrc: ['https://www.facebook.com', 'https://connect.facebook.net'],
    frameSrc: ['https://www.facebook.com']
  },
  tiktok: {
    scriptSrc: ['https://analytics.tiktok.com'],
    imgSrc: ['https://analytics.tiktok.com'],
    connectSrc: ['https://analytics.tiktok.com'],
    frameSrc: []
  },
  google: {
    scriptSrc: ['https://www.googletagmanager.com'],
    imgSrc: ['https://www.google-analytics.com', 'https://www.googletagmanager.com'],
    connectSrc: [
      'https://www.google-analytics.com',
      'https://analytics.google.com',
      'https://www.googletagmanager.com',
      'https://region1.google-analytics.com'
    ],
    frameSrc: []
  },
  googleAds: {
    scriptSrc: ['https://www.googletagmanager.com', 'https://googleads.g.doubleclick.net'],
    imgSrc: ['https://googleads.g.doubleclick.net', 'https://www.googleadservices.com', 'https://www.google.com'],
    connectSrc: ['https://googleads.g.doubleclick.net', 'https://www.googleadservices.com', 'https://www.googletagmanager.com'],
    frameSrc: ['https://googleads.g.doubleclick.net', 'https://td.doubleclick.net']
  }
} as const satisfies Record<string, VendorHosts>

function union(lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const item of list) {
      if (!seen.has(item)) {
        seen.add(item)
        out.push(item)
      }
    }
  }
  return out
}

/** The extra host sources required by the configured adapters (empty when none). */
export function marketingCspSources(env: MarketingEnv | undefined): VendorSources {
  const config = resolveMarketingConfig(env)
  if (!config.enabled) return { scriptSrc: [], imgSrc: [], connectSrc: [], frameSrc: [] }
  const selected: VendorHosts[] = []
  if (adapterState(config, 'meta').configured) selected.push(VENDOR_HOSTS.meta)
  if (adapterState(config, 'tiktok').configured) selected.push(VENDOR_HOSTS.tiktok)
  if (adapterState(config, 'ga4').configured) selected.push(VENDOR_HOSTS.google)
  if (adapterState(config, 'googleAds').configured) selected.push(VENDOR_HOSTS.googleAds)
  return {
    scriptSrc: union(selected.map((s) => s.scriptSrc)),
    imgSrc: union(selected.map((s) => s.imgSrc)),
    connectSrc: union(selected.map((s) => s.connectSrc)),
    frameSrc: union(selected.map((s) => s.frameSrc))
  }
}

/** True when the master switch is on. */
export function marketingCspRelevant(env: MarketingEnv | undefined): boolean {
  return flagOn(env?.MARKETING_TRACKING_ENABLED)
}

/**
 * Build the full CSP string. The base directives are EXACTLY the baseline the
 * application shipped with; only the four vendor-aware directives can grow, and
 * only by exact hosts required by configured adapters.
 */
export function buildContentSecurityPolicy(env: MarketingEnv | undefined): string {
  const vendor = marketingCspSources(env)
  const selfPlus = (extra: readonly string[]) => ["'self'", ...extra].join(' ')
  const directives: string[] = [
    "default-src 'self'",
    // Inline scripts/styles are still used by the server-rendered pages; the
    // nonce/hash-based CSP that removes them is an explicit Phase 8 item. The
    // vendor script hosts are appended only when an adapter is configured.
    `script-src ${selfPlus(vendor.scriptSrc)} 'unsafe-inline'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `img-src ${["'self'", ...vendor.imgSrc, 'data:', 'blob:'].join(' ')}`,
    `connect-src ${selfPlus(vendor.connectSrc)}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ]
  if (vendor.frameSrc.length) directives.splice(6, 0, `frame-src ${selfPlus(vendor.frameSrc)}`)
  return directives.join('; ')
}
