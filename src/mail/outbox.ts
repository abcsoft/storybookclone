// PLT-05 — the durable email outbox.
//
// THE CONTRACT, in three parts:
//
//  1. `dedupe_key` is UNIQUE and is the ONLY authority on "this is one logical
//     mail". Enqueueing the same logical mail twice (a double-clicked button, a
//     retried request, a replayed webhook) inserts ONE row: the second attempt
//     conflicts and is reported as `deduped: true`.
//  2. RETRYING THAT ROW NEVER SENDS A SECOND MESSAGE. A retry increments
//     `attempt_count`, appends one `email_attempts` row (UNIQUE(outbox_id,
//     attempt_no) is the database-level authority) and updates the SAME outbox
//     row. It never inserts a new one, so there is no path in this module by
//     which a retry can duplicate a logical mail.
//  3. Delivery is SKIPPED AND RECORDED as `suppressed` when no provider is
//     configured, instead of pretending to have sent anything.
//
// A caller that has just committed a business action (an account was created,
// an address changed) must never fail because of mail. `enqueueEmail` therefore
// only fails if the TEMPLATE is missing — a code/deployment defect that must be
// loud — and delivery failures are recorded as attempts, never thrown at the
// caller of a completed action.
import { DomainError } from '../generation/types'
import type { EmailAdapter } from '../email'
import { resolveMailProvider, type MailEnv, type MailProviderStatus } from './provider'
import { renderEmailTemplate } from './templates'

export type OutboxRow = {
  id: number
  public_id: string
  dedupe_key: string
  template_key: string
  template_version: number | null
  to_email: string
  user_id: number | null
  subject: string
  body_text: string
  body_html: string | null
  variables_json: string
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'suppressed'
  attempt_count: number
  max_attempts: number
  available_at: number
  lease_owner: string | null
  lease_expires_at: number | null
  provider: string | null
  provider_message_id: string | null
  suppressed_reason: string | null
  last_error_code: string | null
  last_error_message: string | null
  correlation_id: string
  created_at: string
  updated_at: string
  sent_at: string | null
}

export type EnqueueEmailInput = {
  /** Stable identity of the logical mail. Two calls with the same key are ONE message. */
  dedupeKey: string
  templateKey: string
  to: string
  variables: Record<string, string>
  locale?: string
  userId?: number | null
  correlationId?: string
  maxAttempts?: number
}

export type EnqueueResult = { id: number; publicId: string; deduped: boolean; templateVersion: number | null }

export const DEFAULT_MAX_ATTEMPTS = 5

function nowSeconds(explicit?: number): number {
  return explicit ?? Math.floor(Date.now() / 1000)
}

function newPublicId(): string {
  return `em_${crypto.randomUUID().replace(/-/g, '')}`
}

