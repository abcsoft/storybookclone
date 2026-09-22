import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { esc } from './layout'
import { html, htmlNotFound, loadPageContext, storeOf, type PageContextVars } from './page-context'
import { registerStorefrontRoutes } from './storefront'
import {
  contactPage,
  authPage,
  cartPage,
  checkoutPage,
  myBooksPage,
  myBookOrderDetailPage,
  resetPasswordPage
} from './pages'
import { loadPdp, ensurePdpPageRow, savePdpPage, upsertGallery, deleteGallery, upsertAccordion, deleteAccordion, upsertStep, upsertTip, deleteTip, saveMagic, upsertTrust, deleteTrust, upsertReaction, deleteReaction, upsertMedia, deleteMedia, setRelated, upsertFaq, deleteFaq } from './pdp'
import { adminPdpEditor } from './admin_pdp'
import { adminCatalogProducts } from './admin_catalog'
import { adminCmsHome, adminCmsNavigation, adminCmsPages, adminCmsPageEditor, adminCmsSettings } from './admin_cms'
import { adminReviews } from './admin_reviews'
import { registerAdminStoreRoutes } from './admin_routes'
import { registerCommerceRoutes, resolveCheckoutReturnOrderId } from './commerce/routes'
import { registerAccountApiRoutes } from './account/routes'
import { registerAccountWebRoutes } from './account/web'
import { getCustomerOrder, listCustomerOrders, paymentStatusLabel } from './account/orders'
import { orderFinancePanel } from './admin_finance'
import { financialSummary } from './commerce/reporting'
import { hasFinancePermission } from './admin_routes'
import { adminConsoleGuard, permits, issueReauthTicket } from './admin-console/guard'
import { adminMediaUrl } from './admin-console/media'
import { adminOpsDashboardSection } from './admin-console/views'
import { dashboardModel } from './admin-console/ops'
import { registerAdminConsoleRoutes } from './admin-console/routes'
import { FINANCE_PERMISSIONS } from './commerce/types'
import {
  queryProducts,
  getProductBySlug,
  getProductVariants,
  quoteCart,
  shippingFor,
  shippingForCurrency,
  round2,
  minorToMajor,
  type CatalogQuery,
  type DiscountRow
} from './db'
import { money } from './legacy-money'
import {
  attachUser,
  hashPassword,
  verifyPassword,
  rotateSessionOnLogin,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  readSessionToken,
  requireAuth,
  requireAdmin,
  adminActor,
  type AuthUser
} from './auth'
import {
  adminLogin,
  adminDashboard,
  adminOrders,
  adminOrderDetail,
  adminProducts,
  adminProductForm,
  adminDiscounts,
  adminUsers,
  adminMessages,
  adminAiSettings,
  type AiSettingsRow
} from './admin'
import { personalizedBookReaderPage } from './pages_reader'
import { previewStepPage, visiblePreviewPage } from './pages_preview'
import { isOrderableBookState } from './personalization/types'
import { getCookie, setCookie } from 'hono/cookie'
import { createOrder, verifyGuestOrderToken, type CreateOrderInput } from './orders'
import { resolveGuestOrderTokenSecrets, MissingSecretError, sha256Hex, timingSafeEqual } from './secrets'
import { validatePhotoBytes, contentTypeFor, recordUpload, checkUploadOwnership, getUploadOwner, MAX_PHOTO_BYTES } from './uploads'
import { PHOTO_POLICY, photoPolicySummary } from './photo-policy'
import { requestPasswordReset, resetPassword } from './password-reset'
import { consumeRateLimit } from './rate-limit'
import { registerPersonalizationRoutes } from './personalization/routes'
import { registerGenerationRoutes } from './generation/routes'
import { getGenerationProviders } from './generation/providers'
import { loadJob, latestVisibleJobForBook } from './generation/jobs'
import { jobView, previewAssetUrl } from './generation/routes'
import { renderGenerationPanel, type GenerationPanelState } from './pages_generation'
import { statusLabel, transitionOrderStatus, transitionPreviewStatus } from './orders-status'
import { brand, configureBrand } from './brand'
import { mailProviderStatus, type MailEnv } from './mail/provider'
import { sendVerificationEmail } from './account/profile'
import { recordSecurityEvent, ipDigest } from './account/security'
import { createProduct, updateProduct } from './product-variants'
import {
  csrfGuard,
  corsGuard,
  securityHeaders,
  clientIp as clientIpOf,
  secureCookieOptions,
  injectCsrfFormTokens,
  hasSessionCookie,
  CSRF_COOKIE,
  rateLimitKey,
  SESSION_TTL_SECONDS,
  UPLOAD_COOKIE_TTL_SECONDS,
  PROSPECT_COOKIE_TTL_SECONDS
} from './security'
import { consumeRateLimit as durableRateLimit } from './rate-limit'
import { recordAdminAudit } from './admin-audit'
import { resolveOwner as resolvePersonalizationOwner } from './personalization/ownership'
import { getActiveApproval } from './personalization/approvals'
import { ownerToken as personalizationOwnerToken } from './personalization/uploads'

export type Bindings = {
  DB: D1Database
  PHOTOS?: R2Bucket
  // Optional one-time local/dev admin bootstrap. Never set a real value in a
  // committed file — provide it via `.dev.vars` (gitignored) locally or a
  // platform secret in deployed environments. See README "Local admin bootstrap".
  ADMIN_BOOTSTRAP_EMAIL?: string
  ADMIN_BOOTSTRAP_PASSWORD?: string
  // 'development' unlocks local-only fallbacks (guest-order-token secret,
  // the console email adapter) that must never be reachable in production.
  // Leave unset in any deployed environment — absence means production
  // rules apply (fail closed), which is the safe default.
  ENVIRONMENT?: string
  // Required in production: signs/verifies guest order-access and PDF
  // request-status capability tokens. `wrangler secret put
  // GUEST_ORDER_TOKEN_SECRET`. _PREV supports rotation — see src/secrets.ts.
  GUEST_ORDER_TOKEN_SECRET?: string
  GUEST_ORDER_TOKEN_SECRET_PREV?: string
  // Optional overrides for the guest-order-token TTL/rotation window — see
  // resolveGuestOrderTokenSecrets() in src/secrets.ts for full semantics.
  GUEST_ORDER_TOKEN_TTL_SECONDS?: string
  GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE?: string
  // Phase 3 placeholder: NOT read by any real generation call yet (none
  // exists — see /api/generate-book). The admin AI-settings page reads
  // only whether this is SET, to show a truthful "configured: yes/no"
  // status; it never reads or displays the value, and no D1 column ever
  // stores it (migration 0008). `wrangler secret put AI_PROVIDER_API_KEY`.
  AI_PROVIDER_API_KEY?: string
  // Face-analysis adapter configuration — see
  // src/personalization/face-analysis.ts.
  //   * FACE_ANALYSIS_API_URL + FACE_ANALYSIS_API_KEY configure the REAL
  //     provider adapter (a deployed secret; never a committed value).
  //   * FACE_ANALYSIS_PROVIDER=deterministic-fake selects the offline fake
  //     ONLY when ENVIRONMENT=development — it is refused in production, so
  //     a stray value can never fabricate face detections.
  FACE_ANALYSIS_PROVIDER?: string
  FACE_ANALYSIS_API_URL?: string
  FACE_ANALYSIS_API_KEY?: string
  // ---- V2 Phase 3 generation configuration (src/generation/providers/*) ----
  // Which adapter a generation step uses is decided by the PINNED PROMPT
  // VERSION's `provider` column ('http' | 'deterministic-fake' | 'disabled');
  // these variables supply the real adapters' credentials. A capability is
  // configured only when BOTH its URL and key are present, and a non-HTTPS
  // endpoint is refused outside an explicit development environment.
  //   GENERATION_STORY_API_URL / _API_KEY          story text
  //   GENERATION_ILLUSTRATION_API_URL / _API_KEY   illustrations
  //   GENERATION_TRANSLATION_API_URL / _API_KEY    translations
  //   GENERATION_VALIDATION_API_URL / _API_KEY     output validation
  GENERATION_STORY_API_URL?: string
  GENERATION_STORY_API_KEY?: string
  GENERATION_ILLUSTRATION_API_URL?: string
  GENERATION_ILLUSTRATION_API_KEY?: string
  GENERATION_TRANSLATION_API_URL?: string
  GENERATION_TRANSLATION_API_KEY?: string
  GENERATION_VALIDATION_API_URL?: string
  GENERATION_VALIDATION_API_KEY?: string
  // The Cloudflare Queue producer binding. Absent -> no wake-up is delivered
  // (the durable job row plus the scheduled recovery sweep are the fallback);
  // see docs/V2_ARCHITECTURE_BASELINE.md for the deployment decision.
  GENERATION_QUEUE?: Queue<{ jobId: number; jobPublicId: string; correlationId: string }>
  // Development-only convenience: drain due jobs in the same request. Requires
  // ENVIRONMENT=development AND an explicit '1', so it can never silently
  // become the production architecture.
  GENERATION_INLINE_DISPATCH?: string
  // Deployment-wide kill switch: '1' makes every generation capability resolve
  // to its fail-closed adapter.
  GENERATION_DISABLED?: string
  // M-2: the ONLY way to arm the trusted-proxy boundary that makes the
  // `CF-Connecting-IP` header authoritative for rate-limit identity. Set it
  // to exactly `cloudflare` in a deployed Cloudflare environment; leave it
  // unset anywhere else (local dev, preview, direct deploys). Without it
  // every caller shares one coarse limiter bucket, so a forged header cannot
  // manufacture identities. See src/security.ts::clientIp.
  TRUSTED_PROXY?: string
  // L-D: the ONE brand/identity boundary (src/brand.ts). Every one of these is
  // optional; the neutral default (`Storybook Studio`) applies until the owner
  // configures the real brand. No template hard-codes any of them.
  BRAND_NAME?: string
  BRAND_TAGLINE?: string
  BRAND_DESCRIPTION?: string
  BRAND_LEGAL_NAME?: string
  BRAND_CONTACT_EMAIL?: string
  BRAND_INSTAGRAM?: string
  BRAND_FACEBOOK?: string
  BRAND_TIKTOK?: string
  BRAND_YOUTUBE?: string
  BRAND_X?: string
  BRAND_LOGO_PATH?: string
  BRAND_COPYRIGHT_YEAR?: string
  // ---- V2 Phase 4: payments (COM-07/COM-08) ----
  // Deployment-wide kill switch: '1' makes the payment capability resolve to its
  // fail-closed adapter, so checkout cannot take a payment.
  PAYMENTS_DISABLED?: string
  // Which adapter to use: 'stripe' (only when FULLY configured below) or
  // 'deterministic-fake' (development only). Unset = payment DISABLED, which is
  // the default this repository ships with.
  PAYMENT_PROVIDER?: string
  // Stripe credentials. Neither is ever returned, logged or rendered — only
  // their PRESENCE and the key's test/live prefix class affect behaviour and the
  // health report (src/commerce/payments/stripe.ts::stripeConfig).
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_API_BASE?: string
  STRIPE_WEBHOOK_TOLERANCE_SECONDS?: string
  // Development-only signing secret for the offline deterministic test provider.
  PAYMENT_FAKE_WEBHOOK_SECRET?: string
  // ---- V2 Phase 5: customer account, email, downloads (CUS-01..CUS-14, PLT-05)
  // Which outbound email adapter this deployment resolves to. UNSET means email
  // delivery is DISABLED and truthful — queued messages are recorded as
  // `suppressed` rather than pretended to have been sent. See
  // src/mail/provider.ts and docs/EMAIL_PROVIDER.md. A real provider is only
  // constructed when ALL of EMAIL_PROVIDER=http, EMAIL_API_URL, EMAIL_API_KEY and
  // EMAIL_FROM are present; no credential exists in this repository and no real
  // send is ever made from it.
  EMAIL_PROVIDER?: string
  EMAIL_API_URL?: string
  EMAIL_API_KEY?: string
  EMAIL_FROM?: string
  EMAIL_FROM_NAME?: string
  EMAIL_TIMEOUT_MS?: string
  // Optional pepper for the IP DIGEST stored on sessions and security events.
  // Without it the digest of an IPv4 address is brute-forceable, so it is treated
  // as a low-sensitivity "same network" hint and never as an identity.
  IP_HASH_SECRET?: string
  // Optional overrides for the CUS-08 revision-request policy limits.
  REVISION_MAX_PER_REVISION?: string
  REVISION_MAX_PER_BOOK?: string
}
export type Vars = {
  user: AuthUser | null
  requestId: string | null
  csrfToken?: string
  /** V2 Phase 6 (ADM-02): the caller's resolved admin permission set, set by the central guard. */
  adminPermissions?: string[]
  adminRoles?: string[]
} & Partial<PageContextVars>

/**
 * The caller's resolved admin permissions. Read-only: they are computed ONCE per
 * request by the central admin guard (src/admin-console/guard.ts) and never
 * recomputed in a view, so a screen cannot disagree with the gate that let it run.
 */
function adminPerms(c: { get: (key: string) => unknown }): readonly string[] {
  return (c.get('adminPermissions') as string[] | undefined) ?? []
}

const app = new Hono<{ Bindings: Bindings; Variables: Vars }>()

// L-D: resolve the deployment's brand/identity config once per request so
// every template (storefront, admin, emails) renders the SAME configured
// name/logo/tagline/contact/legal identity. This is deployment-wide
// configuration, not per-request data — see src/brand.ts.
app.use('*', async (c, next) => {
  configureBrand(c.env)
  await next()
})

// S-04: no default CORS. The storefront is same-origin, so NO CORS headers
// are emitted unless an origin is explicitly allowlisted via ALLOWED_ORIGINS;
// an unknown Origin is never reflected.
app.use('/api/*', corsGuard())

// S-05: central security headers on every response (CSP, nosniff, frame
// protection, referrer, permissions, and a safe cache policy for private /
// token-bearing pages). Registered first so it wraps everything.
app.use('*', securityHeaders())

// ---------- schema authority + local-dev bootstrap ----------
// `migrations/` is the ONE authoritative schema source. This module does not
// (and must not) create tables at runtime: the previous inline `ensureSchema()`
// fallback only ever covered the original 0001 tables and had silently drifted
// from 0002+ for a long time (see V2 finding S-16). It has been retired in
// favour of an explicit, actionable "your database predates these migrations"
// failure.
//
// One-time-per-isolate guard. The worker isolate normally lives for the
// process lifetime, so the guard only needs resetting in tests.
let bootstrapped = false
// Test-only.
export function __resetBootedForTests() {
  bootstrapped = false
}

// Tables that only exist if the FULL migration set (0001-0014) has been
// applied. Chosen to span every era: 0001 (users), 0004/0006 (upload_claims),
// 0009 (rate_limit_windows), 0010-0012 (personalization), 0014
// (retention_failures). A database missing any of these has not been migrated.
const REQUIRED_TABLES = [
  'users',
  'photo_uploads',
  'upload_claims',
  'rate_limit_windows',
  'languages',
  'user_books',
  'personalization_inputs',
  'detected_faces',
  'preview_versions',
  'approvals',
  'user_book_events',
  'retention_failures'
] as const

export class SchemaOutOfDateError extends Error {
  constructor(public missingTables: string[]) {
    super(
      `Database schema is out of date: missing table(s) ${missingTables.join(', ')}. ` +
        'This application never creates tables at runtime — `migrations/` is the only schema authority. ' +
        'Run `npm run db:reset` (local) or `npx wrangler d1 migrations apply webapp-production --local` ' +
        '(add --remote for a deployed database) before starting the app.'
    )
    this.name = 'SchemaOutOfDateError'
  }
}

/** Fails with an actionable error if the database has not been migrated to the current schema. */
export async function assertMigrationsApplied(db: D1Database): Promise<void> {
  const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()
  const present = new Set((rows.results || []).map((r) => r.name))
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t))
  if (missing.length) throw new SchemaOutOfDateError([...missing])
}

/**
 * Local-dev conveniences that are NOT schema creation and remain safe/idempotent
 * after migrations have run: the explicitly-configured first admin (never a
 * hard-coded default credential), the default discount code, and a catalog
 * fallback seed only when `products` is genuinely empty. Runs at most once per
 * isolate.
 */
