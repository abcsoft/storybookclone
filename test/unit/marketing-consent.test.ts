import { describe, expect, it } from 'vitest'
import {
  CONSENT_VERSION,
  defaultConsent,
  acceptAllConsent,
  normalizeConsent,
  parseConsent,
  serializeConsent,
  consentAllows,
  consentModeSignals
} from '../../src/marketing/index'

describe('consent — defaults are DENIED', () => {
  it('defaultConsent denies every non-essential category', () => {
    const s = defaultConsent()
    expect(s.v).toBe(CONSENT_VERSION)
    expect(s.analytics).toBe(false)
    expect(s.marketing).toBe(false)
    expect(consentAllows(s, 'analytics')).toBe(false)
    expect(consentAllows(s, 'marketing')).toBe(false)
  })

  it('normalizeConsent only grants what was explicitly set true', () => {
    expect(normalizeConsent({}).analytics).toBe(false)
    expect(normalizeConsent({ analytics: true }).marketing).toBe(false)
    expect(normalizeConsent({ marketing: true }).analytics).toBe(false)
  })
})

describe('consent — a null/absent state grants nothing', () => {
  it('consentAllows(null) is false and the signals are all denied', () => {
    expect(consentAllows(null, 'analytics')).toBe(false)
    expect(consentAllows(null, 'marketing')).toBe(false)
    expect(consentModeSignals(null)).toEqual({
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    })
  })
})

describe('consent — versioned, minimal, expiring persistence', () => {
  it('round-trips and records only version/categories/timestamp', () => {
    const s = acceptAllConsent(1000)
    const raw = serializeConsent(s)
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['analytics', 'marketing', 'ts', 'v'])
    expect(parseConsent(raw, 2000)).toEqual(s)
  })

  it('ignores a malformed value', () => {
    expect(parseConsent('not json')).toBeNull()
    expect(parseConsent('')).toBeNull()
    expect(parseConsent(null)).toBeNull()
  })

  it('ignores a different consent version (re-asks)', () => {
    expect(parseConsent(JSON.stringify({ v: CONSENT_VERSION + 1, analytics: true, marketing: true, ts: 1 }))).toBeNull()
  })

  it('ignores a stale decision past the expiry', () => {
    const s = acceptAllConsent(1000)
    const wayLater = 1000 + 1000 * 60 * 60 * 24 * 365
    expect(parseConsent(serializeConsent(s), wayLater)).toBeNull()
  })
})

describe('consent — Consent Mode v2 signals', () => {
  it('analytics-only grants analytics_storage but keeps every ad signal denied', () => {
    expect(consentModeSignals(normalizeConsent({ analytics: true }))).toEqual({
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    })
  })

  it('all granted sets all four', () => {
    expect(consentModeSignals(acceptAllConsent())).toEqual({
      analytics_storage: 'granted',
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted'
    })
  })
})
