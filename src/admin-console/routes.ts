/**
 * The Phase-6 admin console routes (UI + JSON API).
 *
 * Registered from `src/index.tsx` AFTER the central guard, so every route here is
 * already authorized by `./policy.ts` before its handler runs. Each handler still
 * validates its input, calls the shared domain service, records exactly ONE audit
 * event on success and redirects (UI) or answers JSON (API) — never a bare
 * "render on POST", so a refresh cannot replay a mutation.
 *
 * High-risk forms are issued a re-auth ticket by the GET that renders them; the
 * POST that consumes it is refused by the guard if the ticket or password is
 * missing, before any of this code runs.
 */
import type { Hono } from 'hono'
import type { AdminCtx } from './types'
import { esc } from '../layout'
import { adminPage } from '../admin'
import {
  adminAuditView,
  adminBooksView,
  adminCustomerDetailView,
  adminCustomersView,
  adminEventsView,
  adminExportsView,
  adminFulfilmentView,
  adminIntegrationsView,
  adminPrivacyView,
  adminProspectsView,
  adminRetentionView,
  adminStaffMatrixView,
  adminStaffView,
  adminSupportInbox,
  adminSupportTicketView
} from './views'
import { auditMutation, listAuditEvents, auditActions } from './audit'
import { readEventStream, streamsFor } from './events'
import { EXPORT_KINDS, exportKindsFor, listExportJobs, runExport } from './exports'
import { listFeatureFlags, providerHealthReport, setFeatureFlag } from './integrations'
import { listState, orderByClause, parseAdminList } from './list'
import {
  CUSTOMER_SORTS,
  FULFILMENT_SCOPE,
  customerDetail,
  dashboardModel,
  fulfilmentQueue,
  listAdminCustomers,
  prospectOverview
} from './ops'
import {
  PRIVACY_STATUSES,
  listAdminPrivacyRequests,
  listRetentionFailures,
  privacyStatusCounts,
  retryRetentionFailure,
  transitionPrivacyRequest
} from './privacy'
import { issueReauthTicket } from './guard'
import { redeemAdminMediaToken, type AdminMediaKind } from './media'
import { ADMIN_ROLES, PERMISSIONS, permissionsByGroup, roleDefinition } from './rbac'
import { permissionKeysForRole, grantRole, listStaff, revokeRole, rolesForUser } from './roles'
import {
  addStaffMessage,
  assignTicket,
  getAdminTicket,
  listAdminTickets,
  overdueTicketCount,
  setTicketPriority,
  staffMayTransition,
  ticketStatusCounts,
  transitionTicketAsStaff
} from './support'
import { registerAdminApiRoutes } from './api'

export const REAUTH_TICKET_TTL_NOTE = 'A confirmation is valid for 10 minutes and can be used once.'

// ----------------------------------------------------------------- utilities

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function perms(c: AdminCtx): readonly string[] {
  return (c.get('adminPermissions') as string[] | undefined) ?? []
}

function intParam(value: unknown, min: number, max: number): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null
  return n
}

function str(value: unknown, max = 200): string {
  return String(value ?? '').trim().slice(0, max)
}

function flashPath(path: string, message: string, isError = false): string {
  const param = isError ? 'error' : 'saved'
  return `${path}${path.includes('?') ? '&' : '?'}${param}=${encodeURIComponent(message)}`
}

function actorId(c: AdminCtx): number | null {
  const user = c.get('user') as { id?: number } | null
  return user?.id ?? null
}

function actorEmail(c: AdminCtx): string | null {
  const user = c.get('user') as { email?: string } | null
  return user?.email ?? null
}

/** Issue the ticket a high-risk FORM must carry, for a specific POST route. */
async function ticketForPost(c: AdminCtx, pathPattern: string, entityRef?: string) {
  const path = entityRef ?? new URL(c.req.url).pathname
  return issueReauthTicket(c, `POST ${pathPattern}`, path)
}