export async function bootstrapLocalDefaults(db: D1Database, bootstrap?: { email?: string; password?: string }): Promise<void> {
  // Bootstrap the first admin only when explicitly configured (no hard-coded
  // default credential). Set ADMIN_BOOTSTRAP_EMAIL / ADMIN_BOOTSTRAP_PASSWORD
  // via `.dev.vars` locally, or `npm run admin:bootstrap` for a one-off local
  // insert — see README "Local admin bootstrap". Never defaults in production.
  const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first()
  if (!admin && bootstrap?.email && bootstrap?.password) {
    await db
      .prepare("INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .bind('Admin', bootstrap.email, await hashPassword(bootstrap.password))
      .run()
    // V2 Phase 6 (ADM-02): record the account's AUTHORITY explicitly. The legacy
    // `role = 'admin'` flag is only the sign-in gate now, so the bootstrap writes
    // the super_admin grant too — otherwise the panel would depend on the
    // legacy-flag fallback instead of on the grants table the Staff screen reads.
    await db
      .prepare("INSERT OR IGNORE INTO admin_user_roles (user_id, role_key) SELECT id, 'super_admin' FROM users WHERE email = ?")
      .bind(bootstrap.email)
      .run()
  }
  await db
    .prepare(
      // `percent_bps` is the AUTHORITATIVE rate (2000 = 20%); `percent` is kept
      // as a display mirror, so no pricing path ever reads a REAL value (COM-05).
      "INSERT OR IGNORE INTO discounts (code, percent, percent_bps, min_books, applies_to, scope, auto_apply, active, stackable, priority) VALUES ('EXTRA20', 20, 2000, 2, 'books', 'books', 1, 1, 0, 100)"
    )
    .run()
  // Fallback catalog seed if products table is empty (mirrors seed.sql)
  const count = await db.prepare('SELECT COUNT(*) AS n FROM products').first<{ n: number }>()
  if (!count || count.n === 0) {
    const { products } = await import('./data')
    const batch = products.map((p) =>
      db
        .prepare(
          // L-B: the integer minor-unit price is authoritative and the schema
          // (0018) rejects a money row without it, so it is written with the
          // row rather than backfilled by a follow-up UPDATE afterwards.
          `INSERT OR IGNORE INTO products (slug, title, tagline, description, story, price, price_minor, compare_at, compare_at_price_minor, currency, image, gender, category, ages, age_min, age_max, pages, reviews, rating, bestseller, new_release, career, traits_json, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .bind(
          p.slug, p.title, p.tagline, p.description, p.story, p.price, Math.round(p.price * 100),
          p.compareAt ?? null, p.compareAt != null ? Math.round(p.compareAt * 100) : null,
          p.image, p.gender, p.category, p.ages, p.ageMin, p.ageMax, p.pages, p.reviews, p.rating,
          p.bestseller ? 1 : 0, p.newRelease ? 1 : 0, p.career ? 1 : 0, JSON.stringify(p.traits)
        )
    )
    if (batch.length) await db.batch(batch)
  }
  // ---- V2 Phase 2 derivation (idempotent, run on every boot) -------------
  // The SAME derivations migrations 0020/0023 apply to an EXISTING database,
  // repeated here because a freshly-migrated database has no catalogue yet:
  // products arrive from the seed above (or from seed.sql), and these
  // statements derive the rows the storefront reads. Nothing new is invented —
  // every price and fact comes from the product's own row.
  //
  // Per-currency prices: the product's own minor-unit price is authoritative in
  // its own currency; the additional currencies are the documented static
  // fixture prices (GBP 0.79, EUR 0.92, CAD 1.36, AUD 1.52 of the USD amount).
  await db
    .prepare(
      `INSERT OR IGNORE INTO product_prices (product_id, currency, price_minor, compare_at_price_minor)
       SELECT id, COALESCE(NULLIF(currency, ''), 'USD'), price_minor, compare_at_price_minor FROM products WHERE price_minor IS NOT NULL`
    )
    .run()
  for (const [code, factor] of [['GBP', 0.79], ['EUR', 0.92], ['CAD', 1.36], ['AUD', 1.52]] as const) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO product_prices (product_id, currency, price_minor, compare_at_price_minor)
         SELECT product_id, ?, CAST(ROUND(price_minor * ?) AS INTEGER),
                CASE WHEN compare_at_price_minor IS NULL THEN NULL ELSE CAST(ROUND(compare_at_price_minor * ?) AS INTEGER) END
           FROM product_prices WHERE currency = 'USD'`
      )
      .bind(code, factor, factor)
      .run()
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO variant_prices (variant_id, currency, price_minor, compare_at_price_minor)
       SELECT v.id, p.currency, v.price_minor, v.compare_at_price_minor
         FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.active = 1`
    )
    .run()
  for (const [code, factor] of [['GBP', 0.79], ['EUR', 0.92], ['CAD', 1.36], ['AUD', 1.52]] as const) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO variant_prices (variant_id, currency, price_minor, compare_at_price_minor)
         SELECT variant_id, ?, CAST(ROUND(price_minor * ?) AS INTEGER), NULL FROM variant_prices WHERE currency = 'USD'`
      )
      .bind(code, factor)
      .run()
  }
  // Collection membership derived from each product's own catalog facets.
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'all-books' AND p.category = 'book'`).run()
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'all-stickers' AND p.category = 'sticker'`).run()
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'sticker-packs' AND p.category = 'sticker'`).run()
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'when-i-grow-up' AND p.career = 1`).run()
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'girls-books' AND p.category = 'book' AND (p.gender = 'girl' OR p.gender = 'unisex')`).run()
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'boys-books' AND p.category = 'book' AND (p.gender = 'boy' OR p.gender = 'unisex')`).run()
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'ages-2-4' AND p.category = 'book' AND p.age_min >= 2 AND p.age_max <= 6`).run()
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'ages-4-6' AND p.category = 'book' AND p.age_min <= 4 AND p.age_max >= 6`).run()
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'ages-6-8' AND p.category = 'book' AND p.age_max >= 8`).run()
  // Theme membership is an editorial choice, so it is listed explicitly
  // (and mirrored in migration 0020 for the upgrade path).
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, 100 + p.id FROM collections c JOIN products p
       WHERE c.slug = 'adventure-and-discovery' AND p.slug IN ('captain-of-the-cardboard-sea', 'the-great-paper-boat-race', 'the-sunrise-kite-club', 'the-little-explorer', 'the-paper-aeroplane-race', 'the-puddle-who-met-the-sea')`).run()
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, 100 + p.id FROM collections c JOIN products p
       WHERE c.slug = 'bedtime-and-calm' AND p.slug IN ('the-lantern-and-the-long-night', 'the-moon-garden', 'the-snowy-night-parade', 'the-moonlight-parade', 'the-snow-fox')`).run()
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, 100 + p.id FROM collections c JOIN products p
       WHERE c.slug = 'animals-and-nature' AND p.slug IN ('the-snow-fox', 'the-lost-little-dinosaur', 'the-forest-that-sang', 'the-puddle-who-met-the-sea')`).run()
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, 100 + p.id FROM collections c JOIN products p
       WHERE c.slug = 'sky-and-space' AND p.slug IN ('the-star-collector', 'the-paper-aeroplane-race', 'up-in-the-clouds', 'the-sunrise-kite-club')`).run()
  await db.prepare(`INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
      SELECT c.id, p.id, 100 + p.id FROM collections c JOIN products p
       WHERE c.slug = 'kindness-and-feelings' AND p.slug IN ('the-quiet-drum', 'the-brave-little-baker', 'the-kind-vet', 'the-helping-hands-clinic', 'the-forest-that-sang')`).run()
  // Factual product spec + one cover media row per product.
  await db
    .prepare(
      `INSERT OR IGNORE INTO product_facts (product_id, page_count, trim_size, binding, format_label, production_note)
       SELECT id, pages, '210 × 210 mm',
              CASE WHEN category = 'book' THEN 'Hardcover / softcover' ELSE 'Sticker sheet set' END,
              CASE WHEN category = 'book' THEN 'Square picture book' ELSE 'Sticker pack' END,
              'This version records the order and keeps your personalisation. It does not print or ship anything yet, so no production or delivery date is scheduled.'
         FROM products`
    )
    .run()
  await db
    .prepare(
      `INSERT OR IGNORE INTO media_assets (public_path, alt_text, width, height, mime_type, source)
       SELECT DISTINCT image, 'Illustrated cover', 600, 600, 'image/svg+xml', 'generated' FROM products WHERE image <> ''`
    )
    .run()
  await db
    .prepare(
      `INSERT OR IGNORE INTO product_media (product_id, media_id, role, sort_order)
       SELECT p.id, m.id, 'cover', 0 FROM products p JOIN media_assets m ON m.public_path = p.image WHERE p.image <> ''`
    )
    .run()

  // Keep the minor-unit price truth + the storefront's cover/format variants
  // in sync for every catalog row, idempotently (D-08/D-09). Variants are
  // priced from the product's own price — no new price is invented.
  await db.prepare('UPDATE products SET price_minor = CAST(ROUND(price * 100) AS INTEGER) WHERE price_minor IS NULL').run()
  await db.prepare('UPDATE products SET compare_at_price_minor = CAST(ROUND(compare_at * 100) AS INTEGER) WHERE compare_at IS NOT NULL AND compare_at_price_minor IS NULL').run()
  await db
    .prepare(
      `INSERT OR IGNORE INTO product_variants (product_id, code, label, price_minor, compare_at_price_minor, currency, is_default, sort_order)
       SELECT id, 'standard', 'Standard', CAST(ROUND(price * 100) AS INTEGER), NULL, 'USD', 1, 0 FROM products WHERE category <> 'book'`
    )
    .run()
  await db
    .prepare(
      `INSERT OR IGNORE INTO product_variants (product_id, code, label, price_minor, compare_at_price_minor, currency, is_default, sort_order)
       SELECT id, 'hardcover', 'Hardcover', CAST(ROUND(price * 100) AS INTEGER), NULL, 'USD', 1, 0 FROM products WHERE category = 'book'`
    )
    .run()
  await db
    .prepare(
      `INSERT OR IGNORE INTO product_variants (product_id, code, label, price_minor, compare_at_price_minor, currency, is_default, sort_order)
       SELECT id, 'softcover', 'Softcover', CAST(ROUND(price * 100) AS INTEGER), NULL, 'USD', 0, 1 FROM products WHERE category = 'book'`
    )
    .run()

  // V2 Cream-Purple asset mappings (mirrors migration 0034; idempotent).
  // Ensures fresh installations where products are inserted from fixture
  // receive approved assets, while preserving any custom operator edits.
  await db.prepare("UPDATE products SET image = '/static/assets/books/lantern.webp' WHERE slug = 'the-lantern-and-the-long-night' AND image = '/static/img/art/cover-the-lantern-and-the-long-night.svg'").run()
  await db.prepare("UPDATE products SET image = '/static/assets/books/moon-garden.webp' WHERE slug = 'the-moon-garden' AND image = '/static/img/art/cover-the-moon-garden.svg'").run()
  await db.prepare("UPDATE products SET image = '/static/assets/books/snowy-friend.webp' WHERE slug = 'the-snow-fox' AND image = '/static/img/art/cover-the-snow-fox.svg'").run()
  await db.prepare("UPDATE products SET image = '/static/assets/books/quiet-dream.webp' WHERE slug = 'the-quiet-drum' AND image = '/static/img/art/cover-the-quiet-drum.svg'").run()
  await db.prepare("UPDATE products SET image = '/static/assets/books/forest.webp' WHERE slug = 'the-forest-that-sang' AND image = '/static/img/art/cover-the-forest-that-sang.svg'").run()
  await db.prepare("UPDATE products SET image = '/static/assets/books/sunbeam-sea.webp' WHERE slug = 'the-puddle-who-met-the-sea' AND image = '/static/img/art/cover-the-puddle-who-met-the-sea.svg'").run()
  await db.prepare("UPDATE products SET image = '/static/assets/books/vet.webp' WHERE slug = 'the-kind-vet' AND image = '/static/img/art/cover-the-kind-vet.svg'").run()
  await db.prepare("UPDATE products SET image = '/static/assets/books/firefighter.webp' WHERE slug = 'the-little-fire-crew' AND image = '/static/img/art/cover-the-little-fire-crew.svg'").run()
  await db.prepare("UPDATE products SET image = '/static/assets/books/pilot.webp' WHERE slug = 'up-in-the-clouds' AND image = '/static/img/art/cover-up-in-the-clouds.svg'").run()
  await db.prepare("UPDATE products SET image = '/static/assets/books/chef.webp' WHERE slug = 'the-brave-little-baker' AND image = '/static/img/art/cover-the-brave-little-baker.svg'").run()

  await db.prepare("UPDATE collections SET hero_image = '/static/assets/categories/adventure.webp' WHERE slug = 'adventure-and-discovery' AND hero_image = '/static/img/art/cover-the-little-explorer.svg'").run()
  await db.prepare("UPDATE collections SET hero_image = '/static/assets/categories/bedtime.webp' WHERE slug = 'bedtime-and-calm' AND hero_image = '/static/img/art/cover-the-lantern-and-the-long-night.svg'").run()
  await db.prepare("UPDATE collections SET hero_image = '/static/assets/categories/animals.webp' WHERE slug = 'animals-and-nature' AND hero_image = '/static/img/art/cover-the-snow-fox.svg'").run()
  await db.prepare("UPDATE collections SET hero_image = '/static/assets/categories/friendship.webp' WHERE slug = 'kindness-and-feelings' AND hero_image = '/static/img/art/cover-the-forest-that-sang.svg'").run()
  await db.prepare("UPDATE collections SET hero_image = '/static/assets/extras/sticker-pack.webp' WHERE slug IN ('all-stickers', 'sticker-packs') AND hero_image IN ('/static/img/art/stickers-header.svg', '/static/img/art/cover-meadow-sticker-sheet.svg')").run()

  await db.prepare("UPDATE cms_blocks SET image_path = '/static/assets/hero/open-book-boy.webp', image_alt = 'Illustrated child and dog reading a magical glowing storybook' WHERE key = 'home.hero' AND image_path = '/static/img/art/hero.svg'").run()
  await db.prepare("UPDATE cms_blocks SET image_path = '/static/assets/extras/sticker-pack.webp', image_alt = 'Personalised illustrated sticker sheet' WHERE key = 'home.stickers' AND image_path = '/static/img/art/stickers-header.svg'").run()
  await db.prepare("UPDATE cms_blocks SET image_path = '/static/assets/features/open-book-girl.webp', image_alt = 'Child reading personalised storybook with magical glow' WHERE key = 'home.cta' AND image_path = '/static/img/art/cta-reading.svg'").run()

  // PDP Gallery for The Lantern and the Long Night:
  // 1. Safe upgrade for known legacy generated SVG gallery (if all rows are legacy).
  await db.prepare(`
    DELETE FROM pdp_gallery
     WHERE product_id = (SELECT id FROM products WHERE slug = 'the-lantern-and-the-long-night')
       AND image_url IN ('/static/img/art/cover-the-lantern-and-the-long-night.svg', '/static/img/art/hero.svg')
       AND NOT EXISTS (
         SELECT 1 FROM pdp_gallery pg
          WHERE pg.product_id = (SELECT id FROM products WHERE slug = 'the-lantern-and-the-long-night')
            AND pg.image_url NOT IN ('/static/img/art/cover-the-lantern-and-the-long-night.svg', '/static/img/art/hero.svg')
       )
  `).run()

  // 2. Install approved Lantern gallery ONLY if gallery is currently empty (untouched seed or after legacy upgrade).
  // Never append to custom/mixed galleries, and never resurrect admin-deleted items.
  await db.prepare(`
    INSERT INTO pdp_gallery (product_id, image_url, alt, sort_order, active)
    SELECT p.id, v.image_url, v.alt, v.sort_order, 1
      FROM products p
      JOIN (
        SELECT '/static/assets/product/lantern-cover.webp' AS image_url, 'Cover of The Lantern and the Long Night' AS alt, 1 AS sort_order
        UNION ALL SELECT '/static/assets/product/open-book-feature.webp', 'Open book spread with glowing lantern', 2
        UNION ALL SELECT '/static/assets/product/gallery-01.webp', 'Inside page detail showing lantern light', 3
        UNION ALL SELECT '/static/assets/product/gallery-02.webp', 'Inside page detail showing the snowy path', 4
        UNION ALL SELECT '/static/assets/product/gallery-03.webp', 'Inside page detail showing sunrise over the hills', 5
      ) v
     WHERE p.slug = 'the-lantern-and-the-long-night'
       AND NOT EXISTS (SELECT 1 FROM pdp_gallery pg WHERE pg.product_id = p.id)
  `).run()

  // Ensure Lantern cover and gallery rows in product_media if not already present or admin-customized.
  await db.prepare(`
    INSERT OR IGNORE INTO product_media (product_id, media_id, role, sort_order)
    SELECT p.id, (SELECT id FROM media_assets WHERE public_path = '/static/assets/books/lantern.webp'), 'cover', 0
      FROM products p WHERE p.slug = 'the-lantern-and-the-long-night'
  `).run()

  await db.prepare(`
    INSERT OR IGNORE INTO product_media (product_id, media_id, role, sort_order)
    SELECT p.id, m.id, 'gallery', v.sort_order
      FROM products p
      JOIN (
        SELECT '/static/assets/product/open-book-feature.webp' AS public_path, 1 AS sort_order
        UNION ALL SELECT '/static/assets/product/gallery-01.webp', 2
        UNION ALL SELECT '/static/assets/product/gallery-02.webp', 3
        UNION ALL SELECT '/static/assets/product/gallery-03.webp', 4
      ) v
      JOIN media_assets m ON m.public_path = v.public_path
     WHERE p.slug = 'the-lantern-and-the-long-night'
       AND NOT EXISTS (SELECT 1 FROM product_media pm WHERE pm.product_id = p.id AND pm.role = 'gallery')
  `).run()
}

/**
 * Request-path entry point: verifies migrations have been applied (once per
 * isolate) and then runs the idempotent local-dev bootstrap. Throws
 * SchemaOutOfDateError — surfaced by the middleware below as a clear 500 — if
 * the database predates the current migrations.
 */
export async function ensureSchemaReady(db: D1Database, bootstrap?: { email?: string; password?: string }): Promise<void> {
  if (!db || bootstrapped) return
  await assertMigrationsApplied(db)
  await bootstrapLocalDefaults(db, bootstrap)
  bootstrapped = true
}

// Fail fast and clearly if required Cloudflare bindings are missing, instead
// of letting every route crash later with a confusing "cannot read property
// of undefined". Placeholder wrangler.jsonc config only satisfies local dev;
// a real deployment must configure a real D1 database binding.
app.use('*', async (c, next) => {
  if (!c.env.DB) {
    return c.text(
      'Server misconfigured: the "DB" D1 database binding is missing. ' +
        'Configure a real D1 binding in wrangler.jsonc / your Cloudflare Pages project settings before deploying.',
      500
    )
  }
  await next()
})

// attach user on every request (after confirming migrations are applied)
app.use('*', async (c, next) => {
  try {
    await ensureSchemaReady(c.env.DB, {
      email: c.env.ADMIN_BOOTSTRAP_EMAIL,
      password: c.env.ADMIN_BOOTSTRAP_PASSWORD
    })
  } catch (err) {
    if (err instanceof SchemaOutOfDateError) {
      // Fail loudly and actionably rather than 500ing later with "no such
      // table". This is a deployment/operations error, not a user error.
      console.error(`[schema] ${err.message}`)
      return c.text(`Server misconfigured: ${err.message}`, 500)
    }
    throw err
  }
  await next()
})
app.use('*', attachUser)

// V2 Phase 2: load the CMS shell (navigation, footer, announcement) and the
// store context (country/currency/language, from the database) once per
// request, and apply the brand overlay from `site_settings`. It degrades to
// the built-in defaults rather than 500ing if a CMS read fails.
app.use('*', async (c, next) => {
  await loadPageContext(c)
  await next()
})

// S-01: the central CSRF/Origin gate for every cookie-authenticated mutation.
app.use('*', csrfGuard())

// Server-rendered pages get a hidden CSRF field injected into every POST
// form, so the HTML and JSON mutation paths share one protection model.
app.use('*', async (c, next) => {
  await next()
  const type = c.res.headers.get('Content-Type') || ''
  const token = c.get('csrfToken') || getCookie(c, CSRF_COOKIE)
  if (type.includes('text/html') && token) {
    const body = await c.res.text()
    c.res = new Response(injectCsrfFormTokens(body, token), c.res)
  }
})

// A per-request correlation id, available to every handler/audit event. It is
// request-scoped (Hono Variables) — never module/global state.
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID()
  c.set('requestId', requestId)
  c.header('X-Request-Id', requestId)
  await next()
})

// V2 Phase 6 (ADM-02/ADM-20): the ONE central admin authorization gate. It is
// registered BEFORE every admin route so it covers the whole surface, and it
// refuses by default any /admin or /api/**/admin request whose route has no
// policy entry — a new admin route is unreachable until it declares the
// permission it needs (src/admin-console/policy.ts).
app.use('/admin/*', adminConsoleGuard)
app.use('/admin', adminConsoleGuard)
app.use('/api/v1/admin/*', adminConsoleGuard)
app.use('/api/admin/*', adminConsoleGuard)

// Phase 2 personalization domain (user-books, uploads lifecycle, face
// analysis, personalization revisions) — see src/personalization/*.
registerPersonalizationRoutes(app)

// V2 Phase 3 generation domain (queue-driven generation, watermarked previews,
// revisions and approvals) plus the private preview-asset route — see
// src/generation/*.
registerGenerationRoutes(app)

// V2 Phase 5 customer account domain (CUS-01..CUS-14, GEN-09/11, PER-08/09,
// PLT-05): profile/verification/email change, session listing and revocation,
// the address book pages, verified guest claiming, the book library with its
// preview/version history, revision requests, exact-version approval, entitled
// expiring downloads, support tickets, notification preferences, privacy intake
// and the durable email outbox. Both surfaces (server-rendered forms and the
// /api/v1 JSON API) call the SAME services — see src/account/*.
registerAccountApiRoutes(app)
registerAccountWebRoutes(app)

// Every browser (guest or logged-in) gets a stable, opaque, httpOnly upload
// ownership token. It has nothing to do with login — it's what lets order
// creation reject a photo upload key that belongs to a DIFFERENT browser
// ("foreign" key), without requiring an account just to personalize.
const UPLOAD_OWNER_COOKIE = 'ww_upload'
function getOrSetUploadOwnerToken(c: Context<{ Bindings: Bindings; Variables: Vars }>): string {
  let token = getCookie(c, UPLOAD_OWNER_COOKIE)
  if (!token) {
    token = crypto.randomUUID()
    // S-02: same environment-aware policy as every other cookie.
    setCookie(c, UPLOAD_OWNER_COOKIE, token, secureCookieOptions(c.env as { ENVIRONMENT?: string }, UPLOAD_COOKIE_TTL_SECONDS))
  }
  return token
}

// ================= STOREFRONT =================
//
// V2 Phase 2: the public storefront routes (homepage from CMS blocks, the
// catalog, collections, PDP, blog, FAQ, legal/content pages, robots/sitemap,
// locale selection and the review endpoints) are registered from
// src/storefront.ts, which reads everything from the database. What remains
// here are the routes that mutate session/order state.

app.get('/contact', (c) => {
  return html(c, 'Contact', contactPage(c.req.query('sent') === '1', c.req.query('error') || undefined), '/contact')
})

app.post('/contact', async (c) => {
  const body = await c.req.parseBody()
  // S-06 + T-08: durable atomic limit, and an HONEST failure (never a fake
  // success when persistence fails).
  const contactLimit = await durableRateLimit(c.env.DB, rateLimitKey('contact', c), { max: 5, windowSeconds: 3600 })
  if (contactLimit.limited) {
    return html(c, 'Contact us', contactPage(false, 'You have sent several messages already. Please try again a little later.'), '/contact', undefined, 429)
  }
  let saved = false
  try {
    await c.env.DB.prepare('INSERT INTO contacts (name, email, topic, message) VALUES (?, ?, ?, ?)')
      .bind(String(body.name || ''), String(body.email || ''), String(body.topic || ''), String(body.message || ''))
      .run()
    saved = true
  } catch {}
  // T-08: only claim success when the row actually persisted; otherwise say so
  // and let the visitor retry.
  if (!saved) {
    return html(c, 'Contact us', contactPage(false, 'We could not save your message just now — please try again in a moment.'), '/contact')
  }
  return html(c, 'Contact us', contactPage(true), '/contact')
})

// ---------- auth pages ----------
app.get('/login', (c) => {
  if (c.get('user')) return c.redirect('/my-books')
  return html(c, 'Login', authPage('login'), 'my-books')
})
app.get('/register', (c) => {
  if (c.get('user')) return c.redirect('/my-books')
  return html(c, 'Create Account', authPage('register'), 'my-books')
})
app.get('/forgot-password', (c) => html(c, 'Forgot Password', authPage('forgot'), 'my-books'))

const AUTH_RATE_LIMIT = { max: 10, windowSeconds: 15 * 60 }

app.post('/login', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').toLowerCase().trim()
  const password = String(body.password || '')
  // S-06: durable atomic limit, keyed by action + client identity + IP.
  const limit = await durableRateLimit(c.env.DB, rateLimitKey('login', c, email), AUTH_RATE_LIMIT)
  if (limit.limited) {
    return html(c, 'Login', authPage('login', 'Too many attempts. Please wait a few minutes and try again.'), 'my-books')
  }
  const user = await c.env.DB.prepare('SELECT id, name, email, role, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<AuthUser & { password_hash: string }>()
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return html(c, 'Login', authPage('login', 'Invalid email or password.'), 'my-books')
  }
  // S-02: authentication always rotates the session id. V2 Phase 5: the new
  // session records a DEVICE description and an IP DIGEST (never an address), so
  // the customer can recognise and revoke it from their account page.
  await rotateSessionOnLogin(c, c.env.DB, user.id, { userAgent: c.req.header('user-agent'), ipDigest: await callerIpDigestFor(c) })
  return c.redirect(user.role === 'admin' ? '/admin' : '/my-books')
})

app.post('/register', async (c) => {
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim()
  const email = String(body.email || '').toLowerCase().trim()
  const password = String(body.password || '')
  if (!name || !email || password.length < 6) {
    return html(c, 'Create Account', authPage('register', 'Please fill all fields (password 6+ characters).'), 'my-books')
  }
  const registerLimit = await durableRateLimit(c.env.DB, rateLimitKey('register', c), AUTH_RATE_LIMIT)
  if (registerLimit.limited) {
    return html(c, 'Create Account', authPage('register', 'Too many sign-up attempts right now. Please try again shortly.'), 'my-books')
  }
  try {
    const r = await c.env.DB.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .bind(name, email, await hashPassword(password))
      .run()
    const userId = Number(r.meta.last_row_id)
    // S-02: rotate (destroy any pre-registration session) on authentication.
    await rotateSessionOnLogin(c, c.env.DB, userId, { userAgent: c.req.header('user-agent'), ipDigest: await callerIpDigestFor(c) })
    // V2 Phase 5 (CUS-01/PLT-05): a new account is UNVERIFIED, and the
    // confirmation link is QUEUED for delivery. Best-effort by design — the
    // account exists either way, and the profile page says truthfully whether the
    // link could actually be delivered (this deployment has no provider, so it
    // cannot be). Nothing here verifies the address; only opening the link does.
    await recordSecurityEvent(c.env.DB, { userId, eventType: 'registered', ipDigest: await callerIpDigestFor(c), userAgent: c.req.header('user-agent') }).catch(() => undefined)
    await sendVerificationEmail(c.env.DB, mailEnvOf(c), { userId, email, name, baseUrl: new URL(c.req.url).origin, correlationId: c.get('requestId') || undefined }).catch((err) => {
      console.error(`[register] the verification email could not be queued: ${err instanceof Error ? err.message : 'unknown'}`)
    })
    return c.redirect('/my-books')
  } catch {
    return html(c, 'Create Account', authPage('register', 'That email is already registered.'), 'my-books')
  }
})

app.post('/logout', async (c) => {
  const token = readSessionToken(c)
  if (token) await destroySession(c.env.DB, token)
  clearSessionCookie(c)
  return c.redirect('/')
})
// S-03: a GET must never mutate session state (a link, prefetch or
// <img src> must not be able to log someone out). It is a plain redirect.
app.get('/logout', (c) => c.redirect('/'))

// Generic response regardless of whether the email exists — prevents account
// enumeration via this form. requestPasswordReset() itself is rate-limited
// and does the real work (token issuance + email) only when appropriate.
const FORGOT_PASSWORD_GENERIC_MESSAGE = 'If that email has an account, we’ve sent password reset instructions to it.'
app.post('/forgot-password', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '')
  const baseUrl = new URL(c.req.url).origin + '/reset-password'
  await requestPasswordReset(c.env.DB, email, baseUrl, c.env.ENVIRONMENT)
  return html(c, 'Forgot Password', authPage('forgot', FORGOT_PASSWORD_GENERIC_MESSAGE), 'my-books')
})

app.get('/reset-password', (c) => {
  const token = c.req.query('token') || ''
  return html(c, 'Reset Password', resetPasswordPage(token), 'my-books')
})
app.post('/reset-password', async (c) => {
  const body = await c.req.parseBody()
  const token = String(body.token || '')
  const password = String(body.password || '')
  const confirm = String(body.confirmPassword || '')
  if (password !== confirm) {
    return html(c, 'Reset Password', resetPasswordPage(token, 'Passwords do not match.'), 'my-books')
  }
  const result = await resetPassword(c.env.DB, token, password)
  if (!result.ok) {
    const message = result.error === 'weak_password' ? 'Password must be at least 8 characters.' : 'This reset link is invalid or has expired. Please request a new one.'
    return html(c, 'Reset Password', resetPasswordPage(token, message), 'my-books')
  }
  return html(
    c,
    'Password reset',
    `<section class="auth"><div class="auth-form"><h1>Password updated</h1><p>Your password has been reset. Please log in with your new password.</p><a class="btn btn-purple" href="/login">Go to login</a></div></section>`,
    'my-books'
  )
})

  app.get('/cart', (c) => html(c, 'Cart', cartPage()))
  app.get('/checkout', (c) => html(c, 'Checkout', checkoutPage(c.get('user'))))
  app.get('/my-books', (c) => html(c, 'My Books', myBooksPage(!!c.get('user')), 'my-books'))
  app.get('/my-books/:id', (c) => {
    const user = c.get('user')
    if (!user) return c.redirect('/login')
    return html(c, `Order #${c.req.param('id')}`, myBookOrderDetailPage(c.req.param('id')), 'my-books')
  })
  app.get('/my/books', (c) => c.redirect('/my-books'))
  app.get('/profile', (c) => c.redirect('/my-books'))

  // Reader & Customization Page (/my/books/:slug). When a `userBookId` is
  // present and owned by the caller, EVERY personalization field is derived
  // from that book's current immutable revision (the authoritative source —
  // D-07); the legacy query-param path remains only for the read-only guest
  // order viewer. There is NO placeholder child name (C-05).
  app.get('/my/books/:slug', async (c) => {
    // A guest order's capability token can arrive here via the URL
    // fragment (see public/static/reader.js) — fragments are never sent
    // to the server, so this header is defense in depth for any other
    // sensitive query param (e.g. photoKey) this page's URL does carry.
    const slug = c.req.param('slug')
    const q = c.req.query()

    const p = await getProductBySlug(c.env.DB, slug)

    // Authoritative path: an owned user-book revision wins over every query param.
    let book: any = null
    let revision: any = null
    if (q.userBookId) {
      const owner = await resolvePersonalizationOwner(c)
      if (owner) {
        const owned = await c.env.DB.prepare(
          'SELECT * FROM user_books WHERE public_id = ? AND ' + (owner.type === 'user' ? 'user_id = ?' : 'prospect_id = ?')
        )
          .bind(q.userBookId, owner.type === 'user' ? owner.userId : owner.prospectId)
          .first<any>()
        if (owned) {
          book = owned
          if (owned.current_revision > 0) {
            revision = await c.env.DB.prepare('SELECT * FROM personalization_inputs WHERE user_book_id = ? AND revision = ?')
              .bind(owned.id, owned.current_revision)
              .first<any>()
          }
        }
      }
    }

    const childName = String(revision?.child_name ?? q.name ?? q.childName ?? '')
    const childAge = String(revision?.child_age ?? q.age ?? q.childAge ?? '')
    const language = String(revision?.language_code ?? q.lang ?? 'en')
    const dedication = String(revision?.dedication ?? q.dedication ?? '')
    const title = p ? p.title : 'Your personalised storybook'
    const readOnly = q.readOnly === '1' || q.readonly === '1'
    const photoKey = String(revision?.photo_upload_key ?? (q.photoKey && q.photoKey.startsWith('uploads/') ? q.photoKey : '')) || undefined

    // Cover/format options and their prices come from the SAME server-owned
    // variants the quote and order snapshot use (D-08) — never a second,
    // hard-coded "reader price" (previously ai_settings 49.20/34.20, which
    // disagreed with the actual catalog price).
    const variantInfo = p ? await getProductVariants(c.env.DB, p.slug) : null
    const variants = variantInfo?.variants || []
    const coverOptions = variants.length ? variants.map((v) => v.code) : ['standard']
    const coverLabels = Object.fromEntries(variants.map((v) => [v.code, v.label]))
    const coverPrices = Object.fromEntries(variants.map((v) => [v.code, v.price]))
    const defaultVariant = variants.find((v) => v.isDefault) || variants[0]
    const requestedCover = String(q.cover || '')
    const coverType = coverOptions.includes(requestedCover) ? requestedCover : defaultVariant?.code || coverOptions[0]
    // A forged/unavailable cover in the URL is ignored (the page falls back
    // to the product's real default) — the server never trusts it as a price,
    // and the quote/order reject an unknown variant outright.
    const bookPrice = defaultVariant?.price ?? Number(p?.price ?? 0)
    const languages = (await c.env.DB.prepare('SELECT code, name FROM languages WHERE active = 1 ORDER BY name').all<{ code: string; name: string }>()).results || []

    // GEN-09: the generation panel is SERVER-RENDERED from the real job and
    // preview rows, so a refresh always shows the truth and the page never
    // depends on a client-side cache. public/static/generation.js then polls
    // the same API to keep an in-flight job live.
    const generationPanelHtml = book
      ? renderGenerationPanel(await loadGenerationPanelState(c.env as never, book))
      : ''

    const readerHtml = personalizedBookReaderPage({
      slug,
      title,
      childName,
      childAge,
      language,
      dedication,
      coverType,
      coverOptions,
      coverLabels,
      coverPrices,
      languages,
      ageMin: p?.ageMin ?? 1,
      ageMax: p?.ageMax ?? 18,
      hardcoverPrice: bookPrice,
      softcoverPrice: bookPrice,
      coverImage: '/static/img/placeholder-cover.svg',
      spreadImage: '/static/img/placeholder-spread.svg',
      cartImage: p?.image,
      photoUrl: photoKey ? `/photos/${photoKey}` : undefined,
      photoKey,
      userBookId: book?.public_id ?? undefined,
      userBookVersion: book?.version,
      readOnly,
      orderItemId: q.orderItemId ? Number(q.orderItemId) : undefined,
      generationPanelHtml
    })

    return html(c, `${title} - Customizer`, readerHtml, 'my-books')
  })

  // The PREVIEW step (`/my/books/:slug/preview`) — the step after the Book
  // step (owner request 4). Ownership is resolved exactly as the reader route
  // does: the `userBookId` query param only counts when it names a book the
  // CALLER owns, and every personalization field comes from that book's current
  // revision. A stranger's id (or no id at all) gets the editor page instead of
  // an error page that would confirm the id exists.
  app.get('/my/books/:slug/preview', async (c) => {
    const slug = c.req.param('slug')
    const q = c.req.query()
    const p = await getProductBySlug(c.env.DB, slug)

    let book: any = null
    let revision: any = null
    if (q.userBookId) {
      const owner = await resolvePersonalizationOwner(c)
      if (owner) {
        const owned = await c.env.DB.prepare(
          'SELECT * FROM user_books WHERE public_id = ? AND ' + (owner.type === 'user' ? 'user_id = ?' : 'prospect_id = ?')
        )
          .bind(q.userBookId, owner.type === 'user' ? owner.userId : owner.prospectId)
          .first<any>()
        if (owned) {
          book = owned
          if (owned.current_revision > 0) {
            revision = await c.env.DB.prepare('SELECT * FROM personalization_inputs WHERE user_book_id = ? AND revision = ?')
              .bind(owned.id, owned.current_revision)
              .first<any>()
          }
        }
      }
    }
    if (!book) return c.redirect(`/my/books/${encodeURIComponent(slug)}${q.userBookId ? `?userBookId=${encodeURIComponent(q.userBookId)}` : ''}`)

    const generation = await loadGenerationPanelState(c.env as never, book)
    const title = p ? p.title : 'Your personalised storybook'

    // Cover/format + price come from the SAME server-owned variants the quote
    // and order snapshot use — the page never invents a price.
    const variantInfo = p ? await getProductVariants(c.env.DB, p.slug) : null
    const variants = variantInfo?.variants || []
    const defaultVariant = variants.find((v) => v.isDefault) || variants[0]
    const requestedCover = String(q.cover || '')
    const coverType = variants.some((v) => v.code === requestedCover) ? requestedCover : defaultVariant?.code || 'standard'
    const coverLabel = variants.find((v) => v.code === coverType)?.label || coverType

    const previewHtml = previewStepPage({
      slug,
      title,
      childName: String(revision?.child_name ?? ''),
      childAge: String(revision?.child_age ?? ''),
      userBookId: book.public_id,
      generationPanelHtml: renderGenerationPanel(generation, { hidePageGrid: true }),
      generation,
      checkoutHref: '/cart',
      // Continue is only offered once there is a real published page to look at
      // AND the book's revision is final enough for the cart/order to accept.
      canContinue: !!visiblePreviewPage(generation) && isOrderableBookState(book.state),
      cart: {
        coverType,
        coverLabel,
        price: defaultVariant?.price ?? Number(p?.price ?? 0),
        cartImage: p?.image
      }
    })

    return html(c, `${title} - Preview`, previewHtml, 'my-books')
  })

