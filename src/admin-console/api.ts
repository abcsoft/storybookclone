/**
 * ADM-02 / ADM-21 — the `/api/v1/admin/...` JSON surface.
 *
 * Every route here is listed in `./policy.ts`, so the SAME central guard that
 * protects the HTML pages protects these — including the re-authentication
 * requirement on refunds, role changes, privacy decisions, template publishing,
 * flag changes and exports. Nothing in this module re-implements authorization;
 * it only resolves the caller's permission set (put on the request context by the
 * guard) and calls the same domain services the UI calls.
 *
 * API contract (V2 §8):
 *   * stable error object `{ error: { code, message, fields?, requestId } }`
 *   * list responses carry `page: { limit, offset, total, hasMore }`
 *   * integer minor units and ISO currency, UTC ISO-8601 timestamps
 *   * cursor-free offset paging is bounded to 100 rows per request
 */
import type { Hono } from 'hono'
import type { AdminCtx } from './types'
import { financialSummary, reconciliationIssues } from '../commerce/reporting'
import { getPaymentProvider, paymentProviderHealth } from '../commerce/payments'
import { requestRefund } from '../commerce/refunds'
import { retryJob, cancelJob } from '../generation/jobs'
import { cloneTemplateToDraft, publishTemplate } from '../generation/templates'
import { moderateReview } from '../reviews'
import { auditMutation, listAuditEvents, requestSource } from './audit'
import { readEventStream, streamsFor } from './events'
import { EXPORT_KINDS, exportKindsFor, listExportJobs, runExport } from './exports'
import { listFeatureFlags, providerHealthReport, setFeatureFlag } from './integrations'
import { reauthTicketHandler } from './guard'
import { ADMIN_MEDIA_TTL_SECONDS, issueAdminMediaToken, mediaKeyIsWellFormed, type AdminMediaKind } from './media'
import { PERMISSIONS, permissionsByGroup, roleDefinition, ADMIN_ROLES } from './rbac'
import { grantRole, listStaff, permissionKeysForRole, revokeRole, rolesForUser } from './roles'
import { dashboardModel, listAdminCustomers, customerDetail, prospectOverview, fulfilmentQueue, FULFILMENT_SCOPE } from './ops'
import {
  listAdminPrivacyRequests,
  listRetentionFailures,
  retryRetentionFailure,
  transitionPrivacyRequest
} from './privacy'
import {
  addStaffMessage,
  assignTicket,
  getAdminTicket,
  listAdminTickets,
  setTicketPriority,
  transitionTicketAsStaff,
  STAFF_TICKET_TRANSITIONS,
  SLA_POLICY_NOTE
} from './support'

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 25

function perms(c: AdminCtx): string[] {
  return (c.get('adminPermissions') as string[] | undefined) ?? []
}

function requestId(c: AdminCtx): string | null {
  return (c.get('requestId') as string | null) ?? null
}

/** The authenticated actor's id — put on the request context by the guard. */
function actorId(c: AdminCtx): number | null {
  const user = c.get('user') as { id?: number } | null
  return user?.id ?? null
}

function fail(c: AdminCtx, status: 400 | 401 | 403 | 404 | 409 | 422, code: string, message: string, fields?: Record<string, string>): Response {
  return c.json({ error: { code, message, fields: fields ?? null, requestId: requestId(c) } }, status)
}

function ok(c: AdminCtx, data: unknown, status = 200): Response {
  return c.json({ data, requestId: requestId(c) }, status as never)
}

function paging(c: AdminCtx): { limit: number; offset: number } {
  const url = new URL(c.req.url)
  const rawLimit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT
  const rawOffset = Number(url.searchParams.get('offset') || 0)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  return { limit, offset }
}

function pageMeta(limit: number, offset: number, total: number) {
  return { limit, offset, total, hasMore: offset + limit < total }
}

function intParam(value: unknown, min = 1): number | null {
  const n = Number(value)
  return Number.isFinite(n) && Number.isInteger(n) && n >= min ? n : null
}

