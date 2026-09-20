// Public surface of the marketing-analytics layer.
//
// Product code (and the admin diagnostics screen) import from here — never
// from an adapter — so the internal event contract remains the single entry
// point and no storefront module can reach a vendor global directly.
export {
  resolveMarketingConfig,
  adapterState,
  marketingActive,
  marketingBootstrap,
  marketingPathAllowed,
  pageTypeForPath,
  automationAllowed,
  maskId,
  flagOn,
  type AdapterId,
  type AdapterState,
  type MarketingConfig,
  type MarketingBootstrap,
  type MarketingBootstrapAdapter,
  type MarketingEnv
} from './config'

export {
  CONSENT_COOKIE,
  CONSENT_VERSION,
  CONSENT_MAX_AGE_SECONDS,
  defaultConsent,
  acceptAllConsent,
  normalizeConsent,
  parseConsent,
  serializeConsent,
  consentAllows,
  consentModeSignals,
  type ConsentState,
  type ConsentCategory
} from './consent'

export {
  EVENT_MAP,
  ALLOWED_PAYLOAD_KEYS,
  FORBIDDEN_PAYLOAD_KEYS,
  sanitizePayload,
  forbiddenKeysIn,
  toMajorUnits,
  newEventId,
  safeSearchTerm,
  eventCategory,
  type MarketingEventName,
  type MarketingPayload,
  type VendorEventNames
} from './events'

export { purchaseTrackingGate, shouldEmitPurchase, buildPurchasePayload, type PurchaseGate, type PurchaseGateEnv, type PurchaseOrderView } from './purchase'

export { buildContentSecurityPolicy, marketingCspSources, marketingCspRelevant, VENDOR_HOSTS, type VendorSources } from './csp'