/**
 * Everything the customer's generation panel needs, read fresh from the
 * database: the latest visible job for THIS book, and the ready preview for the
 * book's CURRENT revision only (an older revision's preview is history, not
 * something to present as "your preview").
 */
async function loadGenerationPanelState(
  env: { DB: D1Database; PHOTOS?: R2Bucket; ENVIRONMENT?: string },
  book: { id: number; public_id: string; state: string; current_revision: number }
): Promise<GenerationPanelState> {
  const job = await latestVisibleJobForBook(env.DB, book.id)
  const preview = await env.DB
    .prepare("SELECT * FROM preview_versions WHERE user_book_id = ? AND input_revision = ? AND status = 'ready' ORDER BY id DESC LIMIT 1")
    .bind(book.id, book.current_revision)
    .first<{ id: number; input_revision: number; scene_count: number; watermark_label: string | null; manifest_checksum: string | null; finalized_at: string | null }>()

  let previewView: GenerationPanelState['preview'] = null
  if (preview) {
    const assets = await env.DB.prepare('SELECT * FROM preview_assets WHERE preview_version_id = ? ORDER BY id').bind(preview.id).all<{
      asset_type: string
      object_key: string
      checksum: string
      scene_id: number | null
      is_watermarked: number
      width: number | null
      height: number | null
    }>()
    const order = await env.DB
      .prepare('SELECT id, sort_order FROM book_scenes WHERE id IN (SELECT scene_id FROM preview_assets WHERE preview_version_id = ?)')
      .bind(preview.id)
      .all<{ id: number; sort_order: number }>()
    const sortOrder = new Map((order.results || []).map((r) => [r.id, r.sort_order]))
    const pages = (assets.results || [])
      .filter((a) => a.asset_type === 'page_preview' && a.is_watermarked === 1)
      .sort((a, b) => (sortOrder.get(a.scene_id ?? 0) ?? 0) - (sortOrder.get(b.scene_id ?? 0) ?? 0))
      .map((a) => ({
        sceneId: a.scene_id,
        checksum: a.checksum,
        width: a.width,
        height: a.height,
        watermarked: a.is_watermarked === 1,
        // An opaque, entitlement-checked app route — never an R2 URL.
        url: previewAssetUrl(a.object_key)
      }))
    const approvalRow = await getActiveApproval(env.DB, book.id)
    const approval = approvalRow?.preview_version_id === preview.id
    previewView = {
      version: preview.input_revision,
      id: preview.id,
      status: 'ready',
      sceneCount: preview.scene_count,
      watermarkLabel: preview.watermark_label,
      manifestChecksum: preview.manifest_checksum,
      finalizedAt: preview.finalized_at,
      pages,
      isCurrentRevision: true,
      approved: approval,
      canApprove: !approval
    }
  }

  return {
    userBookId: book.public_id,
    bookState: book.state,
    currentRevision: book.current_revision,
    job: await jobView(env.DB, job),
    preview: previewView,
    providers: getGenerationProviders(env as never, env.PHOTOS).health()
  }
}

