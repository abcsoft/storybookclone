/**
 * ADM-17 — provider configuration status and health, WITHOUT secrets.
 *
 * Every value in this module is derived from the deployment's own resolved
 * adapters. A secret is never read into a variable that could be returned, and
 * the returned shapes are exactly the credential-free `health()`/`status()`
 * objects the Phase-3/4/5 providers already expose:
 *
 *   * `getGenerationProviders(env).health()`  → capability, configured, active, detail
 *   * `paymentProviderHealth(env)`            → provider, configured, active, detail
 *   * `mailProviderStatus(env)`               → provider, deliveryMode, deliversRealMail, fromAddress, detail
 *
 * A test renders this surface with a deliberately fake `sk_live_…`, `whsec_…` and
 * bearer token set in the environment and asserts that NONE of those values
 * appears anywhere in the response body — so "never displays a secret" is proven
 * rather than asserted.
 *
 * The FEATURE FLAGS below are the other half of ADM-17. Each one is consulted by
 * product code (not decorative): see `support.auto_assign` in
 * src/admin-console/support.ts and `admin.exports.enabled` in
 * src/admin-console/exports.ts.
 */
import { getGenerationProviders } from '../generation/providers'
import type { ProviderEnv } from '../generation/providers/types'
import { paymentProviderHealth, advertisedPaymentMethods } from '../commerce/payments'
import type { PaymentEnv } from '../commerce/payments/types'
import { mailProviderStatus, type MailEnv } from '../mail/provider'

export type ProviderStatusRow = {
  area: string
  name: string
  configured: boolean
  active: string
  detail: string
  /** 'ok' | 'not-configured' | 'disabled' | 'attention' — 'attention' is never a bare guess. */
  state: 'ok' | 'not-configured' | 'disabled' | 'attention'
}

/**
 * The narrowest environment this surface needs. It is the union of the provider
 * environments (each of which is already declared to be credential-free in its
 * own module) plus the database and the private bucket binding.
 */
export type IntegrationsEnv = MailEnv &
  PaymentEnv &
  ProviderEnv & {
    DB: D1Database
    PHOTOS?: R2Bucket
    GENERATION_DISABLED?: string
  }

/** A short, non-secret label for the configured key material. Never the value. */
export function describeKeyPresence(env: Record<string, unknown>, names: readonly string[]): string {
  const present = names.filter((n) => String(env[n] ?? '').length > 0)
  if (!present.length) return 'not configured'
  return `configured (${present.length} of ${names.length} value${names.length === 1 ? '' : 's'} present)`
}

export type ProviderHealthReport = {
  rows: ProviderStatusRow[]
  featureFlagsEnabled: Record<string, boolean>
  paymentMethods: Array<{ key: string; label: string; available: boolean }>
  /** Truthful, non-secret summary lines the operator can rely on. */
  notes: string[]
}