/** The staff who may work support, for the assignment control. */
async function supportStaff(db: D1Database): Promise<Array<{ id: number; email: string; roles: string[] }>> {
  const rows =
    (
      await db
        .prepare(
          `SELECT DISTINCT u.id, u.email
             FROM users u
            WHERE u.role = 'admin'
              AND (
                EXISTS (
                  SELECT 1 FROM admin_user_roles ur
                    JOIN admin_role_permissions rp ON rp.role_key = ur.role_key
                   WHERE ur.user_id = u.id AND rp.permission_key = 'support.operate'
                )
                OR NOT EXISTS (SELECT 1 FROM admin_user_roles x WHERE x.user_id = u.id)
              )
            ORDER BY u.email`
        )
        .all<{ id: number; email: string }>()
    ).results || []
  const out: Array<{ id: number; email: string; roles: string[] }> = []
  for (const row of rows) out.push({ id: row.id, email: row.email, roles: await rolesForUser(db, { id: row.id, role: 'admin' }) })
  return out
}

// --------------------------------------------------------------------- UI

function registerCustomerRoutes(app: Hono<any>) {
  app.get('/admin/customers', async (c: AdminCtx) => {
    const query = parseAdminList(new URL(c.req.url).searchParams, {
      sorts: { newest: 'u.id DESC', orders: 'order_count', spent: 'captured_minor', name: 'u.name' },
      defaultSort: 'newest',
      filterKeys: ['verified'],
      allowedFilterValues: { verified: ['yes', 'no'] }
    })
    const { rows, total } = await listAdminCustomers(c.env.DB, {
      q: query.q,
      verified: query.filters.verified ?? '',
      limit: query.perPage,
      offset: query.offset,
      order: query.sort,
      desc: query.dir === 'desc'
    })
    return c.html(
      adminCustomersView({
        permissions: perms(c),
        rows,
        state: listState(query, total),
        query,
        flash: c.req.query('saved'),
        error: c.req.query('error')
      })
    )
  })

  app.get('/admin/customers/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.notFound()
    const data = await customerDetail(c.env.DB, id)
    if (!data) {
      return c.html(
        adminPage({
          permissions: perms(c),
          title: 'Customer not found',
          active: 'customers',
          body: '<p class="a-notice error">That customer no longer exists.</p>'
        }),
        404
      )
    }
    // ADM-02: a brand-new account is not on the Staff screen (that screen lists
    // staff), so its own page is where a role is granted. Both high-risk routes get
    // their own confirmation.
    const canManageStaff = perms(c).includes('staff.manage')
    const [reauthGrant, reauthRevoke] = canManageStaff
      ? await Promise.all([
          ticketForPost(c, '/admin/staff/:id/roles', `/admin/staff/${id}/roles`),
          ticketForPost(c, '/admin/staff/:id/roles/revoke', `/admin/staff/${id}/roles/revoke`)
        ])
      : [undefined, undefined]
    return c.html(
      adminCustomerDetailView({
        permissions: perms(c),
        data,
        nowSeconds: nowSeconds(),
        assignableRoles: ADMIN_ROLES,
        reauthGrant,
        reauthRevoke
      })
    )
  })

  app.get('/admin/prospects', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const query = parseAdminList(url.searchParams, {
      sorts: { newest: 'p.id DESC' },
      defaultSort: 'newest',
      filterKeys: ['status'],
      allowedFilterValues: { status: ['active', 'claimed', 'expired'] }
    })
    const { rows, total, consentVersions } = await prospectOverview(c.env.DB, {
      status: query.filters.status ?? '',
      limit: query.perPage,
      offset: query.offset,
      nowSeconds: nowSeconds()
    })
    return c.html(
      adminProspectsView({
        permissions: perms(c),
        rows,
        total,
        consentVersions,
        status: query.filters.status ?? '',
        page: query.page,
        perPage: query.perPage,
        nowSeconds: nowSeconds()
      })
    )
  })

  app.get('/admin/books', async (c: AdminCtx) => {
    const query = parseAdminList(new URL(c.req.url).searchParams, {
      sorts: { newest: 'b.id DESC', revision: 'b.current_revision' },
      defaultSort: 'newest',
      filterKeys: ['state'],
      maxQueryLength: 120
    })
    const db = c.env.DB
    const where: string[] = []
    const binds: unknown[] = []
    if (query.filters.state) {
      where.push('b.state = ?')
      binds.push(query.filters.state)
    }
    if (query.q) {
      where.push('(b.public_id LIKE ? OR u.email LIKE ?)')
      binds.push(`%${query.q}%`, `%${query.q}%`)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const order = orderByClause(query, { newest: 'b.id', revision: 'b.current_revision' }, 'b.id DESC')
    const [rows, total] = await Promise.all([
      db
        .prepare(
          `SELECT b.id, b.public_id, b.state, b.current_revision, b.retention_deadline, b.created_at,
                  b.prospect_id, u.email AS owner_email,
                  (SELECT COUNT(*) FROM generation_jobs j WHERE j.user_book_id = b.id) AS job_count,
                  (SELECT COUNT(*) FROM preview_versions pv WHERE pv.user_book_id = b.id) AS preview_count
             FROM user_books b LEFT JOIN users u ON u.id = b.user_id
             ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`
        )
        .bind(...binds, query.perPage, query.offset)
        .all<Record<string, unknown>>(),
      db
        .prepare(`SELECT COUNT(*) AS n FROM user_books b LEFT JOIN users u ON u.id = b.user_id ${clause}`)
        .bind(...binds)
        .first<{ n: number }>()
    ])
    return c.html(
      adminBooksView({
        permissions: perms(c),
        rows: rows.results || [],
        state: listState(query, Number(total?.n ?? 0)),
        query
      })
    )
  })

  app.get('/admin/fulfilment', async (c: AdminCtx) => {
    const query = parseAdminList(new URL(c.req.url).searchParams, {
      sorts: { newest: 'i.id DESC' },
      defaultSort: 'newest',
      filterKeys: ['preview_status'],
      allowedFilterValues: { preview_status: ['pending', 'preview_ready', 'changes_requested', 'approved'] }
    })
    const data = await fulfilmentQueue(c.env.DB, {
      previewStatus: query.filters.preview_status ?? '',
      limit: query.perPage,
      offset: query.offset
    })
    return c.html(
      adminFulfilmentView({
        permissions: perms(c),
        rows: data.rows,
        total: data.total,
        pdfRequests: data.pdfRequests,
        pdfTotal: data.pdfTotal,
        previewStatus: query.filters.preview_status ?? '',
        scope: FULFILMENT_SCOPE,
        page: query.page,
        perPage: query.perPage
      })
    )
  })
}