// Guest order confirmation. The order id in the URL is not itself an
// authorization check — the token query param (an HMAC over the order id,
// see src/orders.ts) is. Without a valid token this deliberately shows the
// same generic page a stranger guessing sequential IDs would see.
app.get('/order-success', async (c) => {
  // This page's own URL carries the guest capability token as a query param
  // (?token=) — a pre-existing, already-reviewed design. It is protected by the
  // application-wide `strict-origin-when-cross-origin` policy (src/security.ts),
  // which sends only the ORIGIN cross-origin and therefore never the token. This
  // route deliberately does NOT set its own `no-referrer`: a page-level
  // no-referrer makes the browser send `Origin: null` on this page's own form
  // submissions, which the CSRF guard refuses (found by the Phase-5 journey).
  let id = Number(c.req.query('id') || '')
  const token = c.req.query('token') || ''
  const user = c.get('user')

  // COM-13: the PAYMENT RETURN recovery path. A checkout session redirects the
  // customer back with `?cs=<session public id>`; the session is resolved
  // against the caller's OWN cart capability/session (never the id alone, which
  // would let anyone enumerate orders), and its order is then rendered through
  // exactly the same authorization as an id/token view.
  // `authorizedByReturn` records that the order id came from resolving the
  // caller's OWN checkout session (by their cart/prospect/session capability, never
  // by the id alone). That resolution IS an authorization, so the guest who just
  // paid can see their own order — previously this path resolved the id but then
  // failed the ownership check, and a GUEST returning from payment was told their
  // own order "could not be shown" (found by the Phase-5 browser journey).
  let authorizedByReturn = false
  if (!id && c.req.query('cs')) {
    const sessionOrderId = await resolveCheckoutReturnOrderId(c)
    if (sessionOrderId) {
      id = sessionOrderId
      authorizedByReturn = true
    }
  }

  let order: any = null
  let items: any[] = []
  // V2 Phase 5 (CUS-04): a signed-in visitor who proves the order with its OWN
  // capability token can add it to their account — the token is the capability,
  // and knowing the order id is never enough.
  let canClaim = false
  if (id) {
    const isOwner = user ? await c.env.DB.prepare('SELECT id FROM orders WHERE id = ? AND user_id = ?').bind(id, user.id).first() : null
    let guestOk = false
    if (!isOwner && token) {
      try {
        const cfg = resolveGuestOrderTokenSecrets(c.env)
        guestOk = await verifyGuestOrderToken(cfg.secrets, id, token, { previousDeadline: cfg.previousDeadline })
      } catch (err) {
        if (!(err instanceof MissingSecretError)) throw err
        // Fail closed: no signing secret configured means no guest token
        // can be verified — treat as "not authorized", not a crash.
      }
    }
    if (isOwner || guestOk || authorizedByReturn) {
      order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first()
      if (order) items = (await c.env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(id).all()).results || []
      // Claiming is offered only when the caller holds the capability AND is
      // signed in AND does not already own it: a guest with no account is told
      // how to claim instead (see the copy below).
      canClaim = !!user && !isOwner && guestOk
    }
  }

  if (!order) {
    return html(
      c,
      'Order confirmed',
      `<section class="page-hero">
        <h1>Thank you!</h1>
        <p>${id ? `Order #${id} could not be shown here — check your confirmation link, or ` : 'Please check My Books, or '}<a href="/my-books">view My Books</a> if you have an account.</p>
      </section>`
    )
  }

  // Per-item link into the reader/PDF-request page. The href's query
  // string here carries only non-sensitive identifiers (orderItemId, slug,
  // display fields for the reader's own preview) — never the guest
  // capability token. For a guest view (no session ownership), a tiny
  // inline script appends the token as a URL FRAGMENT (`#gt=...`) — never
  // a query param — to each link right before the page is interactive,
  // reusing the SAME token this page's own URL already carries (?token=
  // above); the reader page reads it from the fragment once, then scrubs
  // it (see public/static/reader.js). A fragment is never sent to the
  // server and never appears in a Referer header, unlike a query param.
  const readerLinks = items
    .map((it: any) => {
      const params = new URLSearchParams({
        orderItemId: String(it.id),
        name: it.child_name || '',
        age: String(it.child_age || ''),
        lang: it.language || 'English'
      })
      if (it.photo_key) params.set('photoKey', it.photo_key)
      // D-08: the reader opens on the cover that was actually ordered, so the
      // page agrees with the order snapshot (the server remains the price
      // authority — an unknown code is simply ignored by the reader route).
      if (it.variant_code) params.set('cover', it.variant_code)
      const href = `/my/books/${encodeURIComponent(it.slug)}?${params.toString()}`
      return `<li class="order-success-item"><span>${esc(it.title || it.slug)}${it.child_name ? ` — ${esc(it.child_name)}` : ''}</span> <a class="link reader-link" href="${href}" data-order-item-id="${it.id}">Open reader →</a></li>`
    })
    .join('')

  // COM-12/ADM-03: the payment line is rendered from the ORDER's ledger-derived
  // columns, so it can only ever say what actually happened. A browser redirect
  // cannot make this say "paid" — only a verified provider event can.
  const paymentStatus = String(order.payment_status || 'unpaid')
  const capturedMinor = Number(order.amount_captured_minor ?? 0)
  const refundedMinor = Number(order.amount_refunded_minor ?? 0)
  const paymentLine =
    capturedMinor > 0
      ? refundedMinor > 0
        ? `<p>Payment received: ${money(capturedMinor / 100)}${refundedMinor > 0 ? ` — ${money(refundedMinor / 100)} refunded, so ${money((capturedMinor - refundedMinor) / 100)} remains paid.` : '.'}</p>`
        : `<p>Payment received: ${money(capturedMinor / 100)}. Thank you.</p>`
      : paymentStatus === 'failed'
        ? `<p>No payment was taken — the payment attempt was declined. Your cart is unchanged, so you can try again.</p>`
        : `<p>Nothing has been charged for this order yet.</p>`

  // T-01/T-03 (preserved, now data-driven): this deployment states exactly what
  // it can and cannot do. Phase 5 added a durable outbox, so the honest answer is
  // no longer a flat "no email" — it is whatever the resolved provider actually is.
  const mailStatus = mailProviderStatus(c.env)
  const emailLine =
    mailStatus.deliveryMode === 'live' || mailStatus.deliveryMode === 'test-double'
      ? 'A confirmation for this order has been recorded and queued for delivery.'
      : mailStatus.deliveryMode === 'development-console'
        ? 'This is a development environment: the order confirmation was written to the local server log and no real email was sent.'
        : 'This deployment cannot send email, so do not wait for a confirmation message — this page and My Books are the record of your order.'
  const claimBlock = canClaim
    ? `<form method="post" action="/account/claim-order">
        <input type="hidden" name="orderId" value="${order.id}">
        <input type="hidden" name="guestToken" value="${esc(token)}">
        <button class="btn btn-primary" type="submit">Add this order to my account</button>
      </form>
      <p class="tiny">You are signed in, and this page's own confirmation link proves the order is yours, so it can be moved to your account now.</p>`
    : !user
      ? `<p class="tiny">Bookmark this page to check back. If you create an account, you can add this order to it from <a class="link" href="/account/claims">Guest orders</a> — either with this page's confirmation link (the part of the address after <code>token=</code>), or by confirming the email address the order used. Knowing an email address alone never moves an order.</p>`
      : ''
  return html(
    c,
    'Order confirmed',
    `<section class="page-hero">
      <h1>Thank you!</h1>
      ${c.req.query('ok') ? `<p class="notice ok" role="status">${esc(String(c.req.query('ok')))}</p>` : ''}
      ${c.req.query('error') ? `<p class="notice error" role="alert">${esc(String(c.req.query('error')))}</p>` : ''}
      <p>Your order #${order.id} has been saved.</p>
      <div id="order-payment-status" data-order-id="${order.id}" data-payment-status="${esc(paymentStatus)}">${paymentLine}</div>
      <p class="tiny muted">Order status: ${String(order.status).replace(/_/g, ' ')} · Payment: ${esc(statusLabel(paymentStatus))} · ${items.length} item${items.length === 1 ? '' : 's'} · Total ${money(Number(order.total_minor ?? order.total * 100) / 100)}</p>
      <p class="tiny">${emailLine} A print-ready PDF is not produced yet, so there is nothing to download until the print pipeline arrives. Previews are generated only when you ask for one from the reader page.</p>
      ${readerLinks ? `<ul class="order-success-items">${readerLinks}</ul>` : ''}
      ${claimBlock}
      <a class="btn" href="${user ? '/my-books' : '/'}">${user ? 'View my books' : 'Continue shopping'}</a>
    </section>
    ${c.req.query('cs') ? `<script type="module" src="/static/payment-return.js"></script>` : ''}
    ${
      !user
        ? `<script>
      // Guest view only: append this page's OWN guest token (already in
      // this page's URL, ?token=...) as a URL FRAGMENT on each reader
      // link — never re-rendered server-side, never put in a query
      // param, never logged. Runs once; nothing here persists the token.
      (function () {
        var params = new URLSearchParams(window.location.search)
        var token = params.get('token')
        if (!token) return
        document.querySelectorAll('a.reader-link').forEach(function (a) {
          a.href = a.getAttribute('href') + '#gt=' + encodeURIComponent(token)
        })
      })()
    </script>`
        : ''
    }`
  )
})

// The blog, FAQ and legal/content routes now live in src/storefront.ts and are
// backed by the `cms_pages` / `cms_faqs` tables (V2 Phase 2), so publishing a
// post or editing a policy is an admin action rather than a code change.

// ---------- photos (R2) ----------
// NEVER a permanently public URL: only the uploading browser (owner_token) or a
// customer who owns an order_item referencing this exact key may view it.
// Everyone else gets 404 (not 403, so a photo's existence can't be probed
// either).
//
// V2 Phase 6 (V2 §10): the STAFF bypass was removed from this route. It used to
// wave any `users.role = 'admin'` account through on the object key alone, with a
// one-hour cache — a permanent, permission-unchecked URL for a child's
// photograph that outlived a role revocation. Staff now view a photo through
// `/admin/media/photo/<token>` (src/admin-console/media.ts), which the central
// guard checks against `books.read` and which expires in two minutes.
app.get('/photos/:key{.+}', async (c) => {
  if (!c.env.PHOTOS) return c.notFound()
  const key = c.req.param('key')
  const user = c.get('user')
  const ownerToken = getCookie(c, UPLOAD_OWNER_COOKIE)

  let authorized = false
  if (!authorized && ownerToken) {
    const uploadOwner = await getUploadOwner(c.env.DB, key)
    authorized = uploadOwner !== null && uploadOwner === ownerToken
  }
  if (!authorized && user) {
    const owns = await c.env.DB
      .prepare('SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.photo_key = ? AND o.user_id = ?')
      .bind(key, user.id)
      .first()
    authorized = !!owns
  }
  // Phase 2: a photo uploaded via the two-phase user-book lifecycle is
  // owned under user:<id>/prospect:<id> (src/personalization/uploads.ts),
  // never the legacy ww_upload cookie above — so a guest viewing their own
  // reader/order-success page (same browser session, valid prospect
  // capability) needs this scheme recognized too, or their own photo 404s.
  if (!authorized) {
    const personalizationOwner = await resolvePersonalizationOwner(c)
    if (personalizationOwner) {
      const uploadOwner = await getUploadOwner(c.env.DB, key)
      authorized = uploadOwner !== null && uploadOwner === personalizationOwnerToken(personalizationOwner)
    }
  }
  if (!authorized) return c.notFound()

  const obj = await c.env.PHOTOS.get(key)
  if (!obj) return c.notFound()
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('Cache-Control', 'private, max-age=3600')
  return new Response(obj.body, { headers })
})

// ================= STOREFRONT ROUTES (V2 Phase 2) =================
// Homepage/CMS blocks, catalog, collections, PDP, blog/FAQ/legal content,
// robots/sitemap, locale selection and the review endpoints.
registerStorefrontRoutes(app)

// ================= COMMERCE ROUTES (V2 Phase 4) =================
// Server cart, expiring quotes, checkout sessions, provider webhooks and the
// address book (COM-01..COM-14). Registered BEFORE the legacy display-only
// quote/order handlers below so the canonical /api/v1/cart/quote path is the
// server-cart one; a request that supplies its own `items` still gets the legacy
// display pricing, which is what keeps the existing UX identical.
registerCommerceRoutes(app)

// ================= PUBLIC API =================

app.get('/api/me', (c) => {
  const u = c.get('user')
  return c.json({ user: u ? { id: u.id, name: u.name, email: u.email, role: u.role } : null })
})

app.post('/api/newsletter', async (c) => {
  const { email } = await c.req.json<{ email: string }>()
  if (!email) return c.json({ error: 'Email required' }, 400)
  // S-06: durable atomic limit by action + IP (+ the address itself).
  const limit = await durableRateLimit(c.env.DB, rateLimitKey('newsletter', c, String(email)), { max: 5, windowSeconds: 3600 })
  if (limit.limited) return c.json({ error: 'Too many sign-up attempts right now. Please try again later.' }, 429)
  // T-08: never report success when persistence failed.
  try {
    await c.env.DB.prepare('INSERT OR IGNORE INTO newsletter (email) VALUES (?)').bind(String(email).toLowerCase().trim()).run()
  } catch {
    return c.json({ error: 'We could not save your sign-up just now — please try again in a moment.' }, 503)
  }
  return c.json({ ok: true })
})

// Photo upload → R2, validated by real file bytes (not just declared
// Content-Type), tracked in photo_uploads so order creation can enforce
// ownership/expiry/single-use. Canonical: POST /api/v1/uploads/photo.
// Legacy alias kept, tested: POST /api/upload-photo.
async function handleUploadPhoto(c: Context<{ Bindings: Bindings; Variables: Vars }>) {
  const body = await c.req.parseBody()
  const file = body.photo
  if (!(file instanceof File) || file.size === 0) return c.json({ error: 'No photo received' }, 400)
  if (file.size > MAX_PHOTO_BYTES) return c.json({ error: `Photo must be under ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))}MB` }, 400)
  if (!c.env.PHOTOS) return c.json({ error: 'Photo storage unavailable' }, 503)

  const bytes = new Uint8Array(await file.arrayBuffer())
  const validation = await validatePhotoBytes(bytes)
  if (!validation.ok) {
    const messages: Record<string, string> = {
      too_small: 'That file is too small to be a real photo.',
      too_large: `Photo must be under ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))}MB.`,
      unrecognized_format: `Please upload a ${PHOTO_POLICY.allowedFormats.join(' or ').toUpperCase()} image.`,
      corrupt_or_unrecognized_image: 'That file is not a valid, complete image — it may be corrupted or truncated.',
      dimension_mismatch: 'That file is not a valid, complete image — it may be corrupted or truncated.',
      unsupported_variant: 'That image uses a format variant we don\'t support (e.g. interlaced or indexed-color PNG). Please export as a standard JPG or PNG.',
      dimensions_too_small: `Photo resolution is too low — please use an image at least ${PHOTO_POLICY.minDimensionPx}×${PHOTO_POLICY.minDimensionPx}px.`,
      dimensions_too_large: `Photo resolution is too high — please use an image no larger than ${PHOTO_POLICY.maxDimensionPx}×${PHOTO_POLICY.maxDimensionPx}px.`
    }
    return c.json({ error: messages[validation.error] || 'Invalid photo.' }, 400)
  }

  const ownerToken = getOrSetUploadOwnerToken(c)
  const ext = validation.image.format === 'jpeg' ? 'jpg' : validation.image.format
  const key = `uploads/${crypto.randomUUID()}.${ext}`
  const contentType = contentTypeFor(validation.image)
  await c.env.PHOTOS.put(key, bytes, { httpMetadata: { contentType } })
  await recordUpload(c.env.DB, {
    key,
    ownerToken,
    contentType,
    byteSize: bytes.byteLength,
    width: validation.image.width,
    height: validation.image.height
  })
  return c.json({ ok: true, key, url: `/photos/${key}` })
}
app.post('/api/v1/uploads/photo', handleUploadPhoto)
app.post('/api/upload-photo', handleUploadPhoto)

// Public — the one place the frontend reads size/dimension/format limits
// from, so UI copy can never drift from what the server actually enforces.
app.get('/api/v1/uploads/photo-policy', (c) => c.json(photoPolicySummary()))

// Live quote for the cart page / checkout (server-side pricing — client
// price/discount/total are never trusted). Canonical: POST /api/v1/cart/quote.
// Legacy aliases kept, tested: POST /api/quote, POST /api/cart/quote (the
// path the storefront JS called before this baseline existed, but the
// server never implemented).
async function handleQuote(c: Context<{ Bindings: Bindings; Variables: Vars }>) {
  const body = await c.req.json<{ items?: any[]; code?: string; shipping?: string }>()
  const items = Array.isArray(body.items) ? body.items : []
  // SF-03/PLT-07: the currency is the SERVER's resolved store choice (the
  // persisted country/currency selection), never a value from the request body.
  const currency = storeOf(c).currency
  if (!items.length) {
    return c.json({ subtotal: 0, discount: 0, shipping: 0, total: 0, bookCount: 0, subtotalMinor: 0, discountMinor: 0, shippingMinor: 0, totalMinor: 0, currency })
  }
  const quoteResult = await quoteCart(c.env.DB, items, body.code, currency)
  const ship = body.shipping ? await shippingForCurrency(c.env.DB, String(body.shipping), currency) : { priceMinor: 0 }
  const shippingMinor = body.shipping ? ship.priceMinor : 0
  // INTEGER minor units are the financial truth (D-09); the decimal fields
  // are derived display values for compatibility.
  const totalMinor = quoteResult.subtotalMinor - quoteResult.discountMinor + shippingMinor
  return c.json({
    subtotal: quoteResult.subtotal,
    discount: quoteResult.discount,
    code: quoteResult.appliedCode,
    bookCount: quoteResult.bookCount,
    shipping: minorToMajor(shippingMinor),
    total: minorToMajor(totalMinor),
    subtotalMinor: quoteResult.subtotalMinor,
    discountMinor: quoteResult.discountMinor,
    shippingMinor,
    totalMinor,
    currency: quoteResult.currency,
    invalid: quoteResult.invalid
  })
}
app.post('/api/v1/cart/quote', handleQuote)
app.post('/api/quote', handleQuote)
app.post('/api/cart/quote', handleQuote)

// Server-owned cover/format variants (D-08) — the PDP, reader, cart, quote
// and order snapshot all resolve prices from these rows, so they cannot
// disagree. Available/unavailable is decided here, never by the browser.
app.get('/api/v1/products/:slug/variants', async (c) => {
  const pv = await getProductVariants(c.env.DB, c.req.param('slug'))
  if (!pv) return c.json({ error: { code: 'unknown_product', message: 'Unknown or inactive product.' } }, 404)
  return c.json({ productSlug: pv.product.slug, currency: pv.currency, variants: pv.variants })
})

// Place an order (guest or logged-in). Server recomputes ALL prices, writes
// order+items atomically, and is idempotent under an `Idempotency-Key`
// header (falls back to a body field, then a server-generated key so a
// caller that sends neither still gets a single valid order — just without
// retry-safety). See src/orders.ts for the full contract.
// Canonical: POST /api/v1/orders. Legacy alias kept, tested: POST /api/orders.
async function handleCreateOrder(c: Context<{ Bindings: Bindings; Variables: Vars }>) {
  const body = await c.req.json<CreateOrderInput>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const idempotencyKey = c.req.header('Idempotency-Key') || body.idempotencyKey
  // S-06: order creation is rate limited by action + IP (identity is hashed
  // into the bucket key, never stored).
  const orderLimit = await durableRateLimit(c.env.DB, rateLimitKey('order-create', c), { max: 20, windowSeconds: 3600 })
  if (orderLimit.limited) {
    return c.json({ error: 'Too many orders attempted right now. Please try again in a little while.' }, 429)
  }
  const user = c.get('user')
  const ownerToken = getOrSetUploadOwnerToken(c)

  let tokenConfig
  try {
    tokenConfig = resolveGuestOrderTokenSecrets(c.env)
  } catch (err) {
    if (err instanceof MissingSecretError) {
      return c.json({ error: 'Checkout is temporarily unavailable (server misconfigured). Please try again shortly.' }, 503)
    }
    throw err
  }

  const personalizationOwner = await resolvePersonalizationOwner(c)
  const result = await createOrder(
    c.env.DB,
    // SF-03/PLT-07: the currency is the SERVER's resolved store choice. A
    // client-supplied `currency` in the body is overwritten here, so it can
    // never influence what the server charges.
    { ...body, idempotencyKey, currency: storeOf(c).currency },
    { userId: user?.id ?? null, uploadOwnerToken: ownerToken, secrets: tokenConfig.secrets, guestTokenTtlSeconds: tokenConfig.ttlSeconds, personalizationOwner }
  )
  if (!result.ok) return c.json({ error: result.error }, result.status as any)
  return c.json({ ok: true, id: result.orderId, guestToken: result.guestToken, replayed: result.replayed })
}
app.post('/api/v1/orders', handleCreateOrder)
app.post('/api/orders', handleCreateOrder)

// Guest order access via HMAC capability token (never a bare sequential ID).
app.get('/api/v1/orders/:id/guest', async (c) => {
  const id = Number(c.req.param('id'))
  const token = c.req.query('token') || ''
  let ok = false
  try {
    const cfg = resolveGuestOrderTokenSecrets(c.env)
    ok = await verifyGuestOrderToken(cfg.secrets, id, token, { previousDeadline: cfg.previousDeadline })
  } catch (err) {
    if (!(err instanceof MissingSecretError)) throw err
  }
  if (!ok) return c.json({ error: 'Order not found' }, 404)
  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first()
  if (!order) return c.json({ error: 'Order not found' }, 404)
  const items = (await c.env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(id).all()).results || []
  return c.json({ order, items })
})

/** The request's IP DIGEST (never the raw address), for session/security metadata. */
async function callerIpDigestFor(c: Context<{ Bindings: Bindings; Variables: Vars }>): Promise<string | null> {
  try {
    return await ipDigest({ IP_HASH_SECRET: c.env.IP_HASH_SECRET, GUEST_ORDER_TOKEN_SECRET: c.env.GUEST_ORDER_TOKEN_SECRET }, clientIpOf(c))
  } catch {
    return null
  }
}

function mailEnvOf(c: Context<{ Bindings: Bindings; Variables: Vars }>): MailEnv {
  return {
    ENVIRONMENT: c.env.ENVIRONMENT,
    EMAIL_PROVIDER: c.env.EMAIL_PROVIDER,
    EMAIL_API_URL: c.env.EMAIL_API_URL,
    EMAIL_API_KEY: c.env.EMAIL_API_KEY,
    EMAIL_FROM: c.env.EMAIL_FROM,
    EMAIL_FROM_NAME: c.env.EMAIL_FROM_NAME
  }
}

// Logged-in customer's own orders — ownership enforced by user_id match,
// never by the client-supplied order id alone. Canonical: /api/v1/my/orders[.../:id].
// Legacy aliases kept, tested: /api/my/orders[.../:id].
async function handleMyOrders(c: Context<{ Bindings: Bindings; Variables: Vars }>) {
  const auth = requireAuth(c)
  if (auth instanceof Response) return auth
  // V2 Phase 5 (CUS-05/CUS-10): the read model adds the ledger-derived payment
  // state, the real totals in minor units and the per-order affordances, while
  // every field the pre-Phase-5 client read (id, created_at, item_count, status,
  // total, total_minor) keeps its exact place and meaning.
  const rows = await listCustomerOrders(c.env.DB, auth.id)
  const orders = rows.map((o) => ({
    id: o.id,
    full_name: o.full_name,
    email: o.email,
    city: o.city,
    country: o.country,
    subtotal: o.subtotal,
    discount: o.discount,
    shipping: o.shipping,
    total: o.total,
    status: o.status,
    created_at: o.created_at,
    item_count: o.itemCount,
    subtotal_minor: o.subtotal_minor,
    discount_minor: o.discount_minor,
    shipping_minor: o.shipping_minor,
    total_minor: o.total_minor ?? Math.round(Number(o.total || 0) * 100),
    currency: o.currency,
    payment_status: o.payment_status,
    payment_status_label: paymentStatusLabel(o.payment_status),
    amount_captured_minor: o.amount_captured_minor,
    amount_refunded_minor: o.amount_refunded_minor,
    total_label: o.totalLabel,
    captured_label: o.capturedLabel
  }))
  return c.json({ orders })
}
async function handleMyOrderDetail(c: Context<{ Bindings: Bindings; Variables: Vars }>) {
  const auth = requireAuth(c)
  if (auth instanceof Response) return auth
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Order not found' }, 404)
  const detail = await getCustomerOrder(c.env.DB, auth.id, id)
  // "not yours" and "does not exist" are deliberately the same answer.
  if (!detail) return c.json({ error: 'Order not found' }, 404)

  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>()
  const itemRows = (await c.env.DB.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').bind(id).all<Record<string, unknown>>()).results || []
  const entitlements = (await c.env.DB.prepare('SELECT public_id, order_item_id, status, expires_at FROM download_entitlements WHERE order_id = ?').bind(id).all<{ public_id: string; order_item_id: number; status: string; expires_at: number }>()).results || []
  const byItem = new Map(entitlements.map((e) => [Number(e.order_item_id), e]))

  return c.json({
    order: order || {},
    items: itemRows,
    // ---- V2 Phase 5 additions (CUS-06/CUS-10) ----
    // The timeline is the append-only order_state_events log itself: every entry
    // is something that was recorded, with its actor and reason.
    timeline: detail.timeline,
    payments: detail.payments,
    refunds: detail.refunds,
    addresses: detail.addresses,
    production: detail.order.production,
    summary: {
      currency: detail.order.currency,
      totalLabel: detail.order.totalLabel,
      capturedLabel: detail.order.capturedLabel,
      refundedLabel: detail.order.refundedLabel,
      outstandingMinor: detail.order.outstandingMinor,
      paymentStatus: detail.order.payment_status,
      paymentStatusLabel: paymentStatusLabel(detail.order.payment_status),
      itemCount: detail.order.itemCount
    },
    itemsDetail: detail.items,
    downloads: itemRows.map((row) => {
      const e = byItem.get(Number(row.id))
      return { orderItemId: Number(row.id), entitlementId: e?.public_id ?? null, status: e?.status ?? null, expiresAt: e ? new Date(Number(e.expires_at) * 1000).toISOString() : null }
    }),
    receiptUrl: `/my/orders/${id}/receipt`
  })
}
app.get('/api/v1/my/orders', handleMyOrders)
app.get('/api/my/orders', handleMyOrders)
app.get('/api/v1/my/orders/:id', handleMyOrderDetail)
app.get('/api/my/orders/:id', handleMyOrderDetail)

// Legacy endpoint kept for the demo: latest orders by email (no auth). Removed for privacy.
app.get('/api/orders', (c) => c.json({ error: 'Login and use /api/my/orders' }, 401))

// ---------- password reset (JSON API — same core logic as the SSR /forgot-password, /reset-password forms) ----------
app.post('/api/v1/auth/forgot-password', async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as any)
  const baseUrl = new URL(c.req.url).origin + '/reset-password'
  await requestPasswordReset(c.env.DB, body.email || '', baseUrl, c.env.ENVIRONMENT)
  // Always the same response — no enumeration signal either way.
  return c.json({ ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE })
})
app.post('/api/v1/auth/reset-password', async (c) => {
  const body = await c.req.json<{ token?: string; password?: string }>().catch(() => ({}) as any)
  const result = await resetPassword(c.env.DB, body.token || '', body.password || '')
  if (!result.ok) return c.json({ error: result.error }, 400)
  return c.json({ ok: true })
})

// ================= ADMIN =================

app.get('/admin/login', (c) => {
  const u = c.get('user')
  if (u?.role === 'admin') return c.redirect('/admin')
  return c.html(adminLogin())
})
app.post('/admin/login', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').toLowerCase().trim()
  const password = String(body.password || '')
  // S-06: admin login is a credential-guessing target and is rate limited too.
  const limit = await durableRateLimit(c.env.DB, rateLimitKey('admin-login', c, email), { max: 5, windowSeconds: 15 * 60 })
  if (limit.limited) return c.html(adminLogin('Too many attempts. Please wait before trying again.'))
  const user = await c.env.DB.prepare("SELECT id, name, email, role, password_hash FROM users WHERE email = ? AND role = 'admin'")
    .bind(email)
    .first<AuthUser & { password_hash: string }>()
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.html(adminLogin('Invalid admin credentials.'))
  }
  // S-02: rotating session on admin authentication too.
  await rotateSessionOnLogin(c, c.env.DB, user.id)
  return c.redirect('/admin')
})

