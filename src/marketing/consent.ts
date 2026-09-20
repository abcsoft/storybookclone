// Consent model (versioned, first-party, minimal).
//
// The consent preference is stored as ONE first-party cookie whose value is a
// small JSON document recording ONLY: the consent schema version, the two
// optional categories, and the timestamp the decision was made. No identifier,
// no fingerprint, no vendor data is ever recorded here.
//
// The SAME parser is used server-side (so tests and any server diagnostic agree
// with the browser) and by public/static/analytics.js (which re-implements only
// the trivial read/write — this module is the reference for the shape).
//
// Defaults are DENIED for every non-essential category. "Necessary" is always
// on and is not stored (it is not a choice).

export const CONSENT_COOKIE = 'ww_consent'
/** Bump this whenever the CATEGORIES or their meaning change. */
export const CONSENT_VERSION = 1
/** How long a recorded decision is honoured before it is asked again. */
export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 180 // 180 days

export type ConsentCategory = 'necessary' | 'analytics' | 'marketing'

export type ConsentState = {
  /** Schema version. A stored value with a different version is ignored. */
  v: number
  /** GA4 (analytics_storage). */
  analytics: boolean
  /** Meta / TikTok / Google Ads (ad_storage, ad_user_data, ad_personalization). */
  marketing: boolean
  /** Epoch milliseconds the decision was saved. */
  ts: number
}

/** The fail-closed default: everything non-essential denied. */
export function defaultConsent(now = Date.now()): ConsentState {
  return { v: CONSENT_VERSION, analytics: false, marketing: false, ts: now }
}

export function acceptAllConsent(now = Date.now()): ConsentState {
  return { v: CONSENT_VERSION, analytics: true, marketing: true, ts: now }
}

/** Parse a stored cookie value. Anything malformed, versionless or stale → null (re-ask). */
export function parseConsent(raw: string | null | undefined, now = Date.now()): ConsentState | null {
  if (!raw) return null
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (Number(obj.v) !== CONSENT_VERSION) return null
  const ts = Number(obj.ts)
  if (!Number.isFinite(ts) || ts <= 0) return null
  if (now - ts > CONSENT_MAX_AGE_SECONDS * 1000) return null
  return {
    v: CONSENT_VERSION,
    analytics: obj.analytics === true,
    marketing: obj.marketing === true,
    ts
  }
}

export function serializeConsent(state: ConsentState): string {
  // A fixed key order keeps the cookie canonical and diffable.
  return JSON.stringify({ v: state.v, analytics: state.analytics, marketing: state.marketing, ts: state.ts })
}

/**
 * Normalise a partial decision (e.g. from the preference form) into a full,
 * versioned state. Any category the caller did not explicitly grant is denied.
 */
export function normalizeConsent(input: { analytics?: boolean; marketing?: boolean }, now = Date.now()): ConsentState {
  return { v: CONSENT_VERSION, analytics: input.analytics === true, marketing: input.marketing === true, ts: now }
}

/** Does this state permit the given non-essential category? */
export function consentAllows(state: ConsentState | null, category: 'analytics' | 'marketing'): boolean {
  if (!state) return false
  return category === 'analytics' ? state.analytics === true : state.marketing === true
}

/** The Google Consent Mode v2 signals for a state. All four default denied. */
export function consentModeSignals(state: ConsentState | null): Record<string, 'granted' | 'denied'> {
  const analytics = consentAllows(state, 'analytics') ? 'granted' : 'denied'
  const marketing = consentAllows(state, 'marketing') ? 'granted' : 'denied'
  return {
    analytics_storage: analytics,
    ad_storage: marketing,
    ad_user_data: marketing,
    ad_personalization: marketing
  }
}
