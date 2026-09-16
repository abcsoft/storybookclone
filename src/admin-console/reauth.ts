/**
 * ADM-20 — re-authentication for high-risk actions.
 *
 * V2 §10 requires a FRESH credential confirmation for refunds, role and
 * permission changes, privacy deletion decisions, template publishing, feature
 * flags and data exports. A long-lived admin session is not enough: a stolen
 * session cookie must not be able to move money or grant itself more access.
 *
 * Mechanism (one challenge, one confirmation, one action):
 *
 *   1. Rendering a high-risk form calls `issueReauthChallenge()`. The opaque id
 *      goes into a hidden field. The row is bound to the ACTOR, their SESSION (so
 *      it cannot be lifted into another browser) and the exact ACTION — the route
 *      pattern, e.g. `POST /admin/orders/:id/refunds`.
 *   2. Submitting it calls `consumeReauthChallenge()` with the operator's
 *      current password. The row is single-use — the UPDATE is conditional on
 *      `consumed_at IS NULL` and `changes() = 1` decides the winner, so two
 *      concurrent submissions cannot both succeed.
 *
 * The concrete entity the operator was looking at is RECORDED on the challenge
 * (`entity_ref`) and on every outcome event, but it is deliberately not part of
 * the binding: a confirmation is "this operator, in this session, may perform
 * this action, having just proved their password" — the row it acts on is still
 * checked by the action's own service (ownership, current state, amount caps).
 * An attacker who could swap the id would still need the password, and the audit
 * trail names the exact path that was attempted.
 *
 * Every outcome is appended to `admin_reauth_events` (immutable): succeeded,
 * failed_password, expired, replayed, wrong_action, too_many_attempts. Nothing in
 * this module ever stores or logs the password itself.
 */
import { verifyPassword } from '../auth'

export const REAUTH_TTL_SECONDS = 10 * 60
export const REAUTH_MAX_ATTEMPTS = 5
/** The hidden field a high-risk form carries. */
export const REAUTH_CHALLENGE_FIELD = 'reauth_challenge'
/** The field the operator types their current password into. */
export const REAUTH_PASSWORD_FIELD = 'current_password'

export type ReauthOutcome =
  | 'succeeded'
  | 'failed_password'
  | 'expired'
  | 'replayed'
  | 'wrong_binding'
  | 'too_many_attempts'
  | 'missing'

export type ReauthConsumeResult = { ok: true; challengePublicId: string } | { ok: false; outcome: ReauthOutcome; message: string }

function newChallengeId(): string {
  return `ra_${crypto.randomUUID().replace(/-/g, '')}`
}

/**
 * Bind a challenge to (actor, session, action, entity). Returned id is opaque
 * and carries no secret: the password is checked on submission, never here.
 */