// Admin guard for everything below — the ONE central admin authorization
// check (S-08 prerequisite). `adminActor` also supplies the actor for audit.
app.use('/admin/*', async (c, next) => {
  const actor = adminActor(c, 'page')
  if (actor instanceof Response) return actor
  await next()
})
app.use('/admin', async (c, next) => {
  const actor = adminActor(c, 'page')
  if (actor instanceof Response) return actor
  await next()
})

/** Records one immutable audit event for an admin mutation (never blocks on failure of the action itself). */
async function auditAdmin(
  c: Context<{ Bindings: Bindings; Variables: Vars }>,
  action: string,
  entityType: string,
  entityId: string | number | null,
  reason: string | null,
  metadata?: Record<string, unknown>
) {
  const actor = c.get('user')
  await recordAdminAudit(c.env.DB, {
    actorUserId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    action,
    entityType,
    entityId,
    reason,
    metadata
  })
}

app.get('/admin', async (c) => {
  const db = c.env.DB
  const nowSec = Math.floor(Date.now() / 1000)
  // ADM-03: ONE model. Every money figure comes from the payment ledger and every
  // operational figure is a real row count of the state a phase actually writes —
  // no tile is derived from a status string, and none is invented.
  const model = await dashboardModel(db, nowSec)
  const one = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0
  // INTEGER minor units are the authoritative total (D-09). This is order
  // VALUE, not revenue (S-10/ADM-03) — the revenue tiles come from the ledger.
  const orderValueMinor =
    (await db.prepare("SELECT COALESCE(SUM(total_minor),0) n FROM orders WHERE status <> 'cancelled'").first<{ n: number }>())?.n ?? 0
  const pending = await one("SELECT COUNT(*) n FROM orders WHERE status IN ('awaiting_preview','preview_ready','approved')")
  return c.html(
    adminDashboard({
      permissions: adminPerms(c),
      orders: model.counts.orders,
      orderValue: minorToMajor(orderValueMinor),
      users: model.counts.users,
      products: model.counts.products,
      pending,
      messages: model.counts.contactMessages,
      recentOrders: model.recentOrders,
      revenue: model.summary.revenueByCurrency.map((r) => ({
        currency: r.currency,
        capturedMinor: r.capturedMinor,
        refundedMinor: r.refundedMinor,
        netMinor: r.netMinor,
        paidOrders: r.paidOrders
      })),
      unpaidOrders: model.summary.unpaid.orders,
      extraHtml: adminOpsDashboardSection(model.counts, model.issues)
    })
  )
})

