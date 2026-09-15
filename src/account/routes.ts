// V2 Phase 5 — the customer account HTTP surface (JSON).
//
// Every handler is a thin adapter: authenticate, enforce a rate limit, call the
// domain service, shape the response. No business rule lives here — the same
// services back the server-rendered pages, so a rule cannot be enforced on one
// surface and forgotten on the other.
//
// Ownership is never taken from the request: it comes from the session, and the
// services put it in their WHERE clauses. A resource belonging to somebody else
// is reported as 404 (not 403) everywhere, so an id cannot be probed.
import type { Context, Hono } from 'hono'
import { DomainError } from '../generation/types'
import { rateLimitKey, clientIp } from '../security'
import { consumeRateLimit } from '../rate-limit'
import { requireAuth, currentSessionPublicId, readSessionToken, type AuthUser } from '../auth'
import { mailProviderStatus, type MailEnv } from '../mail/provider'
import { outboxCounts } from '../mail/outbox'
import { brand } from '../brand'
import { getProfile, updateProfileName, getNotificationPreferences, updateNotificationPreferences, sendVerificationEmail, requestEmailChange, confirmEmailChange } from './profile'
import { listSessions, revokeSession, revokeOtherSessions, requireSessionId, touchSession } from './sessions'
import { listSecurityEvents, securityEventLabel, recordSecurityEvent, ipDigest } from './security'
import { listMyBooks, getMyBookDetail, requestStructuredRevision, approveExactVersion, requestGenerationForOwnedBook, revisionPolicy } from './library'
import { listMyDownloads, mintDownloadToken, redeemDownloadToken, r2AssetReader, DOWNLOAD_TOKEN_TTL_SECONDS } from './downloads'
import { createTicket, listMyTickets, getMyTicket, addCustomerMessage, setTicketStatus, loadOwnedAttachment, readAttachmentFromBody, validateTicketInput } from './support'
import { createPrivacyRequest, listPrivacyRequests, cancelPrivacyRequest, privacyRequestEvents } from './privacy'
import { listClaimsForUser, claimableForUser, requestGuestClaim, confirmGuestClaim, claimOrderWithCapability } from './claims'
import { getCustomerOrder } from './orders'

export type AccountBindings = {
  DB: D1Database
  PHOTOS?: R2Bucket
  ENVIRONMENT?: string
  EMAIL_PROVIDER?: string
  EMAIL_API_URL?: string
  EMAIL_API_KEY?: string
  EMAIL_FROM?: string
  EMAIL_FROM_NAME?: string
  IP_HASH_SECRET?: string
  GUEST_ORDER_TOKEN_SECRET?: string
  GUEST_ORDER_TOKEN_SECRET_PREV?: string
  GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE?: string
  REVISION_MAX_PER_REVISION?: string
  REVISION_MAX_PER_BOOK?: string
}

export type AccountVars = { user: AuthUser | null; requestId?: string | null }
export type Ctx = Context<{ Bindings: AccountBindings; Variables: AccountVars }>

export function mailEnvOf(c: Ctx): MailEnv {
  return {
    ENVIRONMENT: c.env.ENVIRONMENT,
    EMAIL_PROVIDER: c.env.EMAIL_PROVIDER,
    EMAIL_API_URL: c.env.EMAIL_API_URL,
    EMAIL_API_KEY: c.env.EMAIL_API_KEY,
    EMAIL_FROM: c.env.EMAIL_FROM,
    EMAIL_FROM_NAME: c.env.EMAIL_FROM_NAME
  }
}

export function originOfRequest(c: Ctx): string {
  return new URL(c.req.url).origin
}

export async function callerIpDigest(c: Ctx): Promise<string | null> {
  try {
    return await ipDigest({ IP_HASH_SECRET: c.env.IP_HASH_SECRET, GUEST_ORDER_TOKEN_SECRET: c.env.GUEST_ORDER_TOKEN_SECRET }, clientIp(c))
  } catch {
    return null
  }
}

/** The signed-in customer, or a JSON 401. Never a redirect. */
export function accountUser(c: Ctx): AuthUser {
  const auth = requireAuth(c)
  if (auth instanceof Response) throw new DomainError('unauthenticated', 'Sign in to continue.', 401)
  return auth
}