function str(value: unknown, max = 200): string {
  return String(value ?? '').trim().slice(0, max)
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

async function jsonBody(c: AdminCtx): Promise<Record<string, unknown>> {
  const contentType = c.req.header('Content-Type') || ''
  if (contentType.includes('application/json')) return (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  return (await c.req.parseBody()) as unknown as Record<string, unknown>
}

export function registerAdminApiRoutes(app: Hono<any>): void {
  // ---------------------------------------------------------------- re-auth
  app.post('/api/v1/admin/reauth', (c: AdminCtx) => reauthTicketHandler(c))

  // --------------------------------------------------------------- dashboard
  app.get('/api/v1/admin/dashboard', async (c: AdminCtx) => {
    const model = await dashboardModel(c.env.DB, nowSeconds())
    return ok(c, {
      revenue: model.summary.revenueByCurrency.map((r) => ({
        currency: r.currency,
        capturedMinor: r.capturedMinor,
        refundedMinor: r.refundedMinor,
        disputedMinor: r.disputedMinor,
        netMinor: r.netMinor,
        paidOrders: r.paidOrders
      })),
      unpaid: model.summary.unpaid,
      refunds: model.summary.refunds,
      disputes: model.summary.disputes,
      revenueStatement: model.revenueStatement,
      counts: model.counts,
      reconciliationIssues: model.issues.slice(0, 10),
      recentOrders: model.recentOrders
    })
  })

  // ------------------------------------------------------------------ orders
  app.get('/api/v1/admin/orders', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { limit, offset } = paging(c)
    const where: string[] = []
    const binds: unknown[] = []
    const status = str(url.searchParams.get('status'), 30)
    const paymentStatus = str(url.searchParams.get('payment_status'), 30)
    const q = str(url.searchParams.get('q'), 80)
    if (status) {
      where.push('o.status = ?')
      binds.push(status)
    }
    if (paymentStatus) {
      where.push('o.payment_status = ?')
      binds.push(paymentStatus)
    }
    if (q) {
      where.push('(o.email LIKE ? OR o.full_name LIKE ?)')
      binds.push(`%${q}%`, `%${q}%`)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const sort = url.searchParams.get('sort') === 'total' ? 'o.total_minor' : 'o.id'
    const dir = url.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC'
    const [rows, total] = await Promise.all([
      c.env.DB.prepare(
        `SELECT o.id, o.status, o.payment_status, o.currency, o.total_minor, o.subtotal_minor, o.discount_minor,
                o.shipping_minor, o.tax_minor, o.amount_captured_minor, o.amount_refunded_minor, o.created_at, o.paid_at,
                (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
           FROM orders o ${clause} ORDER BY ${sort} ${dir}, o.id DESC LIMIT ? OFFSET ?`
      )
        .bind(...binds, limit, offset)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM orders o ${clause}`).bind(...binds).first<{ n: number }>()
    ])
    return ok(c, { orders: rows.results || [], page: pageMeta(limit, offset, Number(total?.n ?? 0)) })
  })

  app.get('/api/v1/admin/orders/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'))
    if (id == null) return fail(c, 400, 'validation_failed', 'A numeric order id is required.')
    const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>()
    if (!order) return fail(c, 404, 'not_found', 'That order does not exist.')
    // The idempotency payload hash is an internal fingerprint — never returned.
    delete (order as Record<string, unknown>).idempotency_payload_hash
    const [items, timeline, ledger, refunds, attempts] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, product_id, slug, title, kind, qty, unit_price_minor, currency, child_name, child_age, language,
                preview_status, user_book_id, personalization_input_revision, variant_code, created_at
           FROM order_items WHERE order_id = ? ORDER BY id`
      ).bind(id).all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT * FROM order_state_events WHERE order_id = ? ORDER BY id').bind(id).all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT * FROM order_financial_entries WHERE order_id = ? ORDER BY id').bind(id).all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY id DESC').bind(id).all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT * FROM payment_attempts WHERE order_id = ? ORDER BY id DESC').bind(id).all<Record<string, unknown>>()
    ])
    return ok(c, {
      order,
      items: items.results || [],
      timeline: timeline.results || [],
      ledger: ledger.results || [],
      refunds: refunds.results || [],
      paymentAttempts: attempts.results || []
    })
  })

  app.post('/api/v1/admin/orders/:id/notes', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'))
    if (id == null) return fail(c, 400, 'validation_failed', 'A numeric order id is required.')
    const exists = await c.env.DB.prepare('SELECT id FROM orders WHERE id = ?').bind(id).first<{ id: number }>()
    if (!exists) return fail(c, 404, 'not_found', 'That order does not exist.')
    const body = await jsonBody(c)
    const notes = String(body.notes ?? '').slice(0, 4000)
    await c.env.DB.prepare('UPDATE orders SET admin_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(notes, id).run()
    await auditMutation(c, { action: 'order.notes_update', entityType: 'order', entityId: id, metadata: { length: notes.length } })
    return ok(c, { orderId: id, notesLength: notes.length })
  })

  app.post('/api/v1/admin/orders/:id/refunds', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'))
    if (id == null) return fail(c, 400, 'validation_failed', 'A numeric order id is required.')
    const body = await jsonBody(c)
    const reason = str(body.reason, 200)
    if (!reason) return fail(c, 400, 'validation_failed', 'A reason is required to refund an order.', { reason: 'required' })
    const amountRaw = body.amountMinor ?? body.amount_minor
    let amountMinor: number | null = null
    if (amountRaw != null && String(amountRaw) !== '') {
      const parsed = Number(amountRaw)
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
        return fail(c, 400, 'validation_failed', 'amountMinor must be a positive whole number of minor units, or omitted for the full remaining amount.')
      }
      amountMinor = parsed
    }
    const idempotencyKey = str(body.idempotencyKey ?? body.idempotency_key, 120) || `admin-api-refund:${id}:${crypto.randomUUID()}`
    const actor = (c.get('user') as { id?: number; email?: string } | null) ?? null
    const result = await requestRefund(c.env.DB, getPaymentProvider(c.env), {
      orderId: id,
      amountMinor,
      reason,
      idempotencyKey,
      actor: { userId: actor?.id ?? null, email: actor?.email ?? null }
    })
    if (!result.ok) {
      const status = result.status === 404 ? 404 : result.status === 400 ? 400 : 409
      return fail(c, status as 400 | 404 | 409, result.code ?? 'refund_failed', result.error ?? 'The refund could not be completed.')
    }
    if (!result.replayed) {
      await auditMutation(c, {
        action: 'order.refund',
        entityType: 'order',
        entityId: id,
        reason,
        metadata: { amountMinor: result.refund?.amount_minor ?? null, remainingMinor: result.remainingMinor ?? null, via: 'api' }
      })
    }
    return ok(
      c,
      {
        refund: result.refund ?? null,
        replayed: !!result.replayed,
        capturedMinor: result.capturedMinor ?? null,
        refundedMinor: result.refundedMinor ?? null,
        remainingMinor: result.remainingMinor ?? null
      },
      result.replayed ? 200 : 201
    )
  })

  app.post('/api/v1/admin/orders/:id/status', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'))
    if (id == null) return fail(c, 400, 'validation_failed', 'A numeric order id is required.')
    const body = await jsonBody(c)
    const { transitionOrderStatus } = await import('../orders-status')
    const result = await transitionOrderStatus(c.env.DB, {
      orderId: id,
      to: str(body.status, 40),
      reason: str(body.reason, 200),
      actor: { userId: (c.get('user') as { id?: number } | null)?.id ?? null, email: (c.get('user') as { email?: string } | null)?.email ?? null, requestId: requestId(c) ?? undefined }
    })
    if (!result.ok) return fail(c, 409, 'invalid_transition', result.error)
    if (!result.noop) {
      await auditMutation(c, {
        action: 'order.status_change',
        entityType: 'order',
        entityId: id,
        reason: str(body.reason, 200) || null,
        metadata: { from: result.from, to: result.to }
      })
    }
    return ok(c, { orderId: id, from: result.from, to: result.to, noop: !!result.noop })
  })

  // ------------------------------------------------------- customers/books
  app.get('/api/v1/admin/customers', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { limit, offset } = paging(c)
    const { rows, total } = await listAdminCustomers(c.env.DB, {
      q: str(url.searchParams.get('q'), 80),
      verified: str(url.searchParams.get('verified'), 4),
      limit,
      offset,
      order: str(url.searchParams.get('sort'), 12) || 'newest',
      desc: url.searchParams.get('dir') !== 'asc'
    })
    return ok(c, { customers: rows, page: pageMeta(limit, offset, total) })
  })

  app.get('/api/v1/admin/customers/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'))
    if (id == null) return fail(c, 400, 'validation_failed', 'A numeric user id is required.')
    const data = await customerDetail(c.env.DB, id)
    if (!data) return fail(c, 404, 'not_found', 'That account does not exist.')
    return ok(c, data)
  })

  app.get('/api/v1/admin/prospects', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { limit, offset } = paging(c)
    const data = await prospectOverview(c.env.DB, {
      status: str(url.searchParams.get('status'), 20),
      limit,
      offset,
      nowSeconds: nowSeconds()
    })
    return ok(c, { prospects: data.rows, consentVersions: data.consentVersions, page: pageMeta(limit, offset, data.total) })
  })

  app.get('/api/v1/admin/books', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { limit, offset } = paging(c)
    const state = str(url.searchParams.get('state'), 40)
    const where = state ? 'WHERE b.state = ?' : ''
    const binds = state ? [state] : []
    const [rows, total] = await Promise.all([
      c.env.DB.prepare(
        `SELECT b.id, b.public_id, b.state, b.current_revision, b.consent_version, b.retention_deadline, b.user_id,
                b.prospect_id, b.created_at, b.updated_at,
                (SELECT COUNT(*) FROM generation_jobs j WHERE j.user_book_id = b.id) AS job_count,
                (SELECT COUNT(*) FROM preview_versions pv WHERE pv.user_book_id = b.id) AS preview_count
           FROM user_books b ${where} ORDER BY b.id DESC LIMIT ? OFFSET ?`
      )
        .bind(...binds, limit, offset)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM user_books b ${where}`).bind(...binds).first<{ n: number }>()
    ])
    return ok(c, { books: rows.results || [], page: pageMeta(limit, offset, Number(total?.n ?? 0)) })
  })

  app.get('/api/v1/admin/books/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'))
    if (id == null) return fail(c, 400, 'validation_failed', 'A numeric book id is required.')
    const book = await c.env.DB.prepare('SELECT * FROM user_books WHERE id = ?').bind(id).first<Record<string, unknown>>()
    if (!book) return fail(c, 404, 'not_found', 'That user book does not exist.')
    // `selected_upload_key` is a private storage key: reported as present/absent,
    // never echoed. Same rule for previews below.
    const hasUpload = !!book.selected_upload_key
    delete book.selected_upload_key
    const [jobs, previews, events] = await Promise.all([
      c.env.DB.prepare('SELECT id, public_id, status, attempt_count, template_id, created_at FROM generation_jobs WHERE user_book_id = ? ORDER BY id DESC').bind(id).all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT * FROM preview_versions WHERE user_book_id = ? ORDER BY id DESC').bind(id).all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT * FROM user_book_events WHERE user_book_id = ? ORDER BY id DESC LIMIT 100').bind(id).all<Record<string, unknown>>()
    ])
    return ok(c, {
      book: { ...book, photo_upload_present: hasUpload },
      generationJobs: jobs.results || [],
      previewVersions: previews.results || [],
      events: events.results || []
    })
  })

  // ---------------------------------------------------------------- catalog
  app.get('/api/v1/admin/catalog/products', async (c: AdminCtx) => {
    const { limit, offset } = paging(c)
    const url = new URL(c.req.url)
    const q = str(url.searchParams.get('q'), 80)
    const where = q ? 'WHERE p.title LIKE ? OR p.slug LIKE ?' : ''
    const binds = q ? [`%${q}%`, `%${q}%`] : []
    const [rows, total] = await Promise.all([
      c.env.DB.prepare(
        `SELECT p.id, p.slug, p.title, p.category, p.gender, p.active, p.price_minor, p.compare_at_price_minor, p.currency,
                (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id) AS variant_count,
                (SELECT COUNT(*) FROM product_prices pp WHERE pp.product_id = p.id) AS price_count
           FROM products p ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`
      )
        .bind(...binds, limit, offset)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM products p ${where}`).bind(...binds).first<{ n: number }>()
    ])
    return ok(c, { products: rows.results || [], page: pageMeta(limit, offset, Number(total?.n ?? 0)) })
  })

  app.get('/api/v1/admin/catalog/collections', async (c: AdminCtx) => {
    const { limit, offset } = paging(c)
    const [rows, total] = await Promise.all([
      c.env.DB.prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM collection_products cp WHERE cp.collection_id = c.id) AS product_count
           FROM collections c ORDER BY c.sort_order, c.id LIMIT ? OFFSET ?`
      )
        .bind(limit, offset)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM collections').first<{ n: number }>()
    ])
    return ok(c, { collections: rows.results || [], page: pageMeta(limit, offset, Number(total?.n ?? 0)) })
  })

  app.get('/api/v1/admin/cms/pages', async (c: AdminCtx) => {
    const { limit, offset } = paging(c)
    const [rows, total] = await Promise.all([
      c.env.DB.prepare('SELECT id, slug, kind, title, status, published_at, updated_at FROM cms_pages ORDER BY sort_order, id LIMIT ? OFFSET ?')
        .bind(limit, offset)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM cms_pages').first<{ n: number }>()
    ])
    return ok(c, { pages: rows.results || [], page: pageMeta(limit, offset, Number(total?.n ?? 0)) })
  })

  // --------------------------------------------------------- Story Studio
  app.get('/api/v1/admin/templates', async (c: AdminCtx) => {
    const { limit, offset } = paging(c)
    const [rows, total] = await Promise.all([
      c.env.DB.prepare(
        `SELECT t.id, t.product_id, t.language_code, t.version, t.status, t.created_at,
                (SELECT COUNT(*) FROM book_scenes s WHERE s.template_id = t.id) AS scene_count
           FROM book_templates t ORDER BY t.id DESC LIMIT ? OFFSET ?`
      )
        .bind(limit, offset)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM book_templates').first<{ n: number }>()
    ])
    return ok(c, { templates: rows.results || [], page: pageMeta(limit, offset, Number(total?.n ?? 0)) })
  })

  app.post('/api/v1/admin/templates/:id/clone', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'))
    if (id == null) return fail(c, 400, 'validation_failed', 'A numeric template id is required.')
    try {
      const draft = await cloneTemplateToDraft(c.env.DB, id)
      await auditMutation(c, { action: 'generation.template.clone', entityType: 'book_template', entityId: draft.id, metadata: { fromTemplateId: id, version: draft.version, via: 'api' } })
      return ok(c, { template: { id: draft.id, version: draft.version, status: draft.status } }, 201)
    } catch (err) {
      return fail(c, 409, 'clone_failed', err instanceof Error ? err.message : 'Could not clone the template.')
    }
  })

  app.post('/api/v1/admin/templates/:id/publish', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'))
    if (id == null) return fail(c, 400, 'validation_failed', 'A numeric template id is required.')
    const body = await jsonBody(c)
    try {
      const published = await publishTemplate(c.env.DB, id)
      await auditMutation(c, {
        action: 'generation.template.publish',
        entityType: 'book_template',
        entityId: id,
        reason: str(body.reason, 200) || null,
        metadata: { version: published.version, via: 'api' }
      })
      return ok(c, { template: { id: published.id, version: published.version, status: published.status } })
    } catch (err) {
      return fail(c, 409, 'publish_refused', err instanceof Error ? err.message : 'Could not publish the template.')
    }
  })

  // ------------------------------------------------------- generation jobs
  app.get('/api/v1/admin/generation/jobs', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { limit, offset } = paging(c)
    const status = str(url.searchParams.get('status'), 30)
    const where = status ? 'WHERE j.status = ?' : ''
    const binds = status ? [status] : []
    const [rows, total] = await Promise.all([
      c.env.DB.prepare(
        `SELECT j.id, j.public_id, j.user_book_id, j.template_id, j.status, j.attempt_count, j.max_attempts,
                j.available_at, j.lease_expires_at, j.last_error_code, j.finished_at, j.created_at
           FROM generation_jobs j ${where} ORDER BY j.id DESC LIMIT ? OFFSET ?`
      )
        .bind(...binds, limit, offset)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM generation_jobs j ${where}`).bind(...binds).first<{ n: number }>()
    ])
    return ok(c, { jobs: rows.results || [], page: pageMeta(limit, offset, Number(total?.n ?? 0)) })
  })

  app.post('/api/v1/admin/generation/jobs/:id/retry', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'))
    if (id == null) return fail(c, 400, 'validation_failed', 'A numeric job id is required.')
    const outcome = await retryJob(c.env.DB, id, { type: 'admin', id: (c.get('user') as { id?: number } | null)?.id?.toString() ?? null })
    if (!outcome.retried) return fail(c, 409, 'retry_refused', `That job cannot be retried (${outcome.reason ?? 'unknown'}).`)
    await auditMutation(c, { action: 'generation.job.retry', entityType: 'generation_job', entityId: id, metadata: { via: 'api' } })
    return ok(c, { jobId: id, retried: true })
  })

  app.post('/api/v1/admin/generation/jobs/:id/cancel', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'))
    if (id == null) return fail(c, 400, 'validation_failed', 'A numeric job id is required.')
    const body = await jsonBody(c)
    const reason = str(body.reason, 200)
    if (!reason) return fail(c, 400, 'validation_failed', 'A reason is required to cancel a job.', { reason: 'required' })
    const outcome = await cancelJob(c.env.DB, id, { type: 'admin', id: (c.get('user') as { id?: number } | null)?.id?.toString() ?? null }, reason)
    if (!outcome.cancelled && !outcome.alreadyCancelled) return fail(c, 409, 'cancel_refused', 'That job can no longer be cancelled.')
    await auditMutation(c, { action: 'generation.job.cancel', entityType: 'generation_job', entityId: id, reason, metadata: { via: 'api' } })
    return ok(c, { jobId: id, cancelled: !!outcome.cancelled, alreadyCancelled: !!outcome.alreadyCancelled })
  })

  app.get('/api/v1/admin/previews', async (c: AdminCtx) => {
    const { limit, offset } = paging(c)
    const [rows, total] = await Promise.all([
      c.env.DB.prepare(
        `SELECT pv.id, pv.user_book_id, pv.input_revision, pv.template_id, pv.status, pv.scene_count, pv.finalized_at, pv.created_at,
                (SELECT COUNT(*) FROM approvals a WHERE a.preview_version_id = pv.id AND a.decision = 'approved') AS approved_rows,
                (SELECT COUNT(*) FROM revision_requests rr WHERE rr.preview_version_id = pv.id) AS revision_requests
           FROM preview_versions pv ORDER BY pv.id DESC LIMIT ? OFFSET ?`
      )
        .bind(limit, offset)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM preview_versions').first<{ n: number }>()
    ])
    return ok(c, {
      previews: (rows.results || []).map((p) => ({
        ...p,
        queue:
          Number(p.approved_rows) > 0 ? 'approved' : Number(p.revision_requests) > 0 ? 'changes_requested' : 'awaiting_approval'
      })),
      page: pageMeta(limit, offset, Number(total?.n ?? 0))
    })
  })

  // ------------------------------------------------------- private media (V2 §10)
  // A private object is never addressed by its key. An API client asks for a
  // capability naming the object, receives a SHORT-LIVED, single-use URL, and
  // fetches the bytes from `/admin/media/photo|preview/<token>` — where the same
  // permission is checked again by the central guard. Minting is a read of data
  // the caller may already see, so it needs the data's read permission.
  const mintMedia = (kind: AdminMediaKind) => async (c: AdminCtx) => {
    const body = await jsonBody(c)
    const key = str(body.key ?? body.objectKey, 300)
    if (!key) return fail(c, 400, 'validation_failed', 'Provide the object key you need to view.', { key: 'required' })
    if (!mediaKeyIsWellFormed(kind, key)) {
      return fail(c, 422, 'validation_failed', 'That is not a key for this kind of private object.', { key: 'malformed' })
    }
    const issued = await issueAdminMediaToken(c.env.DB, { userId: Number(actorId(c) ?? 0), kind, objectKey: key })
    // 404 rather than 403: the caller may hold the permission and still be asking
    // about an object that does not exist, and this endpoint must not become an
    // existence oracle for the whole bucket.
    if (!issued) return fail(c, 404, 'not_found', 'No such object.')
    return ok(c, {
      kind: issued.kind,
      url: issued.url,
      permission: issued.permission,
      expiresInSeconds: ADMIN_MEDIA_TTL_SECONDS,
      note: 'The url is single-use and expires quickly. It is a capability, not a permanent link — request a new one for each view.'
    })
  }
  app.post('/api/v1/admin/media/photos/token', mintMedia('photo'))
  app.post('/api/v1/admin/media/previews/token', mintMedia('preview'))

  // ----------------------------------------------------------------- finance
  app.get('/api/v1/admin/payments', async (c: AdminCtx) => {
    const { limit, offset } = paging(c)
    const [rows, total] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM payment_attempts ORDER BY id DESC LIMIT ? OFFSET ?').bind(limit, offset).all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM payment_attempts').first<{ n: number }>()
    ])
    return ok(c, { payments: rows.results || [], provider: paymentProviderHealth(c.env), page: pageMeta(limit, offset, Number(total?.n ?? 0)) })
  })

  app.get('/api/v1/admin/refunds', async (c: AdminCtx) => {
    const { limit, offset } = paging(c)
    const [rows, total] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM refunds ORDER BY id DESC LIMIT ? OFFSET ?').bind(limit, offset).all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM refunds').first<{ n: number }>()
    ])
    return ok(c, { refunds: rows.results || [], page: pageMeta(limit, offset, Number(total?.n ?? 0)) })
  })

  app.get('/api/v1/admin/reconciliation', async (c: AdminCtx) => {
    const [issues, summary] = await Promise.all([reconciliationIssues(c.env.DB, 200), financialSummary(c.env.DB, {})])
    return ok(c, {
      issues,
      revenueByCurrency: summary.revenueByCurrency,
      unpaid: summary.unpaid,
      statement: 'Revenue is captured minus refunded and disputed from the payment ledger; it is never derived from an order status.'
    })
  })

  app.get('/api/v1/admin/discounts', async (c: AdminCtx) => {
    const { limit, offset } = paging(c)
    const [rows, total] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM discounts ORDER BY priority, id LIMIT ? OFFSET ?').bind(limit, offset).all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM discounts').first<{ n: number }>()
    ])
    return ok(c, { discounts: rows.results || [], page: pageMeta(limit, offset, Number(total?.n ?? 0)) })
  })

  // -------------------------------------------------------------- fulfilment
  app.get('/api/v1/admin/fulfilment/pdf-requests', async (c: AdminCtx) => {
    const { limit, offset } = paging(c)
    const data = await fulfilmentQueue(c.env.DB, { previewStatus: '', limit, offset })
    return ok(c, {
      pdfRequests: data.pdfRequests,
      productionQueue: data.rows,
      scope: FULFILMENT_SCOPE,
      page: pageMeta(limit, offset, data.total)
    })
  })

  // ----------------------------------------------------------------- reviews
  app.get('/api/v1/admin/reviews', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { limit, offset } = paging(c)
    const status = str(url.searchParams.get('status'), 20)
    const where = status ? 'WHERE r.status = ?' : ''
    const binds = status ? [status] : []
    const [rows, total] = await Promise.all([
      c.env.DB.prepare(
        `SELECT r.*, p.slug AS product_slug FROM reviews r LEFT JOIN products p ON p.id = r.product_id ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`
      )
        .bind(...binds, limit, offset)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM reviews r ${where}`).bind(...binds).first<{ n: number }>()
    ])
    return ok(c, { reviews: rows.results || [], page: pageMeta(limit, offset, Number(total?.n ?? 0)) })
  })

  app.post('/api/v1/admin/reviews/:id/moderate', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'))
    if (id == null) return fail(c, 400, 'validation_failed', 'A numeric review id is required.')
    const body = await jsonBody(c)
    const action = str(body.action, 12) === 'publish' ? 'publish' : 'reject'
    const reason = str(body.reason, 200)
    const result = await moderateReview(c.env.DB, id, action, (c.get('user') as { id?: number } | null)?.id ?? null, reason)
    if (!result.ok) return fail(c, 409, 'moderation_refused', result.error)
    await auditMutation(c, { action: `review.${result.status}`, entityType: 'review', entityId: id, reason: reason || null, metadata: { via: 'api' } })
    return ok(c, { reviewId: id, status: result.status })
  })

  // ------------------------------------------------------------- localization
  app.get('/api/v1/admin/localization', async (c: AdminCtx) => {
    const [languages, productLocalizations, cmsLocalizations] = await Promise.all([
      c.env.DB.prepare(
        `SELECT l.*, (SELECT COUNT(*) FROM product_localizations pl WHERE pl.language_code = l.code) AS product_rows,
                  (SELECT COUNT(*) FROM cms_page_localizations cl WHERE cl.language_code = l.code) AS cms_rows
           FROM languages l ORDER BY l.code`
      ).all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT COUNT(DISTINCT product_id) AS n FROM product_localizations WHERE status = ?').bind('published').first<{ n: number }>(),
      c.env.DB.prepare('SELECT COUNT(DISTINCT page_id) AS n FROM cms_page_localizations WHERE status = ?').bind('published').first<{ n: number }>()
    ])
    return ok(c, {
      languages: languages.results || [],
      publishedProductTranslations: Number(productLocalizations?.n ?? 0),
      publishedCmsTranslations: Number(cmsLocalizations?.n ?? 0),
      note: 'A language row is offered in the storefront only when it is active AND the catalogue has copy for it; completeness is reported, never assumed.'
    })
  })

  app.post('/api/v1/admin/localization/languages/:code', async (c: AdminCtx) => {
    const code = str(c.req.param('code'), 10)
    const body = await jsonBody(c)
    const body2 = body as Record<string, unknown>
    const row = await c.env.DB.prepare('SELECT code, active FROM languages WHERE code = ?').bind(code).first<{ code: string; active: number }>()
    if (!row) return fail(c, 404, 'not_found', 'That language is not configured.')
    const active = body2.active === true || body2.active === '1' || body2.active === 'on' ? 1 : 0
    if (active === 1 && code !== 'en') {
      // Fail closed on a language with no published catalogue copy: activating it
      // would offer a storefront locale that renders English under a foreign label.
      const published = await c.env.DB
        .prepare("SELECT COUNT(*) AS n FROM product_localizations WHERE language_code = ? AND status = 'published'")
        .bind(code)
        .first<{ n: number }>()
      if (Number(published?.n ?? 0) === 0) {
        return fail(c, 409, 'no_published_translations', `No published product translation exists for ${code}, so activating it would show English under a ${code} label.`)
      }
    }
    await c.env.DB.prepare('UPDATE languages SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?').bind(active, code).run()
    await auditMutation(c, {
      action: 'localization.language.update',
      entityType: 'language',
      entityId: code,
      metadata: { from: Number(row.active), to: active, via: 'api' }
    })
    return ok(c, { code, active: active === 1 })
  })

  // ----------------------------------------------------------------- support
  app.get('/api/v1/admin/support/tickets', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { limit, offset } = paging(c)
    const data = await listAdminTickets(c.env.DB, {
      filters: {
        status: str(url.searchParams.get('status'), 30),
        priority: str(url.searchParams.get('priority'), 12),
        category: str(url.searchParams.get('category'), 20),
        assignee: str(url.searchParams.get('assignee'), 20)
      },
      limit,
      offset,
      order: str(url.searchParams.get('sort'), 12) || 'oldest',
      nowSeconds: nowSeconds(),
      q: str(url.searchParams.get('q'), 80),
      selfUserId: (c.get('user') as { id?: number } | null)?.id ?? null
    })
    return ok(c, {
      tickets: data.rows.map((t) => ({ ...t, slaPolicy: SLA_POLICY_NOTE })),
      page: pageMeta(limit, offset, data.total)
    })
  })

  app.get('/api/v1/admin/support/tickets/:id', async (c: AdminCtx) => {
    const detail = await getAdminTicket(c.env.DB, str(c.req.param('id'), 60), nowSeconds())
    if (!detail) return fail(c, 404, 'not_found', 'That ticket does not exist.')
    return ok(c, {
      ticket: detail.ticket,
      sla: detail.sla,
      transitions: detail.transitions,
      messages: detail.messages,
      attachments: detail.attachments.map((a) => ({ ...a, objectKey: undefined })),
      events: detail.events
    })
  })

  app.post('/api/v1/admin/support/tickets/:id/assign', async (c: AdminCtx) => {
    const publicId = str(c.req.param('id'), 60)
    const detail = await getAdminTicket(c.env.DB, publicId, nowSeconds())
    if (!detail) return fail(c, 404, 'not_found', 'That ticket does not exist.')
    const body = await jsonBody(c)
    const raw = body.assigneeId ?? body.assignee_id
    const assigneeId = raw == null || String(raw) === '' ? null : intParam(raw)
    if (raw != null && String(raw) !== '' && assigneeId == null) return fail(c, 400, 'validation_failed', 'assigneeId must be a numeric user id.')
    const result = await assignTicket(c.env.DB, {
      ticketId: detail.ticket.id,
      assigneeId,
      actorUserId: (c.get('user') as { id?: number } | null)?.id ?? null,
      note: body.note,
      correlationId: requestId(c) ?? undefined
    })
    if (!result.ok) return fail(c, 409, 'assignment_refused', result.error)
    await auditMutation(c, {
      action: result.detail === 'assigned' ? 'support.ticket.assign' : 'support.ticket.unassign',
      entityType: 'support_ticket',
      entityId: detail.ticket.id,
      metadata: { publicId, assigneeId, via: 'api' }
    })
    return ok(c, { ticketId: detail.ticket.id, assigneeId })
  })

  app.post('/api/v1/admin/support/tickets/:id/priority', async (c: AdminCtx) => {
    const publicId = str(c.req.param('id'), 60)
    const detail = await getAdminTicket(c.env.DB, publicId, nowSeconds())
    if (!detail) return fail(c, 404, 'not_found', 'That ticket does not exist.')
    const body = await jsonBody(c)
    const reason = str(body.reason, 2000)
    if (reason.length < 3) return fail(c, 400, 'validation_failed', 'A short reason is required to change priority.', { reason: 'required' })
    const result = await setTicketPriority(c.env.DB, {
      ticketId: detail.ticket.id,
      priority: str(body.priority, 10),
      actorUserId: (c.get('user') as { id?: number } | null)?.id ?? null,
      reason,
      correlationId: requestId(c) ?? undefined
    })
    if (!result.ok) return fail(c, 409, 'priority_refused', result.error)
    await auditMutation(c, {
      action: 'support.ticket.priority',
      entityType: 'support_ticket',
      entityId: detail.ticket.id,
      reason,
      metadata: { to: str(body.priority, 10), via: 'api' }
    })
    return ok(c, { ticketId: detail.ticket.id, priority: str(body.priority, 10) })
  })

  app.post('/api/v1/admin/support/tickets/:id/status', async (c: AdminCtx) => {
    const publicId = str(c.req.param('id'), 60)
    const detail = await getAdminTicket(c.env.DB, publicId, nowSeconds())
    if (!detail) return fail(c, 404, 'not_found', 'That ticket does not exist.')
    const body = await jsonBody(c)
    const to = str(body.to ?? body.status, 30)
    const from = String(detail.ticket.status)
    if (to === from) return fail(c, 409, 'no_change', 'The ticket is already in that state.')
    if (!(STAFF_TICKET_TRANSITIONS[from] ?? []).includes(to)) {
      return fail(c, 409, 'invalid_transition', `A ticket cannot move from ${from} to ${to}.`)
    }
    const result = await transitionTicketAsStaff(c.env.DB, {
      ticketId: detail.ticket.id,
      from,
      to,
      actorUserId: (c.get('user') as { id?: number } | null)?.id ?? null,
      note: body.reason,
      correlationId: requestId(c) ?? undefined
    })
    if (!result.ok) return fail(c, 409, 'transition_refused', result.error)
    await auditMutation(c, {
      action: 'support.ticket.status',
      entityType: 'support_ticket',
      entityId: detail.ticket.id,
      reason: str(body.reason, 500),
      metadata: { from, to, via: 'api' }
    })
    return ok(c, { ticketId: detail.ticket.id, from, to })
  })

  app.post('/api/v1/admin/support/tickets/:id/messages', async (c: AdminCtx) => {
    const publicId = str(c.req.param('id'), 60)
    const detail = await getAdminTicket(c.env.DB, publicId, nowSeconds())
    if (!detail) return fail(c, 404, 'not_found', 'That ticket does not exist.')
    const body = await jsonBody(c)
    const internal = body.internal === true || body.internal === '1' || body.internal === 'on'
    const result = await addStaffMessage(c.env.DB, {
      ticketId: detail.ticket.id,
      body: body.body,
      internal,
      actorUserId: (c.get('user') as { id?: number } | null)?.id ?? null,
      actorEmail: (c.get('user') as { email?: string } | null)?.email ?? null,
      correlationId: requestId(c) ?? undefined
    })
    if (!result.ok) return fail(c, 409, 'reply_refused', result.error)
    await auditMutation(c, {
      action: internal ? 'support.ticket.internal_note' : 'support.ticket.reply',
      entityType: 'support_ticket',
      entityId: detail.ticket.id,
      metadata: { internal, length: String(body.body ?? '').length, via: 'api' }
    })
    return ok(c, { ticketId: detail.ticket.id, internal }, 201)
  })

  // ----------------------------------------------------------------- privacy
  app.get('/api/v1/admin/privacy/requests', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { limit, offset } = paging(c)
    const data = await listAdminPrivacyRequests(c.env.DB, {
      status: str(url.searchParams.get('status'), 30),
      kind: str(url.searchParams.get('kind'), 12),
      limit,
      offset,
      q: str(url.searchParams.get('q'), 80),
      nowSeconds: nowSeconds()
    })
    return ok(c, { requests: data.rows, page: pageMeta(limit, offset, data.total) })
  })

  app.post('/api/v1/admin/privacy/requests/:id/status', async (c: AdminCtx) => {
    const publicId = str(c.req.param('id'), 80)
    const body = await jsonBody(c)
    const to = str(body.to ?? body.status, 30)
    const result = await transitionPrivacyRequest(c.env.DB, {
      publicId,
      to,
      actorUserId: (c.get('user') as { id?: number } | null)?.id ?? null,
      reason: body.reason,
      responseNote: body.responseNote ?? body.response_note,
      legalHold: body.legalHold === true || body.legal_hold === true ? true : null
    })
    if (!result.ok) return fail(c, 409, 'privacy_decision_refused', result.error)
    await auditMutation(c, {
      action: 'privacy.request.status',
      entityType: 'privacy_request',
      entityId: publicId,
      reason: str(body.reason, 500),
      metadata: { to, via: 'api' }
    })
    return ok(c, { requestId: publicId, status: to })
  })

  app.get('/api/v1/admin/retention/failures', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { limit, offset } = paging(c)
    const data = await listRetentionFailures(c.env.DB, { includeResolved: url.searchParams.get('resolved') === '1', limit, offset })
    // The private object key is reported truncated, never in full.
    return ok(c, { failures: data.rows, page: pageMeta(limit, offset, data.total) })
  })

  app.post('/api/v1/admin/retention/failures/:id/retry', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'))
    if (id == null) return fail(c, 400, 'validation_failed', 'A numeric failure id is required.')
    const result = await retryRetentionFailure(c.env.DB, c.env.PHOTOS, id, () => nowSeconds())
    if (!result.ok) return fail(c, 404, 'not_found', result.message)
    await auditMutation(c, {
      action: 'retention.retry',
      entityType: 'retention_failure',
      entityId: id,
      metadata: { resolved: result.resolved, attempts: result.attempts, via: 'api' }
    })
    return ok(c, { failureId: id, resolved: result.resolved, attempts: result.attempts, message: result.message })
  })

  // ----------------------------------------------------- integrations/events
  app.get('/api/v1/admin/integrations', async (c: AdminCtx) => {
    const [report, flags] = await Promise.all([providerHealthReport(c.env), listFeatureFlags(c.env.DB)])
    return ok(c, {
      providers: report.rows,
      paymentMethods: report.paymentMethods,
      notes: report.notes,
      featureFlags: flags.map((f) => ({ key: f.key, label: f.label, enabled: f.enabled, updated_at: f.updated_at })),
      secretPolicy: 'Only configured / not-configured / last-tested state is exposed. No credential is ever read into this response.'
    })
  })

  app.post('/api/v1/admin/integrations/flags/:key', async (c: AdminCtx) => {
    const key = str(c.req.param('key'), 60)
    const body = await jsonBody(c)
    const reason = str(body.reason, 500)
    if (reason.length < 3) return fail(c, 400, 'validation_failed', 'A short reason is required to change a feature flag.', { reason: 'required' })
    const enabled = body.enabled === true || body.enabled === '1' || body.enabled === 'on'
    const result = await setFeatureFlag(c.env.DB, { key, enabled, actorUserId: (c.get('user') as { id?: number } | null)?.id ?? null })
    if (!result.ok) return fail(c, 409, 'flag_refused', result.error)
    await auditMutation(c, { action: 'integration.flag.update', entityType: 'feature_flag', entityId: key, reason, metadata: { enabled, via: 'api' } })
    return ok(c, { key, enabled })
  })

  app.get('/api/v1/admin/events', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { limit, offset } = paging(c)
    const available = streamsFor(perms(c))
    const requested = str(url.searchParams.get('stream'), 40)
    if (!requested) return ok(c, { streams: available.map((s) => ({ key: s.key, label: s.label, purpose: s.purpose, permission: s.permission })) })
    const page = await readEventStream(c.env.DB, requested, { limit, offset })
    if (!page) return fail(c, 404, 'not_found', 'Unknown event stream.')
    if (!perms(c).includes(page.stream.permission)) return fail(c, 403, 'forbidden', `Reading "${page.stream.label}" needs the ${page.stream.permission} permission.`)
    return ok(c, {
      stream: page.stream.key,
      columns: page.stream.columns,
      rows: page.rows,
      redactedPayloads: page.redactedPayloads,
      page: pageMeta(limit, offset, page.total)
    })
  })

  // ------------------------------------------------------------------- staff
  app.get('/api/v1/admin/staff', async (c: AdminCtx) => ok(c, { staff: await listStaff(c.env.DB) }))

  app.get('/api/v1/admin/staff/matrix', async (c: AdminCtx) => {
    const roles = []
    for (const role of ADMIN_ROLES) {
      const def = roleDefinition(role)
      roles.push({
        role,
        label: def?.label ?? role,
        permissions: await permissionKeysForRole(c.env.DB, role),
        users: Number((await c.env.DB.prepare('SELECT COUNT(*) AS n FROM admin_user_roles WHERE role_key = ?').bind(role).first<{ n: number }>())?.n ?? 0)
      })
    }
    return ok(c, { roles, catalogue: permissionsByGroup().map((g) => ({ group: g.group, permissions: g.permissions })) })
  })

  for (const [suffix, action] of [
    ['/roles', 'staff.role.grant'],
    ['/roles/revoke', 'staff.role.revoke']
  ] as const) {
    app.post(`/api/v1/admin/staff/:id${suffix}`, async (c: AdminCtx) => {
      const userId = intParam(c.req.param('id'))
      if (userId == null) return fail(c, 400, 'validation_failed', 'A numeric user id is required.')
      const body = await jsonBody(c)
      const role = str(body.role, 40)
      const reason = str(body.reason, 500)
      if (reason.length < 3) return fail(c, 400, 'validation_failed', 'A short reason is required for a role change.', { reason: 'required' })
      const result =
        suffix === '/roles'
          ? await grantRole(c.env.DB, { userId, role, actorUserId: (c.get('user') as { id?: number } | null)?.id ?? null })
          : await revokeRole(c.env.DB, { userId, role, actorUserId: (c.get('user') as { id?: number } | null)?.id ?? null })
      if (!result.ok) return fail(c, 409, 'role_change_refused', result.error)
      await auditMutation(c, { action, entityType: 'admin_user_role', entityId: `${userId}:${role}`, reason, metadata: { userId, role, via: 'api' } })
      return ok(c, { userId, role, roles: await rolesForUser(c.env.DB, { id: userId, role: 'admin' }) })
    })
  }

  // ------------------------------------------------------------------- audit
  app.get('/api/v1/admin/audit', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { limit, offset } = paging(c)
    const data = await listAuditEvents(c.env.DB, {
      filters: {
        q: str(url.searchParams.get('q'), 120),
        action: str(url.searchParams.get('action'), 80),
        entityType: str(url.searchParams.get('entity_type'), 40),
        actor: str(url.searchParams.get('actor'), 120)
      },
      limit,
      offset,
      sort: url.searchParams.get('sort') === 'oldest' ? 'oldest' : 'newest'
    })
    return ok(c, { events: data.rows, page: pageMeta(limit, offset, data.total) })
  })

  // ----------------------------------------------------------------- exports
  app.get('/api/v1/admin/exports', async (c: AdminCtx) => {
    const { limit, offset } = paging(c)
    const jobs = await listExportJobs(c.env.DB, limit, offset)
    return ok(c, {
      jobs: jobs.rows,
      availableKinds: exportKindsFor(perms(c)).map((k) => ({ key: k.key, label: k.label, permission: k.permission, note: k.note })),
      allKinds: EXPORT_KINDS.map((k) => k.key),
      page: pageMeta(limit, offset, jobs.total)
    })
  })

  app.post('/api/v1/admin/exports', async (c: AdminCtx) => {
    const body = await jsonBody(c)
    const kind = str(body.kind, 40)
    const definition = EXPORT_KINDS.find((k) => k.key === kind)
    const filters: Record<string, string> = {}
    if (definition && definition.filters.length && body.filterValue != null) filters[definition.filters[0].key] = str(body.filterValue, 40)
    const result = await runExport(c.env.DB, {
      kind,
      filters,
      requesterUserId: (c.get('user') as { id?: number } | null)?.id ?? null,
      requesterEmail: (c.get('user') as { email?: string } | null)?.email ?? null,
      permissions: perms(c)
    })
    if (!result.ok) return fail(c, 403, 'export_refused', result.error)
    await auditMutation(c, {
      action: 'export.create',
      entityType: 'export_job',
      entityId: result.jobPublicId,
      metadata: { kind, rowCount: result.rowCount, truncated: result.truncated, via: 'api' }
    })
    return ok(
      c,
      {
        jobId: result.jobPublicId,
        kind,
        filename: result.filename,
        rowCount: result.rowCount,
        byteSize: result.byteSize,
        truncated: result.truncated,
        csv: result.csv,
        note: result.note
      },
      201
    )
  })

  // A tiny self-description so a client can discover the surface and its
  // permissions without guessing. It exposes no data.
  app.get('/api/v1/admin/permissions', async (c: AdminCtx) =>
    ok(c, {
      roles: ADMIN_ROLES,
      permissions: PERMISSIONS.map((p) => ({ key: p.key, group: p.group, label: p.label, highRisk: p.highRisk })),
      granted: perms(c),
      source: requestSource(c)
    })
  )

}