app.get('/admin/orders', async (c) => {
  const status = c.req.query('status') || ''
  const where = status ? 'WHERE o.status = ?' : ''
  const stmt = c.env.DB.prepare(
    `SELECT o.*, (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
     FROM orders o ${where} ORDER BY o.id DESC LIMIT 200`
  )
  const rows = (await (status ? stmt.bind(status) : stmt).all()).results || []
  return c.html(adminOrders(rows, status, adminPerms(c)))
})

app.get('/admin/orders/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const db = c.env.DB
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, any>>()
  if (!order) return c.html(adminPage404())
  const items = (await db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(id).all()).results || []
  // ADM-04/ADM-12: the payment, ledger, address and timeline evidence for this
  // order, rendered only for a caller with the finance read permission.
  const [attempts, refunds, ledger, timeline, addresses] = await Promise.all([
    db.prepare('SELECT * FROM payment_attempts WHERE order_id = ? ORDER BY id DESC').bind(id).all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY id DESC').bind(id).all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM order_financial_entries WHERE order_id = ? ORDER BY id').bind(id).all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM order_state_events WHERE order_id = ? ORDER BY id').bind(id).all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM order_addresses WHERE order_id = ? ORDER BY kind').bind(id).all<Record<string, unknown>>()
  ])
  const financeRead = permits(adminPerms(c), FINANCE_PERMISSIONS.read)
  // ADM-20: the refund form on this page is a high-risk action, so the page
  // issues the single-use confirmation it must carry. The guard refuses the POST
  // without it.
  const refundReauth = permits(adminPerms(c), FINANCE_PERMISSIONS.refund)
    ? await issueReauthTicket(c, 'POST /admin/orders/:id/refunds', `/admin/orders/${id}/refunds`)
    : null
  const financeHtml = orderFinancePanel({
    order,
    attempts: attempts.results || [],
    refunds: refunds.results || [],
    ledger: ledger.results || [],
    timeline: timeline.results || [],
    addresses: addresses.results || [],
    canRefund: permits(adminPerms(c), FINANCE_PERMISSIONS.refund),
    canRead: financeRead,
    refundReauth
  })
  // V2 §10: the child's photograph is NOT linked by its object key. For an
  // operator whose roles include `books.read` the page mints ONE short-lived,
  // single-use capability per item photo; every other role (finance, for example)
  // gets a placeholder, because seeing an order is not the same authority as
  // seeing a customer's child.
  const photoUrls = new Map<number, string>()
  const mayReadPrivatePhotos = permits(adminPerms(c), 'books.read')
  if (mayReadPrivatePhotos) {
    const actor = c.get('user')
    for (const item of items as Array<{ id: number; photo_key?: string | null }>) {
      const url = await adminMediaUrl(db, { userId: Number(actor?.id ?? 0), kind: 'photo', objectKey: item.photo_key })
      if (url) photoUrls.set(Number(item.id), url)
    }
  }
  return c.html(
    adminOrderDetail(
      order,
      items,
      c.req.query('saved') ? 'Saved.' : undefined,
      c.req.query('error') || undefined,
      financeHtml,
      adminPerms(c),
      photoUrls,
      mayReadPrivatePhotos
    )
  )
})

app.post('/admin/orders/:id/status', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  // S-07: a validated, enum-checked transition — not an arbitrary string write.
  const result = await transitionOrderStatus(c.env.DB, {
    orderId: id,
    to: String(body.status || ''),
    reason: String(body.reason || ''),
    actor: { userId: c.get('user')?.id ?? null, email: c.get('user')?.email ?? null, requestId: c.get('requestId') ?? undefined }
  })
  if (!result.ok) return c.redirect(`/admin/orders/${id}?error=${encodeURIComponent(result.error)}`)
  if (!result.noop) await auditAdmin(c, 'order.status_change', 'order', id, String(body.reason || ''), { from: result.from, to: result.to })
  return c.redirect(`/admin/orders/${id}?saved=1`)
})

app.post('/admin/orders/:id/notes', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  await c.env.DB.prepare('UPDATE orders SET admin_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(String(body.notes || ''), id)
    .run()
  await auditAdmin(c, 'order.notes_update', 'order', id, null, { length: String(body.notes || '').length })
  return c.redirect(`/admin/orders/${id}?saved=1`)
})

app.post('/admin/items/:id/preview', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  const item = await c.env.DB.prepare('SELECT order_id FROM order_items WHERE id = ?').bind(id).first<{ order_id: number }>()
  if (!item) return c.redirect('/admin/orders')
  // S-07: enum-checked, reason-guarded preview transition with history.
  const result = await transitionPreviewStatus(c.env.DB, {
    itemId: id,
    to: String(body.preview_status || ''),
    reason: String(body.reason || ''),
    actor: { userId: c.get('user')?.id ?? null, email: c.get('user')?.email ?? null, requestId: c.get('requestId') ?? undefined }
  })
  if (!result.ok) return c.redirect(`/admin/orders/${item.order_id}?error=${encodeURIComponent(result.error)}`)
  if (!result.noop) await auditAdmin(c, 'order_item.preview_status_change', 'order_item', id, String(body.reason || ''), { from: result.from, to: result.to })
  return c.redirect(`/admin/orders/${item.order_id}?saved=1`)
})

// ---- products CRUD ----
app.get('/admin/products', async (c) => {
  const rows = await queryProducts(c.env.DB, { includeInactive: true })
  return c.html(adminProducts(rows, c.req.query('saved') ? 'Saved.' : undefined, adminPerms(c)))
})

app.get('/admin/products/new', (c) => c.html(adminProductForm(null, undefined, adminPerms(c))))

app.post('/admin/products/new', async (c) => {
  const b = await c.req.parseBody()
  const slug = slugify(String(b.slug || b.title || ''))
  // L-C: the product AND its default variant are created in one atomic batch,
  // so a new product can never exist as an active product with no default
  // variant. Invalid/non-numeric prices are rejected with a friendly message
  // instead of hitting the 0018 database trigger.
  const result = await createProduct(c.env.DB, {
    slug,
    title: String(b.title || ''),
    tagline: String(b.tagline || ''),
    description: String(b.description || ''),
    story: String(b.story || ''),
    priceMinor: Math.round(Number(b.price || 0) * 100),
    compareAtPriceMinor: b.compare_at ? Math.round(Number(b.compare_at) * 100) : null,
    image: String(b.image || ''),
    gender: String(b.gender || 'unisex'),
    category: String(b.category || 'book'),
    ages: String(b.ages || ''),
    ageMin: Number(b.age_min || 2),
    ageMax: Number(b.age_max || 10),
    pages: Number(b.pages || 32),
    reviews: Number(b.reviews || 0),
    rating: Number(b.rating || 4.8),
    bestseller: !!b.bestseller,
    newRelease: !!b.new_release,
    career: !!b.career,
    traits: String(b.traits || '').split('\n').map((s) => s.trim()).filter(Boolean),
    active: !!b.active
  })
  if (!result.ok) return c.html(adminProductForm(null, `Could not create: ${result.error}`, adminPerms(c)))
  return c.redirect('/admin/products?saved=1')
})

app.get('/admin/products/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<any>()
  if (!row) return c.html(adminPage404())
  const { toProduct } = await import('./db')
  const p = { ...toProduct(row), active: row.active } as any
  return c.html(adminProductForm(p, c.req.query('saved') ? 'Saved.' : undefined, adminPerms(c)))
})