function registerSupportRoutes(app: Hono<any>) {
  app.get('/admin/support', async (c: AdminCtx) => {
    const query = parseAdminList(new URL(c.req.url).searchParams, {
      sorts: { oldest: 't.sla_due_at', newest: 't.id', updated: 't.updated_at', priority: 't.priority' },
      defaultSort: 'oldest',
      filterKeys: ['status', 'priority', 'category', 'assignee'],
      allowedFilterValues: {
        status: ['open', 'assigned', 'waiting_customer', 'waiting_staff', 'resolved', 'closed'],
        priority: ['low', 'normal', 'high'],
        category: ['order', 'personalization', 'download', 'payment', 'account', 'other']
      }
    })
    const db = c.env.DB
    const [data, counts, overdue, staff] = await Promise.all([
      listAdminTickets(db, {
        filters: {
          status: query.filters.status ?? '',
          priority: query.filters.priority ?? '',
          assignee: query.filters.assignee ?? '',
          category: query.filters.category ?? ''
        },
        limit: query.perPage,
        offset: query.offset,
        order: query.sort,
        nowSeconds: nowSeconds(),
        q: query.q,
        selfUserId: actorId(c)
      }),
      ticketStatusCounts(db),
      overdueTicketCount(db, nowSeconds()),
      supportStaff(db)
    ])
    return c.html(
      adminSupportInbox({
        permissions: perms(c),
        rows: data.rows,
        state: listState(query, data.total),
        query,
        counts,
        overdue,
        staff,
        flash: c.req.query('saved'),
        error: c.req.query('error'),
        nowSeconds: nowSeconds()
      })
    )
  })

  app.get('/admin/support/:id', async (c: AdminCtx) => {
    const detail = await getAdminTicket(c.env.DB, str(c.req.param('id'), 60), nowSeconds())
    if (!detail) {
      return c.html(
        adminPage({ permissions: perms(c), title: 'Ticket not found', active: 'support', body: '<p class="a-notice error">That ticket does not exist.</p>' }),
        404
      )
    }
    return c.html(
      adminSupportTicketView({
        permissions: perms(c),
        detail: detail as never,
        staff: await supportStaff(c.env.DB),
        flash: c.req.query('saved'),
        error: c.req.query('error')
      })
    )
  })

  app.post('/admin/support/:id/assign', async (c: AdminCtx) => {
    const publicId = str(c.req.param('id'), 60)
    const detail = await getAdminTicket(c.env.DB, publicId, nowSeconds())
    if (!detail) return c.redirect(flashPath('/admin/support', 'That ticket does not exist.', true))
    const form = await c.req.parseBody()
    const raw = str(form.assignee_id, 20)
    const assigneeId = raw ? intParam(raw, 1, Number.MAX_SAFE_INTEGER) : null
    if (raw && assigneeId == null) return c.redirect(flashPath(`/admin/support/${publicId}`, 'That assignee is not a valid account id.', true))
    const result = await assignTicket(c.env.DB, {
      ticketId: detail.ticket.id,
      assigneeId,
      actorUserId: actorId(c),
      note: form.note,
      correlationId: (c.get('requestId') as string | null) ?? undefined
    })
    if (!result.ok) return c.redirect(flashPath(`/admin/support/${publicId}`, result.error, true))
    await auditMutation(c, {
      action: result.detail === 'assigned' ? 'support.ticket.assign' : 'support.ticket.unassign',
      entityType: 'support_ticket',
      entityId: detail.ticket.id,
      reason: str(form.note, 500) || null,
      metadata: { publicId, assigneeId }
    })
    return c.redirect(flashPath(`/admin/support/${publicId}`, result.detail === 'assigned' ? 'Ticket assigned.' : 'Ticket unassigned.'))
  })

  app.post('/admin/support/:id/priority', async (c: AdminCtx) => {
    const publicId = str(c.req.param('id'), 60)
    const detail = await getAdminTicket(c.env.DB, publicId, nowSeconds())
    if (!detail) return c.redirect(flashPath('/admin/support', 'That ticket does not exist.', true))
    const form = await c.req.parseBody()
    const reason = str(form.reason, 2000)
    if (reason.length < 3) return c.redirect(flashPath(`/admin/support/${publicId}`, 'A short reason is required to change priority.', true))
    const from = String(detail.ticket.priority)
    const to = str(form.priority, 10)
    const result = await setTicketPriority(c.env.DB, {
      ticketId: detail.ticket.id,
      priority: to,
      actorUserId: actorId(c),
      reason,
      correlationId: (c.get('requestId') as string | null) ?? undefined
    })
    if (!result.ok) return c.redirect(flashPath(`/admin/support/${publicId}`, result.error, true))
    await auditMutation(c, {
      action: 'support.ticket.priority',
      entityType: 'support_ticket',
      entityId: detail.ticket.id,
      reason,
      metadata: { from, to }
    })
    return c.redirect(flashPath(`/admin/support/${publicId}`, `Priority set to ${to}.`))
  })

  app.post('/admin/support/:id/status', async (c: AdminCtx) => {
    const publicId = str(c.req.param('id'), 60)
    const detail = await getAdminTicket(c.env.DB, publicId, nowSeconds())
    if (!detail) return c.redirect(flashPath('/admin/support', 'That ticket does not exist.', true))
    const form = await c.req.parseBody()
    const to = str(form.to, 30)
    const from = String(detail.ticket.status)
    if (to === from) return c.redirect(flashPath(`/admin/support/${publicId}`, 'The ticket is already in that state.', true))
    if (!staffMayTransition(from, to)) return c.redirect(flashPath(`/admin/support/${publicId}`, `A ticket cannot move from ${from} to ${to}.`, true))
    const result = await transitionTicketAsStaff(c.env.DB, {
      ticketId: detail.ticket.id,
      from,
      to,
      actorUserId: actorId(c),
      note: form.reason,
      correlationId: (c.get('requestId') as string | null) ?? undefined
    })
    if (!result.ok) return c.redirect(flashPath(`/admin/support/${publicId}`, result.error, true))
    await auditMutation(c, {
      action: 'support.ticket.status',
      entityType: 'support_ticket',
      entityId: detail.ticket.id,
      reason: str(form.reason, 500),
      metadata: { from, to }
    })
    return c.redirect(flashPath(`/admin/support/${publicId}`, `Ticket moved to ${to.replace(/_/g, ' ')}.`))
  })

  app.post('/admin/support/:id/messages', async (c: AdminCtx) => {
    const publicId = str(c.req.param('id'), 60)
    const detail = await getAdminTicket(c.env.DB, publicId, nowSeconds())
    if (!detail) return c.redirect(flashPath('/admin/support', 'That ticket does not exist.', true))
    const form = await c.req.parseBody()
    const internal = form.internal === '1' || form.internal === 'on'
    const result = await addStaffMessage(c.env.DB, {
      ticketId: detail.ticket.id,
      body: form.body,
      internal,
      actorUserId: actorId(c),
      actorEmail: actorEmail(c),
      correlationId: (c.get('requestId') as string | null) ?? undefined
    })
    if (!result.ok) return c.redirect(flashPath(`/admin/support/${publicId}`, result.error, true))
    await auditMutation(c, {
      action: internal ? 'support.ticket.internal_note' : 'support.ticket.reply',
      entityType: 'support_ticket',
      entityId: detail.ticket.id,
      metadata: { internal, length: String(form.body ?? '').length }
    })
    return c.redirect(flashPath(`/admin/support/${publicId}`, internal ? 'Internal note recorded.' : 'Reply sent to the customer.'))
  })
}

