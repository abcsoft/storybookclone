/**
 * ADM-19 / ADM-20 — audit writes and event visibility.
 *
 * `auditMutation()` is the ONE way an accepted admin mutation records itself. It
 * is called from the handler AFTER the domain service reports success and BEFORE
 * the response is returned, so:
 *
 *   * a refused action writes nothing (the guard refused before the handler ran,
 *     or the service returned an error and the handler returned early);
 *   * an accepted action writes exactly one event, because the call sits once on
 *     the success path — never in a loop and never in a `finally`.
 *
 * `admin_audit_events` is append-only at the database level (UPDATE and DELETE
 * are blocked by triggers from migration `0015`), and every metadata value passes
 * through `redactAuditMetadata()` so a secret-shaped key can never be persisted.
 *
 * `redactEventPayload()` is the read-side equivalent for ADM-19: the event and
 * webhook screens render provider/domain payloads through it, so a raw provider
 * body, a signature or a storage key is never displayed.
 */
import { redactAuditMetadata, recordAdminAudit } from '../admin-audit'
import { actorOf, type AnyAdminCtx } from './types'

export type AdminMutationAudit = {
  action: string
  entityType: string
  entityId?: string | number | null
  reason?: string | null
  metadata?: Record<string, unknown>
}

/** Where the mutation came from — used to separate UI from API traffic. */
export function requestSource(c: AnyAdminCtx): 'ui' | 'api' {
  const path = new URL(c.req.url).pathname
  return path.startsWith('/api/') ? 'api' : 'ui'
}

/**
 * Append exactly one audit event for an accepted mutation. Returns whether the
 * row landed; a caller may surface a warning but must never treat a failed audit
 * write as a failed action (the action already committed and is reported).
 */
export async function auditMutation(c: AnyAdminCtx, input: AdminMutationAudit): Promise<boolean> {
  const actor = actorOf(c)
  const roles = (c.get('adminRoles') as string[] | undefined) ?? []
  const requestId = (c.get('requestId') as string | null) ?? null
  const ok = await recordAdminAudit(c.env.DB, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    actorRole: roles.join(' ') || null,
    requestId,
    source: requestSource(c),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    reason: input.reason ?? null,
    metadata: input.metadata
  })
  if (!ok) console.warn(`[admin-audit] could not record "${input.action}" for ${input.entityType}:${input.entityId ?? '-'} (request ${requestId ?? '-'})`)
  return ok
}

/** How many audit rows exist for one action+entity — used by the audit tests. */
export async function auditCount(db: D1Database, action: string, entityType?: string, entityId?: string | number): Promise<number> {
  const sql =
    entityType === undefined
      ? 'SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = ?'
      : entityId === undefined
        ? 'SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = ? AND entity_type = ?'
        : 'SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = ? AND entity_type = ? AND entity_id = ?'
  const binds = entityType === undefined ? [action] : entityId === undefined ? [action, entityType] : [action, entityType, String(entityId)]
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>()
  return Number(row?.n ?? 0)
}

export type AuditListFilters = { q: string; action: string; entityType: string; actor: string }

/** The audit list query. Filtered, ordered, and never unbounded. */
export async function listAuditEvents(
  db: D1Database,
  input: { filters: AuditListFilters; limit: number; offset: number; sort: 'newest' | 'oldest' }
): Promise<{ rows: Array<Record<string, unknown>>; total: number }> {
  const where: string[] = []
  const binds: unknown[] = []
  if (input.filters.q) {
    where.push('(action LIKE ? OR entity_type LIKE ? OR entity_id LIKE ? OR actor_email LIKE ?)')
    const like = `%${input.filters.q}%`
    binds.push(like, like, like, like)
  }
  if (input.filters.action) {
    where.push('action = ?')
    binds.push(input.filters.action)
  }
  if (input.filters.entityType) {
    where.push('entity_type = ?')
    binds.push(input.filters.entityType)
  }
  if (input.filters.actor) {
    where.push('actor_email = ?')
    binds.push(input.filters.actor)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const order = input.sort === 'oldest' ? 'id ASC' : 'id DESC'
  const [rows, total] = await Promise.all([
    db
      .prepare(`SELECT * FROM admin_audit_events ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, input.limit, input.offset)
      .all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS n FROM admin_audit_events ${clause}`).bind(...binds).first<{ n: number }>()
  ])
  return { rows: rows.results || [], total: Number(total?.n ?? 0) }
}

/** Distinct action names, for the audit screen's action filter. */
export async function auditActions(db: D1Database, limit = 200): Promise<string[]> {
  const rows =
    (
      await db
        .prepare('SELECT DISTINCT action FROM admin_audit_events ORDER BY action LIMIT ?')
        .bind(limit)
        .all<{ action: string }>()
    ).results || []
  return rows.map((r) => r.action)
}

/** Recursion guard for nested payload redaction. */
const REDACTED_KEY = /(secret|token|password|passwd|hash|api[_-]?key|authorization|cookie|signature|card|cvv|object[_-]?key|storage|upload|photo|signed|payload|raw|body|url|email|address|phone|name)/i

/**
 * Redact a stored JSON payload for display (ADM-19).
 *
 * Different from audit redaction on purpose: this one also hides personal data
 * and free-form provider bodies, because the event screens are a read-only
 * window and must not become a second copy of the customer record. Numbers and
 * booleans survive; a long free-text string is truncated.
 */
export function redactEventPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…'
  if (value == null) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length === 0) return value
    // Keep short enum-ish values (statuses, currencies, kinds) that make an event
    // readable, hide everything longer as opaque content.
    if (value.length <= 24 && /^[A-Za-z0-9_.:@\-/ ]+$/.test(value)) return value
    return `«redacted ${value.length} chars»`
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactEventPayload(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEY.test(k)) {
        out[k] = '«redacted»'
        continue
      }
      out[k] = redactEventPayload(v, depth + 1)
    }
    return out
  }
  return String(value)
}

/** Render a stored JSON string through the event redactor. */
export function redactedJsonText(raw: unknown, maxLength = 4000): string {
  const text = raw == null ? '' : String(raw)
  if (!text) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return '«unparseable payload — not displayed»'
  }
  let out = JSON.stringify(redactEventPayload(parsed), null, 2)
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}\n… truncated`
  return out
}

/** The audit-row metadata column, redacted for display. */
export function redactedMetadataText(raw: unknown, maxLength = 2000): string {
  return redactedJsonText(raw, maxLength)
}

export { redactAuditMetadata }