app.post('/admin/products/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.parseBody()
  // L-C: activating a product whose "exactly one active default variant"
  // invariant is unmet is refused, with the reason shown on the form.
  const result = await updateProduct(c.env.DB, {
    id,
    slug: '',
    title: String(b.title || ''),
    tagline: String(b.tagline || ''),
    description: String(b.description || ''),
    story: String(b.story || ''),
    priceMinor: Math.round(Number(b.price || 0) * 100),
    compareAtPriceMinor: b.compare_at ? Math.round(Number(b.compare_at) * 100) : null,
    image: String(b.image || ''),
    gender: String(b.gender || 'unisex'),
    category: String(b.category || 'book'),
    ages: String(b.ages || ''),
    ageMin: Number(b.age_min || 2),
    ageMax: Number(b.age_max || 10),
    pages: Number(b.pages || 32),
    reviews: Number(b.reviews || 0),
    rating: Number(b.rating || 4.8),
    bestseller: !!b.bestseller,
    newRelease: !!b.new_release,
    career: !!b.career,
    traits: String(b.traits || '').split('\n').map((s) => s.trim()).filter(Boolean),
    active: !!b.active
  })
  if (!result.ok) {
    const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<any>()
    const { toProduct } = await import('./db')
    const p = row ? ({ ...toProduct(row), active: row.active } as any) : null
    return c.html(adminProductForm(p, `Could not save: ${result.error}`, adminPerms(c)))
  }
  return c.redirect(`/admin/products/${id}?saved=1`)
})

// ================= PDP EDITOR =================
// Every mutating PDP-editor request is audited centrally, so no individual
// section handler can forget to. (Authorization is the shared /admin guard.)
app.use('/admin/products/:id/pdp/*', async (c, next) => {
  await next()
  if (c.req.method === 'POST' && c.res.status < 400) {
    await auditAdmin(c, 'pdp.mutation', 'product', c.req.param('id') ?? null, null, { path: new URL(c.req.url).pathname })
  }
})
// Mounted under the same /admin guard used above. Admin goes to /admin/products/:id and clicks "Edit page".
app.get('/admin/products/:id/pdp', async (c) => {
  const id = Number(c.req.param('id'))
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<any>()
  if (!row) return c.html(adminLogin('Product not found.'))
  const { toProduct } = await import('./db')
  const p = { ...toProduct(row), active: row.active } as any
  // No globalThis / module-level request state (C-07): adminPdpEditor loads
  // the product list it needs itself, request-scoped.
  return adminPdpEditor(c, p)
})

// Helpers — small handlers that the editor posts to.
async function loadPdpProduct(c: Context<{ Bindings: Bindings; Variables: Vars }>) {
  const id = Number(c.req.param('id'))
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<any>()
  if (!row) return null
  const { toProduct } = await import('./db')
  return { ...toProduct(row), active: row.active } as any
}

function num(v: any, fallback: number) { const n = Number(v); return Number.isFinite(n) ? n : fallback }
function int(v: any, fallback: number) { return Math.trunc(num(v, fallback)) }

app.post('/admin/products/:id/pdp/banner', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await savePdpPage(c.env.DB, p.id, {
    banner_text: String(b.banner_text || ''),
    banner_code: String(b.banner_code || '').toUpperCase().trim(),
    banner_badge: String(b.banner_badge || ''),
    preorder_note: String(b.preorder_note || '')
  })
  return c.redirect(`/admin/products/${p.id}/pdp?#banner`)
})

app.post('/admin/products/:id/pdp/gallery', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  await upsertGallery(c.env.DB, p.id, id, String(b.image_url || ''), String(b.alt || ''), int(b.sort_order, 0), b.active ? 1 : 0)
  return c.redirect(`/admin/products/${p.id}/pdp?#gallery`)
})
app.post('/admin/products/:id/pdp/gallery/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteGallery(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#gallery`)
})

app.post('/admin/products/:id/pdp/accordion', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  await upsertAccordion(c.env.DB, p.id, id, String(b.title || ''), String(b.body || ''), int(b.sort_order, 0), b.active ? 1 : 0)
  return c.redirect(`/admin/products/${p.id}/pdp?#accordions`)
})
app.post('/admin/products/:id/pdp/accordion/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteAccordion(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#accordions`)
})

app.post('/admin/products/:id/pdp/step', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await upsertStep(c.env.DB, p.id, int(b.step_no, 1), String(b.title || ''), String(b.body || ''))
  return c.redirect(`/admin/products/${p.id}/pdp?#steps`)
})

app.post('/admin/products/:id/pdp/tip', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  const kind = String(b.kind || 'good') === 'bad' ? 'bad' : 'good'
  await upsertTip(c.env.DB, p.id, id, kind, String(b.label || ''), String(b.image_url || ''), int(b.sort_order, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#tips`)
})
app.post('/admin/products/:id/pdp/tip/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteTip(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#tips`)
})

app.post('/admin/products/:id/pdp/magic', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await saveMagic(c.env.DB, p.id, {
    heading: String(b.heading || ''),
    left_image: String(b.left_image || ''),
    left_caption: String(b.left_caption || ''),
    right_image: String(b.right_image || ''),
    right_caption: String(b.right_caption || ''),
    body: String(b.body || '')
  })
  return c.redirect(`/admin/products/${p.id}/pdp?#magic`)
})

app.post('/admin/products/:id/pdp/trust', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  await upsertTrust(c.env.DB, p.id, id, String(b.title || ''), String(b.body || ''), String(b.icon || 'sparkle'), int(b.sort_order, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#trust`)
})
app.post('/admin/products/:id/pdp/trust/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteTrust(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#trust`)
})

app.post('/admin/products/:id/pdp/reaction', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  await upsertReaction(c.env.DB, p.id, id, String(b.name || ''), int(b.rating, 5), String(b.review || ''), String(b.image_url || ''), int(b.sort_order, 0), b.active ? 1 : 0)
  return c.redirect(`/admin/products/${p.id}/pdp?#reactions`)
})
app.post('/admin/products/:id/pdp/reaction/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteReaction(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#reactions`)
})

app.post('/admin/products/:id/pdp/media', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  await upsertMedia(c.env.DB, p.id, id, String(b.name || ''), String(b.image_url || ''), String(b.href || ''), int(b.sort_order, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#media`)
})
app.post('/admin/products/:id/pdp/media/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteMedia(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#media`)
})

app.post('/admin/products/:id/pdp/related', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const raw = String(b.related_ids || '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0 && n !== p.id)
  await setRelated(c.env.DB, p.id, raw)
  return c.redirect(`/admin/products/${p.id}/pdp?#related`)
})

app.post('/admin/products/:id/pdp/faq', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  await upsertFaq(c.env.DB, p.id, id, String(b.question || ''), String(b.answer || ''), int(b.sort_order, 0), b.active ? 1 : 0)
  return c.redirect(`/admin/products/${p.id}/pdp?#faqs`)
})
app.post('/admin/products/:id/pdp/faq/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteFaq(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#faqs`)
})

// ---- discounts / promotions (ADM-16) ----
// The form is a UX convenience; the SERVER is the authority. Every rule field is
// validated here and the authoritative rate is an INTEGER basis-point value, so
// no pricing path ever reads the legacy REAL `percent` column.
app.get('/admin/discounts', async (c) => {
  const rows = (await c.env.DB.prepare('SELECT * FROM discounts ORDER BY priority, id').all<DiscountRow & Record<string, unknown>>()).results || []
  const usage =
    (
      await c.env.DB
        .prepare('SELECT discount_id, COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total FROM coupon_redemptions GROUP BY discount_id')
        .all<{ discount_id: number; n: number; total: number }>()
    ).results || []
  const usageMap = new Map(usage.map((u) => [Number(u.discount_id), { count: Number(u.n), totalMinor: Number(u.total) }]))
  return c.html(adminDiscounts(rows, usageMap, c.req.query('saved') ? 'Saved.' : undefined, c.req.query('error') || undefined, adminPerms(c)))
})