function registerPrivacyRoutes(app: Hono<any>) {
  app.get('/admin/privacy', async (c: AdminCtx) => {
    const query = parseAdminList(new URL(c.req.url).searchParams, {
      sorts: { newest: 'r.id DESC' },
      defaultSort: 'newest',
      filterKeys: ['status', 'kind'],
      allowedFilterValues: { status: [...PRIVACY_STATUSES], kind: ['export', 'delete'] }
    })
    const db = c.env.DB
    const [data, counts] = await Promise.all([
      listAdminPrivacyRequests(db, {
        status: query.filters.status ?? '',
        kind: query.filters.kind ?? '',
        limit: query.perPage,
        offset: query.offset,
        q: query.q,
        nowSeconds: nowSeconds()
      }),
      privacyStatusCounts(db)
    ])
    // A ticket is issued for the DECISION route, not for this page, so the
    // confirmation is bound to the action it will authorise.
    const reauth = perms(c).includes('privacy.manage') ? await ticketForPost(c, '/admin/privacy/:id/status') : undefined
    return c.html(
      adminPrivacyView({
        permissions: perms(c),
        rows: data.rows,
        counts,
        status: query.filters.status ?? '',
        kind: query.filters.kind ?? '',
        total: data.total,
        reauth,
        flash: c.req.query('saved'),
        error: c.req.query('error')
      })
    )
  })

  app.post('/admin/privacy/:id/status', async (c: AdminCtx) => {
    const publicId = str(c.req.param('id'), 80)
    const form = await c.req.parseBody()
    const to = str(form.to, 30)
    const result = await transitionPrivacyRequest(c.env.DB, {
      publicId,
      to,
      actorUserId: actorId(c),
      reason: form.reason,
      responseNote: form.response_note,
      legalHold: form.legal_hold === 'release' ? false : form.legal_hold === 'place' ? true : null
    })
    if (!result.ok) return c.redirect(flashPath('/admin/privacy', result.error, true))
    await auditMutation(c, {
      action: 'privacy.request.status',
      entityType: 'privacy_request',
      entityId: publicId,
      reason: str(form.reason, 500),
      metadata: { to }
    })
    return c.redirect(flashPath('/admin/privacy', `Request moved to ${to.replace(/_/g, ' ')}.`))
  })

  app.get('/admin/retention', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const includeResolved = url.searchParams.get('resolved') === '1'
    const query = parseAdminList(url.searchParams, { sorts: { newest: 'f.id DESC' }, defaultSort: 'newest' })
    const data = await listRetentionFailures(c.env.DB, { includeResolved, limit: query.perPage, offset: query.offset })
    return c.html(
      adminRetentionView({
        permissions: perms(c),
        rows: data.rows,
        total: data.total,
        includeResolved,
        flash: c.req.query('saved'),
        error: c.req.query('error')
      })
    )
  })

  app.post('/admin/retention/:id/retry', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect(flashPath('/admin/retention', 'Invalid failure id.', true))
    const result = await retryRetentionFailure(c.env.DB, c.env.PHOTOS, id, () => nowSeconds())
    if (!result.ok) return c.redirect(flashPath('/admin/retention', result.message, true))
    await auditMutation(c, {
      action: 'retention.retry',
      entityType: 'retention_failure',
      entityId: id,
      metadata: { resolved: result.resolved, attempts: result.attempts }
    })
    return c.redirect(flashPath('/admin/retention', result.message, !result.resolved))
  })
}

