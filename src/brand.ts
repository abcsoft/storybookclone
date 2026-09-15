// The ONE brand/identity boundary (V2 Phase 1 correction, L-D).
//
// Every user-visible identity string — site name, logo, tagline, meta
// description, contact address, social handles, legal entity and the
// copyright line — is resolved HERE and nowhere else. Templates import
// `brand()` instead of hard-coding a name, which is what let the previous
// owner's brand ("WonderWraps") leak into page titles, meta descriptions,
// FAQs, blog copy, admin chrome and password-reset emails.
//
// The owner has not yet configured the final brand, so the neutral default is
// `Storybook Studio` — deliberately generic and NOT a claim about any real
// company. An operator overrides it per deployment with the `BRAND_*`
// environment values below (the same boundary a CMS would write to later);
// no template needs to change when they do.
//
// LEGACY INTERNAL IDENTIFIERS (kept for compatibility — do NOT rename):
//   * the `wonderwraps_cart` localStorage key is still read and cleared by
//     `public/static/cart.js`'s migration path, so an existing visitor's cart
//     is not silently lost. It is an internal storage key, never rendered;
//   * the `app_secrets` / D1 database naming and the migration history are
//     deployment identifiers, not branding.
// Renaming either would break existing installs/clients for no user-visible
// benefit, so they stay and are documented here instead.

export type BrandSocial = {
  instagram?: string
  facebook?: string
  tiktok?: string
  youtube?: string
  x?: string
}

export type BrandConfig = {
  /** Public site name — the storefront wordmark, page titles and email subjects. */
  name: string
  /** Short marketing tagline. */
  tagline: string
  /** Default `<meta name="description">` for pages that do not set their own. */
  description: string
  /** Legal operating entity, used only on the (draft) legal pages. */
  legalName: string
  /**
   * Public support/contact address. The default is an RFC-2606 reserved
   * `.example` address — obviously a placeholder, and guaranteed not to be
   * somebody else's mailbox — until the owner configures a real one.
   */
  contactEmail: string
  /** Optional public social handles. Empty by default: no handle is invented or rendered. */
  social: BrandSocial
  /** Logo asset path (the brand mark itself is owner-supplied). */
  logoPath: string
  /** Footer copyright year. */
  copyrightYear: number
}

export const DEFAULT_BRAND: BrandConfig = {
  name: 'Storybook Studio',
  tagline: 'Personalised storybooks where your child is the hero',
  description:
    'Create unique kids’ storybooks with Storybook Studio. Upload photos and watch them become part of personalized stories your child will treasure forever.',
  legalName: 'Storybook Studio',
  contactEmail: 'support@storybook-studio.example',
  social: {},
  logoPath: '/static/img/art/logo.svg',
  copyrightYear: 2026
}

export type BrandEnv = {
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
}

function pick(value: string | undefined, fallback: string): string {
  const v = String(value ?? '').trim()
  return v || fallback
}

/** Resolves the deployment's brand from environment configuration, falling back to the neutral default. */
export function resolveBrand(env: BrandEnv | undefined): BrandConfig {
  if (!env) return DEFAULT_BRAND
  const year = Number(env.BRAND_COPYRIGHT_YEAR)
  return {
    name: pick(env.BRAND_NAME, DEFAULT_BRAND.name),
    tagline: pick(env.BRAND_TAGLINE, DEFAULT_BRAND.tagline),
    description: pick(env.BRAND_DESCRIPTION, DEFAULT_BRAND.description),
    legalName: pick(env.BRAND_LEGAL_NAME, pick(env.BRAND_NAME, DEFAULT_BRAND.legalName)),
    contactEmail: pick(env.BRAND_CONTACT_EMAIL, DEFAULT_BRAND.contactEmail),
    social: {
      ...(env.BRAND_INSTAGRAM ? { instagram: env.BRAND_INSTAGRAM } : {}),
      ...(env.BRAND_FACEBOOK ? { facebook: env.BRAND_FACEBOOK } : {}),
      ...(env.BRAND_TIKTOK ? { tiktok: env.BRAND_TIKTOK } : {}),
      ...(env.BRAND_YOUTUBE ? { youtube: env.BRAND_YOUTUBE } : {}),
      ...(env.BRAND_X ? { x: env.BRAND_X } : {})
    },
    logoPath: pick(env.BRAND_LOGO_PATH, DEFAULT_BRAND.logoPath),
    copyrightYear: Number.isFinite(year) && year > 2000 ? Math.floor(year) : DEFAULT_BRAND.copyrightYear
  }
}

// Brand is DEPLOYMENT-wide configuration, not per-request data: every request
// in an isolate resolves the same value from the same environment. The
// app-wide middleware calls `configureBrand(c.env)` once per request purely so
// the pure template helpers can read it without threading `env` through every
// signature — it carries no request-specific state (see C-07, which forbids
// per-REQUEST data in module state; this is the opposite case).
let active: BrandConfig = DEFAULT_BRAND

/**
 * The `site_settings` keys the CMS writes (migration 0021). A setting is only
 * applied when it is NON-BLANK, so clearing a field in admin falls back to the
 * environment value rather than rendering an empty brand string.
 */
export const BRAND_SETTING_KEYS: Record<string, keyof BrandConfig> = {
  'brand.name': 'name',
  'brand.tagline': 'tagline',
  'brand.description': 'description',
  'brand.legal_name': 'legalName',
  'brand.contact_email': 'contactEmail',
  'brand.logo_path': 'logoPath'
}

const SOCIAL_SETTING_KEYS: Record<string, keyof BrandSocial> = {
  'brand.instagram': 'instagram',
  'brand.facebook': 'facebook',
  'brand.tiktok': 'tiktok',
  'brand.youtube': 'youtube',
  'brand.x': 'x'
}

/**
 * Overlays the CMS `site_settings` rows on top of the environment-resolved
 * brand. This is the SECOND (and last) input to the identity boundary: the
 * templates still read `brand()` and nothing else, so an operator renaming the
 * site in admin needs no deploy and no code edit.
 */
export function applyBrandSettings(env: BrandEnv | undefined, settings: Record<string, string> | undefined): BrandConfig {
  const base = resolveBrand(env)
  if (!settings) return base
  const next: BrandConfig = { ...base, social: { ...base.social } }
  for (const [key, field] of Object.entries(BRAND_SETTING_KEYS)) {
    const value = String(settings[key] ?? '').trim()
    if (value) (next as Record<string, unknown>)[field] = value
  }
  for (const [key, field] of Object.entries(SOCIAL_SETTING_KEYS)) {
    const value = String(settings[key] ?? '').trim()
    if (value) next.social[field] = value
  }
  const year = Number(String(settings['brand.copyright_year'] ?? '').trim())
  if (Number.isFinite(year) && year > 2000) next.copyrightYear = Math.floor(year)
  return next
}

/** Applies the deployment's brand configuration. Called once per request by the app middleware. */
export function configureBrand(env: BrandEnv | undefined, settings?: Record<string, string>): BrandConfig {
  active = applyBrandSettings(env, settings)
  return active
}

/** The active brand. Templates and email builders read identity strings from here, never from a literal. */
export function brand(): BrandConfig {
  return active
}

/** Test-only: restores the neutral default so a configured brand cannot leak between tests. */
export function __resetBrandForTests(): void {
  active = DEFAULT_BRAND
}