function errorBody(err: DomainError, requestId: string) {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.fields ? { fields: err.fields } : {}),
      requestId
    }
  }
}

export async function withErrors(c: Ctx, fn: () => Promise<Response>): Promise<Response> {
  const requestId = c.get('requestId') || crypto.randomUUID()
  try {
    return await fn()
  } catch (err) {
    if (err instanceof DomainError) return c.json(errorBody(err, requestId), err.status as never)
    console.error(`[account] unhandled error (requestId=${requestId}):`, err instanceof Error ? err.message : err)
    return c.json(errorBody(new DomainError('internal', 'Something went wrong. Please try again.', 500), requestId), 500)
  }
}

async function limited(c: Ctx, action: string, max: number, windowSeconds: number, identity?: string | null): Promise<boolean> {
  const result = await consumeRateLimit(c.env.DB, rateLimitKey(action, c, identity), { max, windowSeconds })
  return result.limited
}

/** Reads a JSON body, or a multipart/urlencoded form body, so one handler can serve both surfaces. */
async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  const contentType = (c.req.header('content-type') || '').toLowerCase()
  if (contentType.includes('application/json')) {
    return (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>
  }
  if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
    return (await c.req.parseBody()) as unknown as Record<string, unknown>
  }
  return (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>
}

export function registerAccountApiRoutes(app: Hono<any>): void {
  // -------------------------------------------------------------------------
  // Profile (CUS-01 / CUS-03)
  // -------------------------------------------------------------------------
  app.get('/api/v1/me', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const [profile, preferences, mail] = await Promise.all([getProfile(c.env.DB, user.id), getNotificationPreferences(c.env.DB, user.id), Promise.resolve(mailProviderStatus(mailEnvOf(c)))])
      await touchSession(c.env.DB, await currentSessionPublicId(c.env.DB, readSessionToken(c)))
      return c.json({ user: profile, notificationPreferences: preferences, emailDelivery: mail })
    })
  )

  app.patch('/api/v1/me', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const body = await readBody(c)
      const profile = await updateProfileName(c.env.DB, user.id, body.name)
      return c.json({ ok: true, user: profile })
    })
  )

  // -------------------------------------------------------------------------
  // Email verification + change (CUS-01 / CUS-03)
  // -------------------------------------------------------------------------
  app.post('/api/v1/me/verify-email', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      if (await limited(c, 'verify-email', 5, 3600, String(user.id))) throw new DomainError('rate_limited', 'Too many requests. Please try again later.', 429)
      const profile = await getProfile(c.env.DB, user.id)
      if (profile.emailVerified) return c.json({ ok: true, alreadyVerified: true, deliveryStatus: 'skipped', limitation: null })
      const result = await sendVerificationEmail(c.env.DB, mailEnvOf(c), {
        userId: user.id,
        email: profile.email,
        name: profile.name,
        baseUrl: originOfRequest(c),
        correlationId: c.get('requestId') || undefined
      })
      return c.json({
        ok: true,
        alreadyVerified: false,
        // Truthful: 'suppressed' means nothing was delivered in this deployment.
        deliveryStatus: result.deliveryStatus,
        delivered: result.sent,
        limitation: result.limitation
      })
    })
  )

  app.post('/api/v1/me/email', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      if (await limited(c, 'email-change', 5, 3600, String(user.id))) throw new DomainError('rate_limited', 'Too many requests. Please try again later.', 429)
      const body = await readBody(c)
      // Re-authenticate with the current password: an email change from a
      // hijacked session must not be possible with a stolen cookie alone.
      const row = await c.env.DB.prepare('SELECT email, password_hash FROM users WHERE id = ?').bind(user.id).first<{ email: string; password_hash: string }>()
      if (!row) throw new DomainError('not_found', 'Not found.', 404)
      const { verifyPassword } = await import('../auth')
      if (!(await verifyPassword(String(body.currentPassword ?? ''), row.password_hash))) {
        throw new DomainError('reauth_failed', 'That password is not correct.', 403)
      }
      const result = await requestEmailChange(c.env.DB, mailEnvOf(c), {
        userId: user.id,
        currentEmail: row.email,
        newEmail: String(body.newEmail ?? ''),
        name: user.name,
        baseUrl: originOfRequest(c),
        correlationId: c.get('requestId') || undefined
      })
      return c.json({ ok: true, requested: true, deliveryStatus: result.deliveryStatus, limitation: result.limitation })
    })
  )

  app.post('/api/v1/me/email/confirm', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const body = await readBody(c)
      const result = await confirmEmailChange(c.env.DB, mailEnvOf(c), String(body.token ?? ''), user.id)
      return c.json({ ok: true, previousEmail: result.previousEmail, email: result.newEmail })
    })
  )

  // -------------------------------------------------------------------------
  // Sessions (CUS-02)
  // -------------------------------------------------------------------------
  app.get('/api/v1/me/sessions', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const current = await currentSessionPublicId(c.env.DB, readSessionToken(c))
      await touchSession(c.env.DB, current)
      return c.json({ sessions: await listSessions(c.env.DB, user.id, current) })
    })
  )

  app.delete('/api/v1/me/sessions/:id', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const publicId = requireSessionId(c.req.param('id'))
      const current = await currentSessionPublicId(c.env.DB, readSessionToken(c))
      const result = await revokeSession(c.env.DB, user.id, publicId, current)
      if (!result.revoked) throw new DomainError('not_found', 'Not found.', 404)
      await recordSecurityEvent(c.env.DB, { userId: user.id, eventType: 'session_revoked', sessionPublicId: current, metadata: { revoked: publicId } })
      return c.json({ ok: true, wasCurrent: result.wasCurrent })
    })
  )

  app.post('/api/v1/me/sessions/revoke-others', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const current = await currentSessionPublicId(c.env.DB, readSessionToken(c))
      const revoked = await revokeOtherSessions(c.env.DB, user.id, current)
      if (revoked > 0) await recordSecurityEvent(c.env.DB, { userId: user.id, eventType: 'sessions_revoked', sessionPublicId: current, metadata: { revoked } })
      return c.json({ ok: true, revoked })
    })
  )

  app.get('/api/v1/me/security-events', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const rows = await listSecurityEvents(c.env.DB, user.id, Number(c.req.query('limit') ?? 25))
      return c.json({
        events: rows.map((r) => ({
          id: Number(r.id),
          eventType: r.event_type,
          title: securityEventLabel(r.event_type).title,
          summary: securityEventLabel(r.event_type).summary,
          createdAt: r.created_at,
          actorType: r.actor_type,
          // A network digest, never an address.
          sameNetworkRef: r.ip_hash ? r.ip_hash.slice(0, 8) : null
        }))
      })
    })
  )

  // -------------------------------------------------------------------------
  // Notification preferences (CUS-13)
  // -------------------------------------------------------------------------
  app.get('/api/v1/me/notifications', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      return c.json({ preferences: await getNotificationPreferences(c.env.DB, user.id), emailDelivery: mailProviderStatus(mailEnvOf(c)) })
    })
  )

  app.patch('/api/v1/me/notifications', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const body = await readBody(c)
      const preferences = await updateNotificationPreferences(c.env.DB, user.id, body)
      return c.json({ ok: true, preferences })
    })
  )

  // -------------------------------------------------------------------------
  // Verified guest claiming (CUS-04)
  // -------------------------------------------------------------------------
  app.get('/api/v1/me/claims', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const profile = await getProfile(c.env.DB, user.id)
      return c.json({
        claims: await listClaimsForUser(c.env.DB, user.id),
        claimable: await claimableForUser(c.env.DB, user.id, profile.email),
        emailVerified: profile.emailVerified,
        emailDelivery: mailProviderStatus(mailEnvOf(c))
      })
    })
  )

  app.post('/api/v1/me/claims', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      if (await limited(c, 'guest-claim', 5, 3600, String(user.id))) throw new DomainError('rate_limited', 'Too many requests. Please try again later.', 429)
      const body = await readBody(c)
      // Email knowledge alone NEVER claims anything — this only asks us to send a
      // single-use link to the address, and the response is identical whether or
      // not that address has any order (no enumeration signal either way).
      await requestGuestClaim(c.env.DB, { ...mailEnvOf(c), ...c.env }, {
        userId: user.id,
        name: user.name,
        email: String(body.email ?? ''),
        baseUrl: originOfRequest(c),
        correlationId: c.get('requestId') || undefined
      })
      return c.json({ ok: true, message: 'If that address has an order that can be added, we have sent a single-use confirmation link to it.' })
    })
  )

  app.post('/api/v1/me/claims/confirm', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const body = await readBody(c)
      const outcome = await confirmGuestClaim(c.env.DB, { ...mailEnvOf(c), ...c.env }, { userId: user.id, rawToken: String(body.token ?? '') })
      return c.json({ ok: true, claimedOrders: outcome.claimedOrders, claimedBooks: outcome.claimedBooks, verifiedEmail: outcome.verifiedEmail })
    })
  )

  app.post('/api/v1/me/claims/order', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const body = await readBody(c)
      const outcome = await claimOrderWithCapability(c.env.DB, { ...mailEnvOf(c), ...c.env }, {
        userId: user.id,
        orderId: Number(body.orderId),
        guestToken: String(body.guestToken ?? body.token ?? '')
      })
      return c.json({ ok: true, claimedOrders: outcome.claimedOrders, claimedBooks: outcome.claimedBooks })
    })
  )

  // -------------------------------------------------------------------------
  // My books (CUS-05 / CUS-07 / CUS-08 / CUS-09 / GEN-09)
  // -------------------------------------------------------------------------
  app.get('/api/v1/my/books', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      return c.json({ books: await listMyBooks(c.env.DB, user.id), revisionPolicy: revisionPolicy(c.env) })
    })
  )

  app.get('/api/v1/my/books/:id', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const detail = await getMyBookDetail(c.env.DB, user.id, String(c.req.param('id')))
      return c.json({ ...detail, revisionPolicy: revisionPolicy(c.env) })
    })
  )

  app.post('/api/v1/my/books/:id/revisions', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      if (await limited(c, 'revision-request', 10, 3600, String(user.id))) throw new DomainError('rate_limited', 'Too many change requests right now. Please try again later.', 429)
      const body = await readBody(c)
      const result = await requestStructuredRevision(c.env.DB, c.env, user.id, String(c.req.param('id')), {
        reasonCode: body.reasonCode,
        notes: body.notes,
        previewVersion: body.previewVersion,
        replacementPhotoKey: body.replacementPhotoKey,
        correlationId: c.get('requestId') || undefined
      })
      return c.json({ ok: true, ...result })
    })
  )

  app.post('/api/v1/my/books/:id/approvals', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const body = await readBody(c)
      const previewVersionId = Number(body.previewVersionId)
      if (!Number.isInteger(previewVersionId) || previewVersionId < 1) {
        throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, { previewVersionId: 'is required' })
      }
      const result = await approveExactVersion(c.env.DB, user.id, String(c.req.param('id')), previewVersionId)
      return c.json({ ok: true, ...result })
    })
  )

  app.post('/api/v1/my/books/:id/generations', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      if (await limited(c, 'generation-request', 30, 3600, String(user.id))) throw new DomainError('rate_limited', 'Too many generation requests right now. Please try again later.', 429)
      const result = await requestGenerationForOwnedBook(c.env.DB, c.env, user.id, String(c.req.param('id')), c.get('requestId') || '')
      return c.json({ ok: true, ...result })
    })
  )

  // -------------------------------------------------------------------------
  // Downloads (CUS-11)
  // -------------------------------------------------------------------------
  app.get('/api/v1/my/downloads', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      return c.json({ downloads: await listMyDownloads(c.env.DB, user.id), tokenTtlSeconds: DOWNLOAD_TOKEN_TTL_SECONDS })
    })
  )

  /**
   * Mints ONE short-lived single-use token. The token is returned ONLY in this
   * response — never written into a page, never stored in localStorage, never
   * logged — and the client is expected to use it immediately.
   */
  app.post('/api/v1/my/downloads/:id/token', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      if (await limited(c, 'download-token', 60, 3600, String(user.id))) throw new DomainError('rate_limited', 'Too many downloads right now. Please slow down.', 429)
      const minted = await mintDownloadToken(c.env.DB, user.id, String(c.req.param('id')))
      return c.json({
        ok: true,
        entitlementId: minted.entitlement.id,
        // Relative, and deliberately not an absolute URL: nothing here is
        // shareable or permanent.
        url: `/api/v1/downloads/${minted.token}`,
        expiresAt: new Date(minted.expiresAt * 1000).toISOString(),
        ttlSeconds: DOWNLOAD_TOKEN_TTL_SECONDS,
        entitlement: minted.entitlement
      })
    })
  )

  /**
   * The delivery route. The token itself is the capability — self-contained,
   * hashed at rest, single-use and valid for two minutes — so no session cookie is
   * required, and no redirect chain can leak a session.
   */
  app.get('/api/v1/downloads/:token', async (c: Ctx) =>
    withErrors(c, async () => {
      const result = await redeemDownloadToken(c.env.DB, c.env.PHOTOS ? r2AssetReader(c.env.PHOTOS) : undefined, String(c.req.param('token')), {
        watermarkLabel: brand().name,
        ipDigest: await callerIpDigest(c)
      })
      if (!result.ok) {
        return c.json({ error: { code: result.code, message: result.message } }, result.status as never)
      }
      const headers = new Headers()
      headers.set('Content-Type', result.artifact.contentType)
      headers.set('Content-Disposition', `attachment; filename="${result.artifact.filename}"`)
      // A delivered artifact is never stored by a cache, never sniffed into
      // another type, and never followed by a referrer that carries the token.
      headers.set('Cache-Control', 'private, no-store, max-age=0')
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('Content-Length', String(result.artifact.bytes.byteLength))
      return new Response(result.artifact.bytes as unknown as BodyInit, { headers })
    })
  )

  // -------------------------------------------------------------------------
  // Support (CUS-12)
  // -------------------------------------------------------------------------
  app.get('/api/v1/support/tickets', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      return c.json({ tickets: await listMyTickets(c.env.DB, user.id) })
    })
  )

  app.post('/api/v1/support/tickets', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      if (await limited(c, 'support-ticket', 10, 3600, String(user.id))) throw new DomainError('rate_limited', 'Too many support requests right now. Please try again later.', 429)
      const body = await readBody(c)
      const attachment = await readAttachmentFromBody(body)
      // Validate the text fields BEFORE anything is written.
      validateTicketInput({ subject: body.subject, category: body.category, body: body.body })
      const result = await createTicket(c.env.DB, c.env.PHOTOS, {
        userId: user.id,
        subject: body.subject,
        category: body.category,
        body: body.body,
        orderId: body.orderId,
        attachment,
        correlationId: c.get('requestId') || undefined
      })
      await recordSecurityEvent(c.env.DB, { userId: user.id, eventType: 'support_ticket_created', metadata: { ticket: result.ticket.id, attachment: !!result.attachmentId } })
      return c.json({ ok: true, ticket: result.ticket, attachmentId: result.attachmentId }, 201)
    })
  )

  app.get('/api/v1/support/tickets/:id', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      return c.json(await getMyTicket(c.env.DB, user.id, String(c.req.param('id'))))
    })
  )

  app.post('/api/v1/support/tickets/:id/messages', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      if (await limited(c, 'support-message', 60, 3600, String(user.id))) throw new DomainError('rate_limited', 'Too many messages right now. Please slow down.', 429)
      const body = await readBody(c)
      const attachment = await readAttachmentFromBody(body)
      const result = await addCustomerMessage(c.env.DB, c.env.PHOTOS, {
        userId: user.id,
        publicId: String(c.req.param('id')),
        body: body.body,
        attachment,
        correlationId: c.get('requestId') || undefined
      })
      return c.json({ ok: true, ticket: result.ticket, messageId: result.messageId, attachmentId: result.attachmentId })
    })
  )

  app.post('/api/v1/support/tickets/:id/status', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const body = await readBody(c)
      const ticket = await setTicketStatus(c.env.DB, { userId: user.id, publicId: String(c.req.param('id')), to: String(body.to ?? ''), correlationId: c.get('requestId') || undefined })
      return c.json({ ok: true, ticket })
    })
  )

  /** Attachment bytes: ownership checked against the ticket, always an attachment, never rendered. */
  app.get('/api/v1/support/attachments/:id', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      if (!c.env.PHOTOS) return c.notFound()
      const row = await loadOwnedAttachment(c.env.DB, user.id, String(c.req.param('id')))
      if (!row) return c.notFound()
      const object = await c.env.PHOTOS.get(row.object_key)
      if (!object) return c.notFound()
      const headers = new Headers()
      // The stored type is the validated allowlist value, never the client's claim.
      headers.set('Content-Type', row.content_type)
      headers.set('Content-Disposition', `attachment; filename="${row.original_name.replace(/["\\]/g, '')}"`)
      headers.set('Cache-Control', 'private, no-store')
      headers.set('X-Content-Type-Options', 'nosniff')
      // Belt and braces: even if a hostile file ever reached this route, a
      // sandboxed response cannot run script or reach this origin.
      headers.set('Content-Security-Policy', "sandbox; default-src 'none'")
      return new Response(object.body as unknown as BodyInit, { headers })
    })
  )

  // -------------------------------------------------------------------------
  // Privacy intake (CUS-14)
  // -------------------------------------------------------------------------
  app.get('/api/v1/privacy/requests', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const requests = await listPrivacyRequests(c.env.DB, user.id)
      return c.json({ requests, emailDelivery: mailProviderStatus(mailEnvOf(c)) })
    })
  )

  const createPrivacy = (kind: 'export' | 'delete') => async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      if (await limited(c, `privacy-${kind}`, 5, 3600, String(user.id))) throw new DomainError('rate_limited', 'Too many requests. Please try again later.', 429)
      const body = await readBody(c)
      const result = await createPrivacyRequest(c.env.DB, mailEnvOf(c), { userId: user.id, kind, note: body.note, correlationId: c.get('requestId') || undefined })
      return c.json({ ok: true, request: result.request, created: result.created, deliveryStatus: result.deliveryStatus, limitation: result.limitation })
    })
  app.post('/api/v1/privacy/export', createPrivacy('export'))
  app.post('/api/v1/privacy/delete', createPrivacy('delete'))

  app.post('/api/v1/privacy/requests/:id/cancel', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const request = await cancelPrivacyRequest(c.env.DB, user.id, String(c.req.param('id')))
      return c.json({ ok: true, request })
    })
  )

  // -------------------------------------------------------------------------
  // Receipt (CUS-10) — a read-only rendering of the ledger
  // -------------------------------------------------------------------------
  app.get('/api/v1/my/orders/:id/receipt', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = accountUser(c)
      const id = Number(c.req.param('id'))
      if (!Number.isInteger(id) || id <= 0) throw new DomainError('not_found', 'Not found.', 404)
      const detail = await getCustomerOrder(c.env.DB, user.id, id)
      if (!detail) throw new DomainError('not_found', 'Not found.', 404)
      return c.json({
        orderId: detail.order.id,
        status: detail.order.status,
        paymentStatus: detail.order.payment_status,
        currency: detail.order.currency,
        totals: {
          subtotalMinor: Number(detail.order.subtotal_minor ?? 0),
          discountMinor: Number(detail.order.discount_minor ?? 0),
          shippingMinor: Number(detail.order.shipping_minor ?? 0),
          taxMinor: Number(detail.order.tax_minor ?? 0),
          totalMinor: Number(detail.order.total_minor ?? 0),
          capturedMinor: Number(detail.order.amount_captured_minor ?? 0),
          refundedMinor: Number(detail.order.amount_refunded_minor ?? 0),
          outstandingMinor: detail.order.outstandingMinor
        },
        items: detail.items,
        payments: detail.payments,
        refunds: detail.refunds,
        note: detail.receipts.reason
      })
    })
  )

  // -------------------------------------------------------------------------
  // Truthful platform capability report (never a credential)
  // -------------------------------------------------------------------------
  app.get('/api/v1/platform/capabilities', async (c: Ctx) =>
    withErrors(c, async () => {
      const mail = mailProviderStatus(mailEnvOf(c))
      const outbox = await outboxCounts(c.env.DB).catch(() => null)
      return c.json({
        email: {
          provider: mail.provider,
          deliveryMode: mail.deliveryMode,
          deliversRealMail: mail.deliversRealMail,
          detail: mail.detail
        },
        emailOutbox: outbox,
        limitations: [
          ...(mail.deliveryMode === 'disabled' ? ['No email provider is configured, so nothing is delivered (queued messages are recorded as suppressed).'] : []),
          ...(mail.deliveryMode !== 'live' ? ['No real email is sent in this environment.'] : []),
          'A print-ready PDF is not produced yet, so downloads are the watermarked preview pages.',
          'Privacy export and deletion requests are recorded for a person to action; they are not automatic yet.'
        ]
      })
    })
  )
}
