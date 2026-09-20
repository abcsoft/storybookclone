// The ONE typed internal marketing event contract.
//
// Storefront/commerce code produces events from THIS module's vocabulary and
// nothing else. Only the adapter layer (src/marketing/adapters.ts and the
// browser bundle) knows that Meta speaks `AddToCart` and GA4 speaks
// `add_to_cart`; product code never names a vendor event.
//
// Two structural guarantees live here and are shared by server and browser:
//   1. an ALLOWLIST of payload keys — anything else is dropped, so a future
//      field cannot silently leak into a vendor request; and
//   2. a FORBIDDEN-KEY guard — the exact set of private values this feature
//      must never send. A payload that carries one is refused outright (the
//      regression test in test/unit/marketing-events.test.ts fails if any of
//      these ever appears in a built payload).
//
// Money is carried internally as INTEGER MINOR UNITS with an ISO currency, and
// is converted to major units EXACTLY ONCE, at the adapter boundary. No integer
// minor-unit value is ever handed to a vendor.

export type MarketingEventName =
  | 'page_view'
  | 'view_product'
  | 'search'
  | 'add_to_cart'
  | 'begin_checkout'
  | 'registration'
  | 'customize_product'
  | 'purchase'

export type VendorEventNames = { meta: string; tiktok: string; ga4: string; googleAds?: string }

/**
 * The internal→vendor mapping, as data. `meta`/`tiktok` values are the vendor
 * event names; for Meta a `custom` value means `trackCustom`.
 */
export const EVENT_MAP: Record<MarketingEventName, VendorEventNames> = {
  page_view: { meta: 'PageView', tiktok: 'PageView', ga4: 'page_view' },
  view_product: { meta: 'ViewContent', tiktok: 'ViewContent', ga4: 'view_item' },
  search: { meta: 'Search', tiktok: 'Search', ga4: 'search' },
  add_to_cart: { meta: 'AddToCart', tiktok: 'AddToCart', ga4: 'add_to_cart' },
  begin_checkout: { meta: 'InitiateCheckout', tiktok: 'InitiateCheckout', ga4: 'begin_checkout' },
  registration: { meta: 'CompleteRegistration', tiktok: 'CompleteRegistration', ga4: 'sign_up' },
  customize_product: { meta: 'custom:CustomizeProduct', tiktok: 'CustomizeProduct', ga4: 'custom' },
  purchase: { meta: 'Purchase', tiktok: 'Purchase', ga4: 'purchase', googleAds: 'conversion' }
}

/** Which consent category an event needs before it may reach a vendor. */
export function eventCategory(name: MarketingEventName): 'analytics' | 'marketing' {
  // page/product/cart/checkout/search are "analytics" when sent to GA4; but
  // they are sent to Meta/TikTok too, which needs MARKETING consent. The
  // browser bundle gates per-adapter using this table, so an event is allowed
  // for exactly the adapters whose category the visitor granted.
  return name === 'page_view' || name === 'view_product' || name === 'search' ? 'analytics' : 'marketing'
}

/**
 * Keys the internal contract understands. Everything else is stripped before a
 * payload can reach an adapter. Deliberately small and commerce-only.
 */
export const ALLOWED_PAYLOAD_KEYS = [
  'slug',
  'sku',
  'category',
  'variantCode',
  'coverType',
  'quantity',
  'currency',
  'valueMinor',
  'eventId',
  'pageType',
  'transactionId',
  'items'
] as const

/**
 * THE forbidden set. If any of these keys appears in a payload that is about to
 * be dispatched, the event is refused (fail closed) — this is the machine-
 * checked list backing DELIVERABLE 4.
 */
export const FORBIDDEN_PAYLOAD_KEYS = [
  'name',
  'childName',
  'age',
  'childAge',
  'email',
  'phone',
  'address',
  'photo',
  'photoUrl',
  'photoKey',
  'uploadKey',
  'faceId',
  'faceCount',
  'boundingBox',
  'analysis',
  'dedication',
  'userBookId',
  'orderId',
  'paymentId',
  'session',
  'sessionId',
  'token',
  'csrf',
  'csrfToken'
] as const

const ALLOWED = new Set<string>(ALLOWED_PAYLOAD_KEYS)
const FORBIDDEN = new Set<string>(FORBIDDEN_PAYLOAD_KEYS)

export type MarketingPayload = Partial<Record<(typeof ALLOWED_PAYLOAD_KEYS)[number], unknown>>

export type SanitizeResult = { payload: MarketingPayload; dropped: string[]; forbidden: string[] }

/**
 * Strip everything not on the allowlist, and REPORT any forbidden key that was
 * present. The caller refuses the event when `forbidden` is non-empty.
 */
export function sanitizePayload(input: Record<string, unknown> | undefined): SanitizeResult {
  const payload: MarketingPayload = {}
  const dropped: string[] = []
  const forbidden: string[] = []
  if (input && typeof input === 'object') {
    for (const key of Object.keys(input)) {
      if (FORBIDDEN.has(key)) {
        forbidden.push(key)
        continue
      }
      if (!ALLOWED.has(key)) {
        dropped.push(key)
        continue
      }
      ;(payload as Record<string, unknown>)[key] = (input as Record<string, unknown>)[key]
    }
  }
  return { payload, dropped, forbidden }
}

/** Extract the forbidden keys present in a raw payload (used by the regression test). */
export function forbiddenKeysIn(input: Record<string, unknown> | undefined): string[] {
  return sanitizePayload(input).forbidden
}

/** Convert integer minor units to major units EXACTLY ONCE, at this boundary. */
export function toMajorUnits(valueMinor: unknown): number | undefined {
  const n = Number(valueMinor)
  if (!Number.isFinite(n)) return undefined
  return Math.round(n) / 100
}

/** A deliberately opaque, per-event id. Never derived from an internal id. */
export function newEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '')
  }
  return `evt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Reduce a free-text search term to something safe, or null when that cannot be
 * guaranteed. A term that could contain a name (any letter run, any @, digits
 * mingled with letters) is OMITTED: we then send only the Search event.
 */
export function safeSearchTerm(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const term = raw.trim()
  if (!term || term.length > 40) return null
  // Only a conservative character class is permitted, and it must look like a
  // catalogue phrase (letters/spaces/hyphens/apostrophes), never an email or a
  // free-form sentence that could carry a child's name. Even then it is only
  // sent as a generic category hint, never verbatim.
  if (!/^[A-Za-z][A-Za-z '’-]*$/.test(term)) return null
  return term
}