app.post('/admin/discounts', async (c) => {
  const b = await c.req.parseBody()
  const code = String(b.code || '').toUpperCase().trim()
  const percent = Number(b.percent || 0)
  const minBooks = Number(b.min_books || 0)
  const appliesTo = String(b.applies_to || 'books')
  const scope = String(b.scope || appliesTo)
  const percentBps = Math.round(percent * 100)
  const optionalInt = (raw: unknown, label: string, min: number, max: number): { ok: true; value: number | null } | { ok: false; error: string } => {
    const text = String(raw ?? '').trim()
    if (!text) return { ok: true, value: null }
    const n = Number(text)
    if (!Number.isInteger(n) || n < min || n > max) return { ok: false, error: `${label} must be a whole number between ${min} and ${max} (or left blank).` }
    return { ok: true, value: n }
  }
  const dateField = (raw: unknown, label: string): { ok: true; value: string | null } | { ok: false; error: string } => {
    const text = String(raw ?? '').trim()
    if (!text) return { ok: true, value: null }
    const parsed = new Date(text)
    if (Number.isNaN(parsed.getTime())) return { ok: false, error: `${label} must be a date.` }
    return { ok: true, value: parsed.toISOString() }
  }
  const minSubtotalMajor = optionalInt(b.min_subtotal, 'Minimum subtotal', 0, 1_000_000)
  const maxUses = optionalInt(b.max_uses, 'Total usage limit', 1, 1_000_000)
  const maxPerOwner = optionalInt(b.max_uses_per_owner, 'Per-customer limit', 1, 1_000_000)
  const maxDiscountMajor = optionalInt(b.max_discount, 'Maximum discount', 0, 1_000_000)
  const startsAt = dateField(b.starts_at, 'Start date')
  const endsAt = dateField(b.ends_at, 'End date')

  const problems: string[] = []
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) problems.push('The code must be 2–32 characters of A–Z, 0–9, underscore or dash.')
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) problems.push('The percentage must be between 1 and 100.')
  if (!Number.isInteger(minBooks) || minBooks < 0 || minBooks > 100) problems.push('The minimum number of books must be a whole number between 0 and 100.')
  if (!['books', 'all'].includes(appliesTo)) problems.push('Choose whether the code applies to books only or the whole cart.')
  if (!['books', 'stickers', 'all'].includes(scope)) problems.push('The scope must be books, stickers or the whole cart.')
  for (const [result, label] of [
    [minSubtotalMajor, 'minimum subtotal'],
    [maxUses, 'total usage limit'],
    [maxPerOwner, 'per-customer limit'],
    [maxDiscountMajor, 'maximum discount'],
    [startsAt, 'start date'],
    [endsAt, 'end date']
  ] as const) {
    if (!result.ok) problems.push(result.error)
    void label
  }
  if (startsAt.ok && endsAt.ok && startsAt.value && endsAt.value && endsAt.value <= startsAt.value) {
    problems.push('The end date must be after the start date.')
  }
  if (problems.length) return c.redirect('/admin/discounts?error=' + encodeURIComponent(problems[0]))

  // Validation passed, so every parse result is a success: read the values once,
  // explicitly, rather than re-narrowing a union at each use site.
  const vStartsAt = startsAt.ok ? startsAt.value : null
  const vEndsAt = endsAt.ok ? endsAt.value : null
  const vMinSubtotalMinor = minSubtotalMajor.ok && minSubtotalMajor.value != null ? Math.round(minSubtotalMajor.value * 100) : null
  const vMaxUses = maxUses.ok ? maxUses.value : null
  const vMaxPerOwner = maxPerOwner.ok ? maxPerOwner.value : null
  const vMaxDiscountMinor = maxDiscountMajor.ok && maxDiscountMajor.value != null ? Math.round(maxDiscountMajor.value * 100) : null

  try {
    await c.env.DB.prepare(
      `INSERT INTO discounts (code, percent, percent_bps, min_books, applies_to, scope, auto_apply, active,
                              stackable, priority, starts_at, ends_at, min_subtotal_minor, max_uses, max_uses_per_owner, max_discount_minor)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        code,
        percent,
        percentBps,
        minBooks,
        appliesTo,
        scope,
        b.auto_apply ? 1 : 0,
        b.stackable ? 1 : 0,
        Number.isInteger(Number(b.priority)) ? Number(b.priority) : 100,
        vStartsAt,
        vEndsAt,
        vMinSubtotalMinor,
        vMaxUses,
        vMaxPerOwner,
        vMaxDiscountMinor
      )
      .run()
  } catch {
    return c.redirect('/admin/discounts?error=' + encodeURIComponent('That discount code already exists.'))
  }
  await auditAdmin(c, 'discount.create', 'discount', code, null, {
    percentBps,
    minBooks,
    appliesTo,
    scope,
    autoApply: b.auto_apply ? 1 : 0,
    stackable: b.stackable ? 1 : 0
  })
  return c.redirect('/admin/discounts?saved=1')
})

/** Editing an existing promo's rules (ADM-16). The authoritative rate stays an integer. */
app.post('/admin/discounts/:id/update', async (c) => {
  const id = Number(c.req.param('id'))
  const existing = await c.env.DB.prepare('SELECT * FROM discounts WHERE id = ?').bind(id).first<DiscountRow & Record<string, unknown>>()
  if (!existing) return c.redirect('/admin/discounts?error=' + encodeURIComponent('That discount code no longer exists.'))
  const b = await c.req.parseBody()
  const percent = Number(b.percent ?? existing.percent)
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return c.redirect('/admin/discounts?error=' + encodeURIComponent('The percentage must be between 1 and 100.'))
  }
  const optionalMinor = (raw: unknown): number | null => {
    const text = String(raw ?? '').trim()
    if (!text) return null
    const n = Number(text)
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
  }
  const optionalCount = (raw: unknown): number | null => {
    const text = String(raw ?? '').trim()
    if (!text) return null
    const n = Number(text)
    return Number.isInteger(n) && n >= 1 ? n : null
  }
  const dateValue = (raw: unknown): string | null => {
    const text = String(raw ?? '').trim()
    if (!text) return null
    const parsed = new Date(text)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  await c.env.DB.prepare(
    `UPDATE discounts SET percent = ?, percent_bps = ?, applies_to = ?, scope = ?, stackable = ?, priority = ?,
            starts_at = ?, ends_at = ?, min_subtotal_minor = ?, max_uses = ?, max_uses_per_owner = ?, max_discount_minor = ?,
            active = ?
      WHERE id = ?`
  )
    .bind(
      percent,
      Math.round(percent * 100),
      String(b.applies_to ?? existing.applies_to),
      String(b.scope ?? existing.scope),
      b.stackable ? 1 : 0,
      Number.isInteger(Number(b.priority)) ? Number(b.priority) : Number(existing.priority ?? 100),
      b.starts_at !== undefined ? dateValue(b.starts_at) : (existing.starts_at as string | null),
      b.ends_at !== undefined ? dateValue(b.ends_at) : (existing.ends_at as string | null),
      b.min_subtotal !== undefined ? optionalMinor(b.min_subtotal) : (existing.min_subtotal_minor as number | null),
      b.max_uses !== undefined ? optionalCount(b.max_uses) : (existing.max_uses as number | null),
      b.max_uses_per_owner !== undefined ? optionalCount(b.max_uses_per_owner) : (existing.max_uses_per_owner as number | null),
      b.max_discount !== undefined ? optionalMinor(b.max_discount) : (existing.max_discount_minor as number | null),
      b.active ? 1 : 0,
      id
    )
    .run()
  await auditAdmin(c, 'discount.update', 'discount', id, null, { percentBps: Math.round(percent * 100) })
  return c.redirect('/admin/discounts?saved=1')
})

app.post('/admin/discounts/:id/toggle', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('UPDATE discounts SET active = 1 - active WHERE id = ?').bind(id).run()
  await auditAdmin(c, 'discount.toggle', 'discount', id, null, {})
  return c.redirect('/admin/discounts?saved=1')
})

// ---- users ----
// V2 Phase 2 admin screens (ADM-06/07/15/16): catalog, CMS, collections,
// media, reviews moderation, brand settings and localization readiness.
// Registered AFTER the /admin/* authorization guard above, so every route
// below is admin-only by construction.
registerAdminStoreRoutes(app)

// V2 Phase 6 (ADM-01..ADM-21): the admin control plane — customers, user books,
// support inbox, privacy/retention, integrations/health, events, staff/roles,
// audit, exports, fulfilment, and the /api/v1/admin JSON surface. Registered
// after the central guard, so every route here is already permission-checked.
registerAdminConsoleRoutes(app)

app.get('/admin/users', async (c) => {
  const rows =
    (
      await c.env.DB.prepare(
        `SELECT u.id, u.name, u.email, u.role, u.created_at,
                (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
         FROM users u ORDER BY u.id DESC LIMIT 300`
      ).all()
    ).results || []
  return c.html(adminUsers(rows, adminPerms(c)))
})

// ---- AI Settings & Book Generation API Settings ----
// No real provider API key is ever accepted, stored, returned, or read
// from D1 here — see migration 0008 and docs/API_V1.md. ai_settings.api_key
// is written only ever as '' below; a real key can only ever come from the
// AI_PROVIDER_API_KEY environment secret (Phase 3's real integration), and
// this page shows only whether that secret is SET, never its value.
app.get('/admin/ai-settings', async (c) => {
  let settings = await c.env.DB.prepare('SELECT * FROM ai_settings WHERE id = 1').first<AiSettingsRow>()
  if (!settings) {
    settings = {
      api_provider: 'custom',
      api_endpoint: '',
      api_key: '',
      model: '',
      style_preset: 'fairytale-watercolour',
      prompt_template: 'A magical illustrated fairytale storybook cover and inside scene depicting {child_name}, age {child_age}, in the story {book_title}. Art style: fairytale watercolor, warm soft lighting, vibrant colors.',
      face_swap_strength: 0.85,
      hardcover_price: 49.20,
      softcover_price: 34.20,
      enable_ai_preview: 1
    }
  }
  const envKeyConfigured = !!c.env.AI_PROVIDER_API_KEY
  return c.html(adminAiSettings(settings, envKeyConfigured, c.req.query('saved') ? 'AI API Settings saved successfully.' : undefined, adminPerms(c)))
})

app.post('/admin/ai-settings', async (c) => {
  const b = await c.req.parseBody()
  const provider = String(b.api_provider || 'custom')
  const endpoint = String(b.api_endpoint || '').trim()
  const model = String(b.model || '').trim()
  const stylePreset = String(b.style_preset || 'fairytale-watercolour')
  const promptTemplate = String(b.prompt_template || '')
  const faceSwapStrength = parseFloat(String(b.face_swap_strength || '0.85')) || 0.85
  const hardcoverPrice = parseFloat(String(b.hardcover_price || '49.20')) || 49.20
  const softcoverPrice = parseFloat(String(b.softcover_price || '34.20')) || 34.20
  const enableAi = b.enable_ai_preview ? 1 : 0

  await c.env.DB.prepare(`
    INSERT INTO ai_settings (id, api_provider, api_endpoint, api_key, model, style_preset, prompt_template, face_swap_strength, hardcover_price, softcover_price, enable_ai_preview, updated_at)
    VALUES (1, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      api_provider = excluded.api_provider,
      api_endpoint = excluded.api_endpoint,
      api_key = '',
      model = excluded.model,
      style_preset = excluded.style_preset,
      prompt_template = excluded.prompt_template,
      face_swap_strength = excluded.face_swap_strength,
      hardcover_price = excluded.hardcover_price,
      softcover_price = excluded.softcover_price,
      enable_ai_preview = excluded.enable_ai_preview,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    provider,
    endpoint,
    model,
    stylePreset,
    promptTemplate,
    faceSwapStrength,
    hardcoverPrice,
    softcoverPrice,
    enableAi
  ).run()

  // Never audits the endpoint/key value itself — only that the settings changed.
  await auditAdmin(c, 'ai_settings.update', 'ai_settings', 1, null, { provider, enableAiPreview: enableAi })
  return c.redirect('/admin/ai-settings?saved=1')
})

// Test Connection API for Admin Panel.
//
// Confirmed review finding (two rounds): this previously returned a
// hard-coded "success" for any endpoint containing "api." or a known provider host
// with no real request at all, and later (after the first fix) still made
// one genuine outbound call for the OpenAI branch. Per the explicit
// corrective instruction this must make NO network request of any kind —
// there is no real generation pipeline wired to this setting yet (Phase 3),
// so nothing here can be honestly "tested". Always an honest
// not-configured/not-tested response, never a real or simulated success,
// regardless of provider.
app.post('/api/admin/test-ai-connection', async (c) => {
  const actor = adminActor(c, 'json')
  if (actor instanceof Response) return actor

  const { provider, endpoint } = await c.req.json<any>().catch(() => ({}) as any)

  if (!endpoint) {
    return c.json({ success: false, message: 'Endpoint URL is required.' })
  }

  return c.json({
    success: false,
    notTested: true,
    message: `No real connection test is implemented for provider "${provider || 'custom'}" — this baseline makes no outbound AI calls at all (see Phase 3 in STORYBOOKCLONE_COMPLETION_CODING_PACK.md). Treat this as "not configured/not tested", never "working".`
  })
})

// Public PDF request API. This queues/records a request — it does NOT
// generate a PDF (that pipeline is a later phase; see
// STORYBOOKCLONE_COMPLETION_CODING_PACK.md Phase 7). Confirmed baseline
// defect: pdf_requests had no `cover_type` column even though this handler
// always tried to insert one, so every call 500'd (migration 0004 fixes the
// schema; this also fixes the response wording to stop implying delivery).
// Canonical: POST/GET /api/v1/books/pdf-requests[/:id].
// Legacy alias kept, tested: POST /api/books/pdf-request.
const PDF_REQUEST_COVER_TYPES = new Set(['hardcover', 'softcover'])
// Matches the guest-order-token default (docs/API_V1.md): long enough for
// a guest to reasonably come back and check status, bounded so a leaked
// capability doesn't work forever.
const PDF_REQUEST_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30
const PDF_REQUEST_RATE_LIMIT = { max: 5, windowSeconds: 60 * 60 }

async function handleCreatePdfRequest(c: Context<{ Bindings: Bindings; Variables: Vars }>) {
  const body = await c.req.json<any>().catch(() => ({}))
  const email = String(body.email || '').toLowerCase().trim()
  // bookSlug/childName/childAge below are the CLIENT-SUPPLIED values —
  // used only when there is no orderItemId at all (a generic/speculative
  // preview request, not tied to a real purchase). The moment a real
  // orderItemId is supplied and its ownership verifies, these are
  // OVERWRITTEN from the order_items row itself, never trusted from the
  // client — see "authoritative order item" below.
  let bookSlug = String(body.bookSlug || '')
  let childName = String(body.childName || '')
  let childAge = Number(body.childAge || 5)
  const coverType = String(body.coverType || 'hardcover')
  const orderItemId = body.orderItemId ? Number(body.orderItemId) : null
  const user = c.get('user')

  if (!email || !email.includes('@')) {
    return c.json({ success: false, error: 'Valid email is required.' }, 400)
  }
  // The submitted email is contact info only — it is NEVER used to decide
  // who may reference an order item below, and never consulted for rate
  // limiting until AFTER ownership is proven (see below) — an attacker who
  // knows/guesses someone else's email cannot use it to attach a request
  // to that person's order, and cannot burn through that email's rate
  // limit quota with requests that were never going to be authorized.
  if (!PDF_REQUEST_COVER_TYPES.has(coverType)) {
    return c.json({ success: false, error: `coverType must be one of: ${[...PDF_REQUEST_COVER_TYPES].join(', ')}.` }, 400)
  }

  if (orderItemId) {
    // Authoritative order item: derive book/personalization fields from
    // the DB row the caller actually owns, never from the client-supplied
    // duplicates above (which are simply discarded here, not merged or
    // trusted for a mismatch check — the simplest safe option).
    const itemRow = await c.env.DB.prepare(
      'SELECT oi.id, oi.order_id, oi.slug, oi.child_name, oi.child_age, o.user_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = ?'
    )
      .bind(orderItemId)
      .first<{ id: number; order_id: number; slug: string; child_name: string | null; child_age: number | null; user_id: number | null }>()
    // Generic rejection for every "not yours" shape (doesn't exist, belongs
    // to someone else, belongs to an account when you're a guest, or your
    // guest capability token doesn't check out) — do not let the response
    // distinguish which, same enumeration-safe reasoning as guest order
    // access.
    let orderItemOwned = false
    if (itemRow) {
      if (user) {
        orderItemOwned = itemRow.user_id === user.id
      } else if (itemRow.user_id === null) {
        const guestOrderToken = String(body.guestOrderToken || '')
        if (guestOrderToken) {
          try {
            const cfg = resolveGuestOrderTokenSecrets(c.env)
            orderItemOwned = await verifyGuestOrderToken(cfg.secrets, itemRow.order_id, guestOrderToken, { previousDeadline: cfg.previousDeadline })
          } catch (err) {
            if (!(err instanceof MissingSecretError)) throw err
          }
        }
      }
    }
    if (!orderItemOwned || !itemRow) return c.json({ success: false, error: 'That order item could not be verified.' }, 400)

    // Ownership proven — now safe to derive the real fields. Deliberately
    // does NOT require the product to still be `active`: a customer who
    // legitimately bought a book that was later hidden from the storefront
    // must not lose access to their own purchase's PDF request just
    // because it's no longer for sale.
    bookSlug = itemRow.slug
    childName = itemRow.child_name || ''
    childAge = itemRow.child_age || childAge
  } else {
    // No specific purchase referenced — a generic/speculative preview
    // request. This path DOES require a currently active product, since
    // there is no historical-purchase record to fall back on.
    if (!bookSlug || !(await getProductBySlug(c.env.DB, bookSlug))) {
      return c.json({ success: false, error: 'Unknown or inactive book.' }, 400)
    }
  }

  // Rate limit consumed ONLY after the request above is known to be
  // legitimate (valid coverType, and — when orderItemId was supplied —
  // proven ownership). One atomic INSERT...ON CONFLICT...RETURNING
  // (src/rate-limit.ts), hashed bucket — no raw email persisted, no
  // separate check-then-record gap for a concurrent request to land in.
  const bucket = `pdf-request:${email}`
  const { limited } = await consumeRateLimit(c.env.DB, bucket, PDF_REQUEST_RATE_LIMIT)
  if (limited) {
    return c.json({ success: false, error: 'Too many requests — please try again later.' }, 429)
  }

  // A random capability token, shown ONLY in this response (only its
  // SHA-256 hash is stored) — this is what lets an unauthenticated guest
  // check their own request's status without exposing every request to
  // anyone who can guess/enumerate a sequential id (confirmed baseline gap).
  // Expires — see PDF_REQUEST_TOKEN_TTL_SECONDS — not a forever-valid link.
  const rawToken = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const tokenHash = await sha256Hex(rawToken)
  const expiresAt = Math.floor(Date.now() / 1000) + PDF_REQUEST_TOKEN_TTL_SECONDS

  const r = await c.env.DB.prepare(
    `INSERT INTO pdf_requests (email, book_slug, child_name, child_age, cover_type, user_id, order_item_id, status, access_token_hash, access_token_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'unavailable', ?, ?)`
  )
    .bind(email, bookSlug, childName, childAge, coverType, user?.id ?? null, orderItemId, tokenHash, expiresAt)
    .run()

  return c.json({
    success: true,
    id: Number(r.meta.last_row_id),
    // T-03: the request is recorded, but no PDF worker exists — the status is
    // explicitly 'unavailable' and the response promises nothing.
    status: 'unavailable',
    token: rawToken,
    message: 'Request recorded, but PDF copies are not available in this version. Nothing will be emailed and no digital copy exists to send yet.'
  })
}
// Never a bare sequential id: the caller must be the admin, the
// authenticated owner (user_id match), or present the capability token
// returned at creation. Anyone else gets 404 (not 403 — existence isn't
// confirmed either, same reasoning as guest order access). The response
// never includes email or other PII.
async function handlePdfRequestStatus(c: Context<{ Bindings: Bindings; Variables: Vars }>) {
  const id = Number(c.req.param('id'))
  const token = c.req.query('token') || ''
  const user = c.get('user')

  const row = await c.env.DB.prepare(
    'SELECT id, status, book_slug, cover_type, user_id, access_token_hash, access_token_expires_at, created_at, updated_at FROM pdf_requests WHERE id = ?'
  ).bind(id).first<{
    id: number
    status: string
    book_slug: string
    cover_type: string
    user_id: number | null
    access_token_hash: string | null
    access_token_expires_at: number | null
    created_at: string
    updated_at: string
  }>()
  if (!row) return c.json({ error: 'Not found' }, 404)

  let authorized = user?.role === 'admin' || (!!user && row.user_id === user.id)
  if (!authorized && token && row.access_token_hash) {
    // A NULL expiry (rows created before migration 0007) is treated as
    // already-expired, never as "valid forever" — see that migration's
    // comment. An expired-but-otherwise-correct token gets the same 404 as
    // a wrong one: existence isn't confirmed either way.
    const notExpired = typeof row.access_token_expires_at === 'number' && row.access_token_expires_at >= Math.floor(Date.now() / 1000)
    if (notExpired) authorized = timingSafeEqual(await sha256Hex(token), row.access_token_hash)
  }
  if (!authorized) return c.json({ error: 'Not found' }, 404)

  // Minimal fields only — no email, no child_name, no raw token material.
  return c.json({ id: row.id, status: row.status, book_slug: row.book_slug, cover_type: row.cover_type, created_at: row.created_at, updated_at: row.updated_at })
}
// Separate, admin-only endpoint (distinct from handlePdfRequestStatus's
// owner/guest-token path above): an operator looking up ANY pdf_request by
// id, not scoped to their own orders, and never accepting a guest
// capability token as a substitute for an admin session. requireAdmin()
// returns 401/403 JSON (the codebase's existing convention for admin API
// routes — see src/auth.ts) rather than the 404-for-everyone-unauthorized
// pattern used for guest/customer access, since this route is inherently
// admin tooling, not something a stranger could stumble into.
async function handleAdminPdfRequestStatus(c: Context<{ Bindings: Bindings; Variables: Vars }>) {
  const guard = requireAdmin(c)
  if (guard instanceof Response) return guard
  const id = Number(c.req.param('id'))
  const row = await c.env.DB.prepare(
    'SELECT id, status, book_slug, cover_type, user_id, order_item_id, email, child_name, created_at, updated_at FROM pdf_requests WHERE id = ?'
  ).bind(id).first<Record<string, unknown>>()
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(row)
}

app.post('/api/v1/books/pdf-requests', handleCreatePdfRequest)
app.post('/api/books/pdf-request', handleCreatePdfRequest)
app.get('/api/v1/books/pdf-requests/:id', handlePdfRequestStatus)
app.get('/api/v1/admin/pdf-requests/:id', handleAdminPdfRequestStatus)

// AI Book Generator Route (Client calls this to generate/preview books)
// Confirmed review finding: this used to fabricate a full "generated" book
// (cover, story spread text, pricing) unconditionally — real-looking output
// with no real AI call behind it, for every request, regardless of any
// admin configuration. No frontend code calls this route (checked — the
// reader page's static preview art is unrelated). Real generation is a
// Phase 3 item; until a real provider adapter exists, this must say so
// honestly instead of returning fake success.
app.post('/api/generate-book', async (c) => {
  return c.json(
    {
      success: false,
      notImplemented: true,
      message: 'AI book generation is not implemented in this phase (see Phase 3 in STORYBOOKCLONE_COMPLETION_CODING_PACK.md). No image, story, or preview is generated by this endpoint.'
    },
    501
  )
})

// ---- inbox ----
app.get('/admin/messages', async (c) => {
  const rows = (await c.env.DB.prepare('SELECT * FROM contacts ORDER BY resolved, id DESC LIMIT 200').all()).results || []
  return c.html(adminMessages(rows, c.req.query('saved') ? 'Saved.' : undefined, adminPerms(c)))
})

app.post('/admin/messages/:id/toggle', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('UPDATE contacts SET resolved = 1 - resolved WHERE id = ?').bind(id).run()
  await auditAdmin(c, 'contact.toggle_resolved', 'contact', id, null, {})
  return c.redirect('/admin/messages?saved=1')
})

function adminPage404() {
  return adminLogin('That admin page does not exist.')
}

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `product-${Date.now()}`
  )
}

// Confirmed baseline defect: this previously rendered the not-found page
// with c.html() and no status, defaulting to 200 OK — every truly missing
// route (and, worse, every access-denied /photos/:key response relying on
// c.notFound()) was reporting success.
app.notFound((c) => htmlNotFound(c))

export default app