function registerSystemRoutes(app: Hono<any>) {
  app.get('/admin/integrations', async (c: AdminCtx) => {
    const [report, flags] = await Promise.all([providerHealthReport(c.env as never), listFeatureFlags(c.env.DB)])
    const reauth = perms(c).includes('integrations.flags') ? await ticketForPost(c, '/admin/integrations/flags/:key') : undefined
    return c.html(
      adminIntegrationsView({
        permissions: perms(c),
        report,
        flags,
        reauth,
        flash: c.req.query('saved'),
        error: c.req.query('error')
      })
    )
  })

  app.post('/admin/integrations/flags/:key', async (c: AdminCtx) => {
    const key = str(c.req.param('key'), 60)
    const form = await c.req.parseBody()
    const reason = str(form.reason, 500)
    if (reason.length < 3) return c.redirect(flashPath('/admin/integrations', 'A short reason is required to change a feature flag.', true))
    const enabled = form.enabled === '1'
    const result = await setFeatureFlag(c.env.DB, { key, enabled, actorUserId: actorId(c) })
    if (!result.ok) return c.redirect(flashPath('/admin/integrations', result.error, true))
    await auditMutation(c, {
      action: 'integration.flag.update',
      entityType: 'feature_flag',
      entityId: key,
      reason,
      metadata: { enabled }
    })
    return c.redirect(flashPath('/admin/integrations', `${key} is now ${enabled ? 'on' : 'off'}.`))
  })

  /**
   * ADM-09: activate or deactivate a language. Fails CLOSED on a language with no
   * published catalogue copy — activating it would offer a storefront locale that
   * renders English under a foreign label, which is a false capability claim.
   */
  app.post('/admin/localization/languages/:code', async (c: AdminCtx) => {
    const code = str(c.req.param('code'), 10)
    const form = await c.req.parseBody()
    const row = await c.env.DB.prepare('SELECT code, active FROM languages WHERE code = ?').bind(code).first<{ code: string; active: number }>()
    if (!row) return c.redirect(flashPath('/admin/localization', 'That language is not configured.', true))
    const active = form.active === '1' ? 1 : 0
    if (active === 1 && code !== 'en') {
      const published = await c.env.DB
        .prepare("SELECT COUNT(*) AS n FROM product_localizations WHERE language_code = ? AND status = 'published'")
        .bind(code)
        .first<{ n: number }>()
      if (Number(published?.n ?? 0) === 0) {
        return c.redirect(
          flashPath('/admin/localization', `No published product translation exists for ${code}, so activating it would show English under a ${code} label.`, true)
        )
      }
    }
    await c.env.DB.prepare('UPDATE languages SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?').bind(active, code).run()
    await auditMutation(c, {
      action: 'localization.language.update',
      entityType: 'language',
      entityId: code,
      metadata: { from: Number(row.active), to: active }
    })
    return c.redirect(flashPath('/admin/localization', active === 1 ? `${code} is now offered in the storefront.` : `${code} is no longer offered.`))
  })

  app.get('/admin/events', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const streams = streamsFor(perms(c))
    const requested = str(url.searchParams.get('stream'), 40)
    const active = streams.some((s) => s.key === requested) ? requested : null
    const perPage = 50
    const pageNum = Math.max(1, Number(url.searchParams.get('page') || 1) || 1)
    const page = active ? await readEventStream(c.env.DB, active, { limit: perPage, offset: (pageNum - 1) * perPage }) : null
    return c.html(adminEventsView({ permissions: perms(c), streams, active, page, pageNum, perPage }))
  })

  app.get('/admin/audit', async (c: AdminCtx) => {
    const query = parseAdminList(new URL(c.req.url).searchParams, {
      sorts: { newest: 'id DESC', oldest: 'id ASC' },
      defaultSort: 'newest',
      filterKeys: ['action', 'entityType', 'actor'],
      maxQueryLength: 120
    })
    const filters = {
      q: query.q,
      action: query.filters.action ?? '',
      entityType: query.filters.entityType ?? '',
      actor: query.filters.actor ?? ''
    }
    const [data, actions, reauthEvents] = await Promise.all([
      listAuditEvents(c.env.DB, {
        filters,
        limit: query.perPage,
        offset: query.offset,
        sort: query.sort === 'oldest' ? 'oldest' : 'newest'
      }),
      auditActions(c.env.DB),
      c.env.DB.prepare(
        `SELECT e.*, u.email AS actor_email FROM admin_reauth_events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT 30`
      ).all<Record<string, unknown>>()
    ])
    return c.html(
      adminAuditView({
        permissions: perms(c),
        rows: data.rows,
        total: data.total,
        state: listState(query, data.total),
        query,
        actions,
        reauthEvents: reauthEvents.results || [],
        flash: c.req.query('saved')
      })
    )
  })

  app.get('/admin/staff', async (c: AdminCtx) => {
    const rows = await listStaff(c.env.DB)
    // A grant and a revoke are different routes, so each gets its own
    // confirmation (one password entry authorises one of them, not both).
    const canManage = perms(c).includes('staff.manage')
    const [reauthGrant, reauthRevoke] = canManage
      ? await Promise.all([ticketForPost(c, '/admin/staff/:id/roles'), ticketForPost(c, '/admin/staff/:id/roles/revoke')])
      : [undefined, undefined]
    return c.html(
      adminStaffView({
        permissions: perms(c),
        rows,
        assignableRoles: ADMIN_ROLES,
        reauthGrant,
        reauthRevoke,
        flash: c.req.query('saved'),
        error: c.req.query('error')
      })
    )
  })

  app.get('/admin/staff/matrix', async (c: AdminCtx) => {
    const db = c.env.DB
    // Read the matrix the SERVER enforces and compare it with the shipped
    // default, so this page reports drift instead of hiding it.
    const roles = []
    for (const role of ADMIN_ROLES) {
      const def = roleDefinition(role)
      roles.push({
        role,
        label: def?.label ?? role,
        description: def?.description ?? '',
        permissions: await permissionKeysForRole(db, role),
        users: Number(
          (await db.prepare('SELECT COUNT(*) AS n FROM admin_user_roles WHERE role_key = ?').bind(role).first<{ n: number }>())?.n ?? 0
        )
      })
    }
    const drift: string[] = []
    for (const role of ADMIN_ROLES) {
      const shipped = [...(roleDefinition(role)?.permissions ?? [])].sort()
      const stored = [...(roles.find((r) => r.role === role)?.permissions ?? [])].sort()
      if (shipped.join(',') !== stored.join(',')) {
        const missing = shipped.filter((p) => !stored.includes(p))
        const extra = stored.filter((p) => !shipped.includes(p))
        drift.push(`${role} (missing: ${missing.join(' ') || 'none'}; extra: ${extra.join(' ') || 'none'})`)
      }
    }
    return c.html(
      adminStaffMatrixView({
        permissions: perms(c),
        roles,
        catalogue: permissionsByGroup(),
        mismatch: drift.length ? drift.join('; ') : null
      })
    )
  })

  app.get('/admin/staff/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.notFound()
    const data = await customerDetail(c.env.DB, id)
    if (!data) return c.redirect(flashPath('/admin/staff', 'That account does not exist.', true))
    const user = data.user as Record<string, unknown>
    const roles = await rolesForUser(c.env.DB, { id, role: String(user.role ?? '') })
    return c.html(
      adminPage({
        permissions: perms(c),
        title: `Account ${String(user.email)}`,
        active: 'staff',
        body: `<p><a class="a-link" href="/admin/staff">← Staff</a></p>
        <h1>${esc(String(user.name))}</h1>
        <p class="a-muted">${esc(String(user.email))} · ${esc(String(user.role))}${Number(user.email_verified ?? 0) === 1 ? ' · email confirmed' : ''}</p>
        <section class="a-card"><h2>Roles</h2><p>${roles.length ? roles.map((r) => `<span class="badge-state">${esc(r)}</span>`).join(' ') : 'No staff role.'}</p>
        <p><a class="a-link" href="/admin/staff">Manage roles →</a></p></section>`
      })
    )
  })

  for (const [suffix, action, label] of [
    ['/roles', 'staff.role.grant', 'Grant a staff role'],
    ['/roles/revoke', 'staff.role.revoke', 'Revoke a staff role']
  ] as const) {
    app.post(`/admin/staff/:id${suffix}`, async (c: AdminCtx) => {
      const userId = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
      if (userId == null) return c.redirect(flashPath('/admin/staff', 'Invalid account id.', true))
      const form = await c.req.parseBody()
      const role = str(form.role, 40)
      const reason = str(form.reason, 500)
      if (reason.length < 3) return c.redirect(flashPath('/admin/staff', `A short reason is required to ${label.toLowerCase()}.`, true))
      const result = suffix === '/roles'
        ? await grantRole(c.env.DB, { userId, role, actorUserId: actorId(c) })
        : await revokeRole(c.env.DB, { userId, role, actorUserId: actorId(c) })
      if (!result.ok) return c.redirect(flashPath('/admin/staff', result.error, true))
      await auditMutation(c, {
        action,
        entityType: 'admin_user_role',
        entityId: `${userId}:${role}`,
        reason,
        metadata: { userId, role }
      })
      return c.redirect(flashPath('/admin/staff', suffix === '/roles' ? `${role} granted.` : `${role} revoked.`))
    })
  }

  app.get('/admin/exports', async (c: AdminCtx) => {
    const query = parseAdminList(new URL(c.req.url).searchParams, { sorts: { newest: 'id DESC' }, defaultSort: 'newest' })
    const jobs = await listExportJobs(c.env.DB, query.perPage, query.offset)
    const reauth = perms(c).includes('exports.create') ? await ticketForPost(c, '/admin/exports') : undefined
    return c.html(
      adminExportsView({
        permissions: perms(c),
        jobs: jobs.rows,
        kinds: exportKindsFor(perms(c)),
        allKinds: EXPORT_KINDS,
        reauth,
        flash: c.req.query('saved'),
        error: c.req.query('error')
      })
    )
  })

  app.post('/admin/exports', async (c: AdminCtx) => {
    const form = await c.req.parseBody()
    const kind = str(form.kind, 40)
    const filterValue = str(form.filter_value, 40)
    const definition = EXPORT_KINDS.find((k) => k.key === kind)
    const filters: Record<string, string> = {}
    if (definition && filterValue && definition.filters.length) filters[definition.filters[0].key] = filterValue
    const result = await runExport(c.env.DB, {
      kind,
      filters,
      requesterUserId: actorId(c),
      requesterEmail: actorEmail(c),
      permissions: perms(c)
    })
    if (!result.ok) return c.redirect(flashPath('/admin/exports', result.error, true))
    await auditMutation(c, {
      action: 'export.create',
      entityType: 'export_job',
      entityId: result.jobPublicId,
      metadata: { kind, rowCount: result.rowCount, truncated: result.truncated, byteSize: result.byteSize }
    })
    return new Response(result.csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'X-Export-Job': result.jobPublicId,
        'X-Export-Rows': String(result.rowCount),
        'X-Export-Truncated': result.truncated ? '1' : '0',
        'Cache-Control': 'no-store'
      }
    })
  })
}