export async function issueReauthChallenge(
  db: D1Database,
  input: { userId: number; sessionPublicId: string | null; action: string; entityRef: string; now?: number }
): Promise<string> {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const publicId = newChallengeId()
  // Opportunistic hygiene: drop this actor's expired, unconsumed challenges so
  // the table cannot grow without bound. Scoped to one user, so it is cheap.
  await db
    .prepare('DELETE FROM admin_reauth_challenges WHERE user_id = ? AND consumed_at IS NULL AND expires_at <= ?')
    .bind(input.userId, now)
    .run()
  await db
    .prepare(
      `INSERT INTO admin_reauth_challenges (public_id, user_id, session_public_id, action, entity_ref, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(publicId, input.userId, input.sessionPublicId ?? '', input.action, input.entityRef, now + REAUTH_TTL_SECONDS)
    .run()
  return publicId
}

async function recordOutcome(
  db: D1Database,
  input: { challengePublicId: string; userId: number | null; action: string; entityRef: string; outcome: ReauthOutcome }
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO admin_reauth_events (challenge_public_id, user_id, action, entity_ref, outcome)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(input.challengePublicId, input.userId, input.action, input.entityRef, input.outcome)
      .run()
  } catch (err) {
    // Never let an audit-write failure turn into an authorization bypass: the
    // caller still refuses. Logged, not swallowed silently.
    console.error('[reauth] failed to record outcome:', err instanceof Error ? err.message : err)
  }
}

type ChallengeRow = {
  id: number
  public_id: string
  user_id: number
  session_public_id: string
  action: string
  entity_ref: string
  attempts: number
  expires_at: number
  consumed_at: string | null
}

/**
 * Verify and consume a challenge. Returns `{ok:true}` exactly once per issued
 * challenge, and only for the actor/session/action/entity it was issued to.
 */
export async function consumeReauthChallenge(
  db: D1Database,
  input: {
    publicId: string | null | undefined
    userId: number
    sessionPublicId: string | null
    action: string
    entityRef: string
    password: string
    passwordHash: string | null
    now?: number
  }
): Promise<ReauthConsumeResult> {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const publicId = String(input.publicId ?? '').trim()
  if (!publicId) return { ok: false, outcome: 'missing', message: 'This action needs a fresh password confirmation. Reload the page and try again.' }
  const row = await db.prepare('SELECT * FROM admin_reauth_challenges WHERE public_id = ?').bind(publicId).first<ChallengeRow>()
  if (!row) return { ok: false, outcome: 'missing', message: 'That confirmation link is not valid. Reload the page and try again.' }

  // The action is the route pattern, never a caller-supplied string: a challenge
  // minted for a refund cannot be spent on a role change.
  if (row.action !== input.action) {
    await recordOutcome(db, { challengePublicId: publicId, userId: input.userId, action: input.action, entityRef: input.entityRef, outcome: 'wrong_binding' })
    return { ok: false, outcome: 'wrong_binding', message: 'That confirmation was issued for a different action.' }
  }
  if (Number(row.user_id) !== input.userId) {
    await recordOutcome(db, { challengePublicId: publicId, userId: input.userId, action: input.action, entityRef: input.entityRef, outcome: 'wrong_binding' })
    return { ok: false, outcome: 'wrong_binding', message: 'That confirmation was issued to another account.' }
  }
  if (row.session_public_id && input.sessionPublicId && row.session_public_id !== input.sessionPublicId) {
    await recordOutcome(db, { challengePublicId: publicId, userId: input.userId, action: input.action, entityRef: input.entityRef, outcome: 'wrong_binding' })
    return { ok: false, outcome: 'wrong_binding', message: 'That confirmation belongs to another session. Reload the page and try again.' }
  }
  if (row.consumed_at) {
    await recordOutcome(db, { challengePublicId: publicId, userId: input.userId, action: input.action, entityRef: input.entityRef, outcome: 'replayed' })
    return { ok: false, outcome: 'replayed', message: 'That confirmation was already used. Reload the page and try again.' }
  }
  if (Number(row.expires_at) <= now) {
    await recordOutcome(db, { challengePublicId: publicId, userId: input.userId, action: input.action, entityRef: input.entityRef, outcome: 'expired' })
    return { ok: false, outcome: 'expired', message: 'That confirmation expired. Reload the page and try again.' }
  }
  if (Number(row.attempts) >= REAUTH_MAX_ATTEMPTS) {
    await db.prepare('UPDATE admin_reauth_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND consumed_at IS NULL').bind(row.id).run()
    await recordOutcome(db, { challengePublicId: publicId, userId: input.userId, action: input.action, entityRef: input.entityRef, outcome: 'too_many_attempts' })
    return { ok: false, outcome: 'too_many_attempts', message: 'Too many incorrect passwords. Reload the page and try again.' }
  }

  const password = String(input.password ?? '')
  const correct = !!input.passwordHash && password.length > 0 && (await verifyPassword(password, input.passwordHash))
  if (!correct) {
    await db.prepare('UPDATE admin_reauth_challenges SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run()
    await recordOutcome(db, { challengePublicId: publicId, userId: input.userId, action: input.action, entityRef: input.entityRef, outcome: 'failed_password' })
    return { ok: false, outcome: 'failed_password', message: 'That password is not correct. The action was not performed.' }
  }

  // Single-use, race-safe: only the request that flips consumed_at may proceed.
  const used = await db
    .prepare('UPDATE admin_reauth_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND consumed_at IS NULL')
    .bind(row.id)
    .run()
  if (Number(used.meta?.changes ?? 0) !== 1) {
    await recordOutcome(db, { challengePublicId: publicId, userId: input.userId, action: input.action, entityRef: input.entityRef, outcome: 'replayed' })
    return { ok: false, outcome: 'replayed', message: 'That confirmation was already used. Reload the page and try again.' }
  }
  await recordOutcome(db, { challengePublicId: publicId, userId: input.userId, action: input.action, entityRef: input.entityRef, outcome: 'succeeded' })
  return { ok: true, challengePublicId: publicId }
}

/** Recent re-auth attempts for the audit screen (never the password). */
export async function recentReauthEvents(db: D1Database, limit = 50): Promise<Array<Record<string, unknown>>> {
  const rows =
    (
      await db
        .prepare(
          `SELECT e.*, u.email AS actor_email FROM admin_reauth_events e
             LEFT JOIN users u ON u.id = e.user_id
            ORDER BY e.id DESC LIMIT ?`
        )
        .bind(Math.max(1, Math.min(500, limit)))
        .all<Record<string, unknown>>()
    ).results || []
  return rows
}