function isEmailShaped(value: string): boolean {
  // Deliberately permissive: this guards against a missing/blank recipient, not
  // against RFC-5322 exotica (a stricter regex rejects real addresses).
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

/**
 * Records the DECISION to send one logical email, and returns the existing row
 * when that decision has already been made. Renders the template at enqueue
 * time so the exact wording that was queued is frozen on the row (and therefore
 * inspectable later, even after a newer template version is published).
 */
export async function enqueueEmail(db: D1Database, env: MailEnv, input: EnqueueEmailInput): Promise<EnqueueResult> {
  const to = String(input.to || '').trim().toLowerCase()
  if (!isEmailShaped(to)) {
    throw new DomainError('invalid_recipient', 'A valid email address is required.', 400)
  }
  const dedupeKey = String(input.dedupeKey || '').trim()
  if (!dedupeKey) throw new DomainError('dedupe_key_required', 'An email dedupe key is required.', 500)

  const rendered = await renderEmailTemplate(db, input.templateKey, input.variables, input.locale || 'en')

  const result = await db
    .prepare(
      `INSERT INTO email_outbox (public_id, dedupe_key, template_key, template_version, to_email, user_id, subject, body_text, body_html, variables_json, max_attempts, available_at, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO NOTHING`
    )
    .bind(
      newPublicId(),
      dedupeKey,
      rendered.key,
      rendered.version,
      to,
      input.userId ?? null,
      rendered.subject,
      rendered.bodyText,
      rendered.bodyHtml,
      JSON.stringify(input.variables),
      Math.max(1, Number(input.maxAttempts) || DEFAULT_MAX_ATTEMPTS),
      nowSeconds(),
      String(input.correlationId || '')
    )
    .run()

  const inserted = Number(result.meta?.changes ?? 0) > 0
  const row = await db.prepare('SELECT id, public_id, template_version FROM email_outbox WHERE dedupe_key = ?').bind(dedupeKey).first<{ id: number; public_id: string; template_version: number | null }>()
  if (!row) throw new DomainError('internal', 'The email could not be queued.', 500)
  return { id: row.id, publicId: row.public_id, deduped: !inserted, templateVersion: row.template_version }
}

/** Exponential backoff, capped. Deterministic: no jitter, so tests can assert the schedule. */
export function retryDelaySeconds(attemptNumber: number): number {
  return Math.min(3600, 60 * Math.pow(2, Math.max(0, attemptNumber - 1)))
}

export type DeliveryOutcome = {
  outcome: 'sent' | 'failed' | 'suppressed'
  attemptNo: number
  provider: string
  providerMessageId: string | null
  errorCode: string | null
  errorMessage: string | null
  status: OutboxRow['status']
  retryAt: number | null
}

/**
 * Performs ONE delivery attempt for an already-queued row and records it.
 *
 * `attemptNo` is the row's own `attempt_count + 1`, so two workers that both
 * reach the attempt insert for the same row collide on
 * UNIQUE(outbox_id, attempt_no) — the loser's insert fails and it records
 * nothing, rather than delivering (and recording) a duplicate.
 */
export async function deliverOutboxRow(
  db: D1Database,
  env: MailEnv,
  row: OutboxRow,
  deps: { adapter?: EmailAdapter; now?: number; status?: MailProviderStatus } = {}
): Promise<DeliveryOutcome> {
  const resolved = deps.adapter ? null : resolveMailProvider(env)
  const adapter = deps.adapter ?? resolved!.adapter
  const status = deps.status ?? resolved!.status
  const attemptNo = Number(row.attempt_count) + 1
  const now = nowSeconds(deps.now)

  // No configured provider: record the truth and stop. Retrying forever against
  // an adapter that cannot deliver would be noise, not resilience.
  if (status.deliveryMode === 'disabled') {
    await recordAttempt(db, row, attemptNo, { outcome: 'suppressed', provider: status.provider, errorCode: 'no_provider_configured', errorMessage: status.detail })
    await db
      .prepare("UPDATE email_outbox SET status = 'suppressed', suppressed_reason = ?, provider = ?, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind('no_provider_configured', status.provider, row.id)
      .run()
    return { outcome: 'suppressed', attemptNo, provider: status.provider, providerMessageId: null, errorCode: 'no_provider_configured', errorMessage: status.detail, status: 'suppressed', retryAt: null }
  }

  const startedAt = Date.now()
  try {
    const sent = await adapter.send({
      to: row.to_email,
      subject: row.subject,
      text: row.body_text,
      ...(row.body_html ? { html: row.body_html } : {}),
      idempotencyKey: row.dedupe_key
    })
    const providerMessageId = (sent as { providerMessageId?: string | null } | undefined)?.providerMessageId ?? null
    await recordAttempt(db, row, attemptNo, { outcome: 'sent', provider: status.provider, providerMessageId, latencyMs: Date.now() - startedAt })
    await db
      .prepare("UPDATE email_outbox SET status = 'sent', provider = ?, provider_message_id = ?, attempt_count = attempt_count + 1, sent_at = CURRENT_TIMESTAMP, lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(status.provider, providerMessageId, row.id)
      .run()
    return { outcome: 'sent', attemptNo, provider: status.provider, providerMessageId, errorCode: null, errorMessage: null, status: 'sent', retryAt: null }
  } catch (err) {
    const errorCode = (err as { code?: string })?.code || 'send_failed'
    const errorMessage = err instanceof Error ? err.message.slice(0, 500) : 'Email delivery failed.'
    await recordAttempt(db, row, attemptNo, { outcome: 'failed', provider: status.provider, errorCode, errorMessage, latencyMs: Date.now() - startedAt })
    const exhausted = attemptNo >= Number(row.max_attempts)
    const retryAt = exhausted ? null : now + retryDelaySeconds(attemptNo)
    await db
      .prepare("UPDATE email_outbox SET status = ?, provider = ?, attempt_count = attempt_count + 1, available_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?, last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(exhausted ? 'failed' : 'queued', status.provider, retryAt ?? 0, errorCode, errorMessage, row.id)
      .run()
    return { outcome: 'failed', attemptNo, provider: status.provider, providerMessageId: null, errorCode, errorMessage, status: exhausted ? 'failed' : 'queued', retryAt }
  }
}

async function recordAttempt(
  db: D1Database,
  row: OutboxRow,
  attemptNo: number,
  attempt: { outcome: 'sent' | 'failed' | 'suppressed'; provider: string; providerMessageId?: string | null; errorCode?: string | null; errorMessage?: string | null; latencyMs?: number }
): Promise<void> {
  try {
    await db
      .prepare('INSERT INTO email_attempts (outbox_id, attempt_no, outcome, provider, provider_message_id, error_code, error_message, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(row.id, attemptNo, attempt.outcome, attempt.provider, attempt.providerMessageId ?? null, attempt.errorCode ?? null, attempt.errorMessage ?? null, attempt.latencyMs ?? null)
      .run()
  } catch {
    // UNIQUE(outbox_id, attempt_no): another worker already recorded this exact
    // attempt. The attempt happened once; recording it once is correct.
  }
}

export type DrainResult = { claimed: number; sent: number; failed: number; suppressed: number; scanned: number }

/**
 * The retry sweep (also the inline drain used by tests and by an explicitly
 * configured development environment). Claims due rows with a compare-and-swap
 * on `status`, so concurrent sweeps cannot both deliver the same row.
 */
export async function drainEmailOutbox(
  db: D1Database,
  env: MailEnv,
  opts: { limit?: number; now?: number; workerId?: string; leaseSeconds?: number } = {}
): Promise<DrainResult> {
  const now = nowSeconds(opts.now)
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 25))
  const workerId = opts.workerId || `drain-${crypto.randomUUID().slice(0, 8)}`
  const leaseSeconds = Math.max(30, Number(opts.leaseSeconds) || 120)
  const result: DrainResult = { claimed: 0, sent: 0, failed: 0, suppressed: 0, scanned: 0 }

  // Reclaim a lease that a crashed worker left behind. Bounded, and only ever
  // applies to a row still in 'sending' whose lease has genuinely expired.
  await db
    .prepare("UPDATE email_outbox SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?")
    .bind(now)
    .run()

  const due = await db
    .prepare("SELECT * FROM email_outbox WHERE status = 'queued' AND available_at <= ? ORDER BY id LIMIT ?")
    .bind(now, limit)
    .all<OutboxRow>()
  const rows = due.results || []
  result.scanned = rows.length

  const resolved = resolveMailProvider(env)
  for (const row of rows) {
    const claim = await db
      .prepare("UPDATE email_outbox SET status = 'sending', lease_owner = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued' AND available_at <= ?")
      .bind(workerId, now + leaseSeconds, row.id, now)
      .run()
    if (Number(claim.meta?.changes ?? 0) === 0) continue // another sweep won
    result.claimed += 1
    const outcome = await deliverOutboxRow(db, env, row, { now, adapter: resolved.adapter, status: resolved.status })
    if (outcome.outcome === 'sent') result.sent += 1
    else if (outcome.outcome === 'suppressed') result.suppressed += 1
    else result.failed += 1
  }
  return result
}

export type SendNowResult = {
  queued: EnqueueResult
  delivery: DeliveryOutcome | null
  /** The outbox status a caller may truthfully report. */
  status: OutboxRow['status']
}

/**
 * Enqueue + one immediate attempt, for the interactive paths (register, verify,
 * change email, claim) where the answer to the user must be truthful NOW.
 * `delivery.mode` comes back in `status`, so a caller can say "recorded, but
 * this deployment cannot deliver email" rather than "we've emailed you".
 */
export async function sendEmailNow(db: D1Database, env: MailEnv, input: EnqueueEmailInput): Promise<SendNowResult> {
  const queued = await enqueueEmail(db, env, input)
  const row = await db.prepare('SELECT * FROM email_outbox WHERE id = ?').bind(queued.id).first<OutboxRow>()
  if (!row) return { queued, delivery: null, status: 'queued' }
  if (row.status !== 'queued') return { queued, delivery: null, status: row.status }

  const resolved = resolveMailProvider(env)
  if (resolved.status.deliveryMode === 'disabled') {
    const delivery = await deliverOutboxRow(db, env, row, { adapter: resolved.adapter, status: resolved.status })
    return { queued, delivery, status: delivery.status }
  }
  // Mark as sending so the durable sweep cannot pick the same row up while this
  // inline attempt is in flight.
  const claim = await db
    .prepare("UPDATE email_outbox SET status = 'sending', lease_owner = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'")
    .bind('inline', nowSeconds() + 120, row.id)
    .run()
  if (Number(claim.meta?.changes ?? 0) === 0) return { queued, delivery: null, status: 'queued' }
  const delivery = await deliverOutboxRow(db, env, row, { adapter: resolved.adapter, status: resolved.status })
  return { queued, delivery, status: delivery.status }
}

/** The outbox state of a logical mail, for a truthful UI. Never includes a body or a token. */
export async function outboxStatusFor(db: D1Database, dedupeKey: string): Promise<OutboxRow | null> {
  return db.prepare('SELECT * FROM email_outbox WHERE dedupe_key = ?').bind(dedupeKey).first<OutboxRow>()
}

/** Counts by status — the operational view (Phase 8 owns alerting). */
export async function outboxCounts(db: D1Database): Promise<Record<string, number>> {
  const rows = await db.prepare('SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status').all<{ status: string; n: number }>()
  const counts: Record<string, number> = { queued: 0, sending: 0, sent: 0, failed: 0, suppressed: 0 }
  for (const row of rows.results || []) counts[row.status] = Number(row.n)
  return counts
}