// --------------------------------------------------------- private media

/**
 * V2 §10 — "private photo/preview access is short-lived, permission checked and
 * not embedded as permanent URLs".
 *
 * The panel never links an R2 key. A screen that shows a private object mints a
 * capability (`./media.ts`), and the browser fetches it here. The CENTRAL guard
 * has already required the permission the object's data carries (`books.read` /
 * `previews.read`) before this handler runs; the capability then has to be
 * unconsumed, unexpired and bound to this exact actor.
 *
 * Every failure answers 404 with no body — the same answer a missing object
 * gives — so the route cannot be used to probe whether a private object exists,
 * and a stale `<img>` after a redemption simply renders as a broken image rather
 * than leaking a reason.
 */
function registerMediaRoutes(app: Hono<any>): void {
  const serve = (kind: AdminMediaKind) => async (c: AdminCtx) => {
    const user = c.get('user') as { id?: number } | null
    const redeemed = await redeemAdminMediaToken(c.env.DB, {
      token: String(c.req.param('token') ?? ''),
      userId: Number(user?.id ?? 0),
      kind
    })
    if (!redeemed.ok) return c.notFound()
    if (!c.env.PHOTOS) return c.notFound()
    const object = await c.env.PHOTOS.get(redeemed.objectKey)
    if (!object) return c.notFound()
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    // no-store, not max-age: a one-hour client cache of a child's photograph is
    // exactly the "permanent URL" the pack forbids.
    headers.set('Cache-Control', 'private, no-store')
    headers.set('X-Robots-Tag', 'noindex, noimageindex')
    return new Response(object.body, { headers })
  }
  app.get('/admin/media/photo/:token', serve('photo'))
  app.get('/admin/media/preview/:token', serve('preview'))
}

// ------------------------------------------------------------------ exports

/**
 * Register every Phase-6 admin console route. Called from src/index.tsx AFTER the
 * central guard middleware.
 */
export function registerAdminConsoleRoutes(app: Hono<any>): void {
  registerCustomerRoutes(app)
  registerSupportRoutes(app)
  registerPrivacyRoutes(app)
  registerSystemRoutes(app)
  registerMediaRoutes(app)
  registerAdminApiRoutes(app)
}