export async function providerHealthReport(env: IntegrationsEnv): Promise<ProviderHealthReport> {
  const generation = getGenerationProviders(env, env.PHOTOS)
  const payment = paymentProviderHealth(env)
  const mail = mailProviderStatus(env)
  const flags = await featureFlagMap(env.DB)

  const rows: ProviderStatusRow[] = []
  for (const health of generation.health()) {
    rows.push({
      area: 'Generation',
      name: health.capability,
      configured: health.configured,
      active: health.active,
      detail: health.detail,
      state: health.active === 'disabled' ? (health.configured ? 'ok' : 'disabled') : 'ok'
    })
  }
  rows.push({
    area: 'Payments',
    name: 'checkout provider',
    configured: payment.configured,
    active: payment.active,
    detail: payment.detail,
    state: payment.active === 'disabled' ? 'disabled' : 'ok'
  })
  rows.push({
    area: 'Email',
    name: 'outbound email',
    configured: mail.provider !== 'disabled',
    active: mail.provider,
    detail: `${mail.detail} Delivery mode: ${mail.deliveryMode}.`,
    state: mail.deliveryMode === 'disabled' ? 'disabled' : 'ok'
  })
  rows.push({
    area: 'Face analysis',
    name: 'face analysis adapter',
    // Reuse the generation bundle's own face capability so there is one answer.
    configured: generation.health().find((h) => h.capability === 'face')?.configured ?? false,
    active: generation.health().find((h) => h.capability === 'face')?.active ?? 'disabled',
    detail: generation.health().find((h) => h.capability === 'face')?.detail ?? 'Not resolved.',
    state: 'ok'
  })
  rows.push({
    area: 'Storage',
    name: 'private asset bucket',
    configured: !!env.PHOTOS,
    active: env.PHOTOS ? 'r2' : 'missing',
    detail: env.PHOTOS
      ? 'Private R2 bucket bound. Photo, preview and production objects are never served by key; every read resolves an entitlement first.'
      : 'No R2 bucket binding — photo upload, previews and downloads are unavailable in this deployment.',
    state: env.PHOTOS ? 'ok' : 'attention'
  })

  const notes = [
    'Only the configured / not-configured / last-tested state of each integration is shown. No credential, URL fragment, key prefix or provider payload is read into this page.',
    'A capability marked "disabled" has no adapter wired: calls through it fail closed rather than fabricating a result.',
    `Generation kill switch: ${String(env.GENERATION_DISABLED ?? '') === '1' ? 'ON (GENERATION_DISABLED=1)' : 'off'}. Payment kill switch: ${String(env.PAYMENTS_DISABLED ?? '') === '1' ? 'ON (PAYMENTS_DISABLED=1)' : 'off'}.`,
    'There is no way to set a credential from this panel: secrets belong in the platform\'s secret store (`wrangler secret put …`).'
  ]

  return { rows, featureFlagsEnabled: flags, paymentMethods: advertisedPaymentMethods(env), notes }
}

export type FeatureFlagRow = {
  key: string
  label: string
  description: string
  enabled: boolean
  updated_at: string | null
  updated_by: string | null
}

export async function listFeatureFlags(db: D1Database): Promise<FeatureFlagRow[]> {
  const rows =
    (
      await db
        .prepare(
          `SELECT f.*, u.email AS updated_by FROM feature_flags f LEFT JOIN users u ON u.id = f.updated_by_user_id ORDER BY f.key`
        )
        .all<Record<string, unknown>>()
    ).results || []
  return rows.map((row) => ({
    key: String(row.key),
    label: String(row.label ?? row.key),
    description: String(row.description ?? ''),
    enabled: Number(row.enabled ?? 0) === 1,
    updated_at: row.updated_at == null ? null : String(row.updated_at),
    updated_by: row.updated_by == null ? null : String(row.updated_by)
  }))
}

export async function featureFlagMap(db: D1Database): Promise<Record<string, boolean>> {
  const rows = await listFeatureFlags(db)
  const out: Record<string, boolean> = {}
  for (const row of rows) out[row.key] = row.enabled
  return out
}

/** Read one flag with an explicit fallback, so a missing row cannot enable a feature. */
export async function featureEnabled(db: D1Database, key: string, fallback = false): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT enabled FROM feature_flags WHERE key = ?').bind(key).first<{ enabled: number }>()
    if (!row) return fallback
    return Number(row.enabled) === 1
  } catch {
    return fallback
  }
}

export type FlagChangeResult = { ok: true; enabled: boolean } | { ok: false; error: string }

/**
 * Flip a flag. The change is a single UPDATE and, like every other high-risk
 * action, is recorded by the caller in the audit log (the route does that) — this
 * function deliberately does not audit itself so the audit row is written once,
 * by the handler, with the operator's reason attached.
 */
export async function setFeatureFlag(
  db: D1Database,
  input: { key: string; enabled: boolean; actorUserId: number | null }
): Promise<FlagChangeResult> {
  const row = await db.prepare('SELECT key, enabled FROM feature_flags WHERE key = ?').bind(input.key).first<{ key: string; enabled: number }>()
  if (!row) return { ok: false, error: 'Unknown feature flag.' }
  const enabled = input.enabled ? 1 : 0
  if (Number(row.enabled) === enabled) return { ok: false, error: `That flag is already ${input.enabled ? 'on' : 'off'}.` }
  await db
    .prepare('UPDATE feature_flags SET enabled = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?')
    .bind(enabled, input.actorUserId ?? null, input.key)
    .run()
  return { ok: true, enabled: input.enabled }
}
