// V2 Phase 5 — the server-rendered customer account pages and their form
// handlers.
//
// WHY FORMS AND NOT FETCH: every action here is an ordinary HTML form POST, with
// the double-submit CSRF token injected into each form by the middleware in
// src/index.tsx. That means each flow works from an email link, works with
// JavaScript disabled, is reachable by the accessibility pass, and cannot
// silently fail behind a script error. The JSON surface in src/account/routes.ts
// calls the SAME services, so there is one implementation of every rule.
//
// Every POST answers with a redirect carrying an outcome message, so a reload
// never re-submits and the outcome is visible as text (never colour alone).
import type { Context, Hono } from 'hono'
import { html, htmlNotFound } from '../page-context'
import { DomainError } from '../generation/types'
import { readSessionToken, currentSessionPublicId, requireAuth, type AuthUser } from '../auth'
import { rateLimitKey } from '../security'
import { consumeRateLimit } from '../rate-limit'
import { mailProviderStatus } from '../mail/provider'
import { getProfile, updateProfileName, getNotificationPreferences, updateNotificationPreferences, sendVerificationEmail, requestEmailChange, confirmEmailChange } from './profile'
import { listSessions, revokeSession, revokeOtherSessions, requireSessionId } from './sessions'
import { listSecurityEvents, securityEventLabel, recordSecurityEvent } from './security'
import { listMyBooks, getMyBookDetail, requestStructuredRevision, approveExactVersion, requestGenerationForOwnedBook, revisionPolicy } from './library'
import { listMyDownloads, mintDownloadToken } from './downloads'
import { createTicket, listMyTickets, getMyTicket, addCustomerMessage, setTicketStatus, readAttachmentFromBody } from './support'
import { createPrivacyRequest, listPrivacyRequests, cancelPrivacyRequest } from './privacy'
import { listClaimsForUser, claimableForUser, requestGuestClaim, confirmGuestClaim, claimOrderWithCapability } from './claims'
import { getCustomerOrder, listCustomerOrders, paymentStatusLabel } from './orders'
import { verifyEmail } from './profile'
import { initiateUpload, completeUpload, ownerToken } from '../personalization/uploads'
import type { Owner } from '../personalization/ownership'
import { validateAddress } from '../commerce/checkout'
import {
  accountOverviewPage,
  accountProfilePage,
  accountAddressesPage,
  accountSecurityPage,
  accountNotificationsPage,
  myBooksLibraryPage,
  myPreviewPage,
  myDownloadsPage,
  supportListPage,
  supportTicketPage,
  accountClaimsPage,
  accountPrivacyPage,
  receiptPage,
  tokenResultPage,
  type AddressView
} from './pages'
import { mailEnvOf, originOfRequest, callerIpDigest, withErrors, type AccountBindings, type Ctx } from './routes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The signed-in customer, or a redirect to the login page carrying a return path. */
function pageUser(c: Ctx, returnTo: string): AuthUser | Response {
  const auth = requireAuth(c)
  if (auth instanceof Response) return c.redirect(`/login?next=${encodeURIComponent(returnTo)}`)
  return auth
}

function messageFrom(c: Ctx): { message: string; isError: boolean } | undefined {
  const error = c.req.query('error')
  if (error) return { message: error, isError: true }
  const ok = c.req.query('ok')
  if (ok) return { message: ok, isError: false }
  return undefined
}

/** Redirect back to a page with a human-readable outcome. Never re-renders a POST. */
function backTo(c: Ctx, path: string, outcome: { ok?: string; error?: string }): Response {
  const url = new URL(path, originOfRequest(c))
  if (outcome.ok) url.searchParams.set('ok', outcome.ok)
  if (outcome.error) url.searchParams.set('error', outcome.error)
  return c.redirect(url.pathname + url.search)
}

/** Turns a domain failure into a message a person can read, for a form POST. */
function outcomeMessage(err: unknown): string {
  if (err instanceof DomainError) {
    if (err.fields) {
      const parts = Object.entries(err.fields).map(([field, problem]) => `${field}: ${problem}`)
      return `${err.message} (${parts.join('; ')})`
    }
    return err.message
  }
  return 'Something went wrong. Please try again.'
}

async function guardLimit(c: Ctx, action: string, max: number, windowSeconds: number, identity?: string | null): Promise<boolean> {
  const result = await consumeRateLimit(c.env.DB, rateLimitKey(action, c, identity), { max, windowSeconds })
  return result.limited
}

/** Reads a form body, JSON body or multipart body depending on what arrived. */
async function readForm(c: Ctx): Promise<Record<string, unknown>> {
  const contentType = (c.req.header('content-type') || '').toLowerCase()
  if (contentType.includes('application/json')) return (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>
  if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
    return (await c.req.parseBody()) as unknown as Record<string, unknown>
  }
  return {}
}

type AccountEnv = AccountBindings & { DB: D1Database; PHOTOS?: R2Bucket }

function userOwner(user: AuthUser): Owner {
  return { type: 'user', userId: user.id }
}

/**
 * Stores a photo submitted through a server-rendered form using the SAME
 * two-phase upload lifecycle the JSON API uses, so a replacement photo is
 * validated by exactly the same byte-level policy as every other upload.
 */
async function storeFormPhoto(c: Ctx, user: AuthUser, file: File): Promise<string> {
  if (!c.env.PHOTOS) throw new DomainError('storage_unavailable', 'Photo storage is unavailable, so the photo was not saved.', 503)
  const owner = userOwner(user)
  const initiated = await initiateUpload(c.env.DB, owner, { contentType: file.type || '', byteSize: file.size })
  const bytes = new Uint8Array(await file.arrayBuffer())
  const image = await completeUpload(c.env.DB, owner, initiated.uploadKey, initiated.completionToken, bytes)
  await c.env.PHOTOS.put(initiated.uploadKey, bytes, { httpMetadata: { contentType: image.format === 'png' ? 'image/png' : 'image/jpeg' } })
  return initiated.uploadKey
}

function photoFileFrom(body: Record<string, unknown>, field: string): File | null {
  const value = body[field]
  if (value instanceof File && value.size > 0) return value
  return null
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerAccountWebRoutes(app: Hono<any>): void {
  // ---- Overview -----------------------------------------------------------
  app.get('/account', async (c: Ctx) => {
    const user = pageUser(c, '/account')
    if (user instanceof Response) return user
    const [profile, orders, books, tickets, privacy, claims, downloads] = await Promise.all([
      getProfile(c.env.DB, user.id),
      listCustomerOrders(c.env.DB, user.id),
      listMyBooks(c.env.DB, user.id),
      listMyTickets(c.env.DB, user.id),
      listPrivacyRequests(c.env.DB, user.id),
      listClaimsForUser(c.env.DB, user.id),
      listMyDownloads(c.env.DB, user.id)
    ])
    return html(
      c,
      'Your account',
      accountOverviewPage({
        profile,
        orders: orders.map((o) => ({ id: o.id, status: o.status, totalLabel: o.totalLabel, itemCount: o.itemCount, createdAt: o.created_at, paymentStatus: paymentStatusLabel(o.payment_status) })),
        books,
        openTickets: tickets.filter((t) => !['closed'].includes(t.status)).length,
        openPrivacy: privacy.filter((p) => p.open).length,
        claims: claims.length,
        downloadsAvailable: downloads.filter((d) => d.downloadable).length,
        mailStatus: mailProviderStatus(mailEnvOf(c)),
        notice: messageFrom(c)
      }),
      '/account'
    )
  })

  // ---- Profile -----------------------------------------------------------
  app.get('/account/profile', async (c: Ctx) => {
    const user = pageUser(c, '/account/profile')
    if (user instanceof Response) return user
    const profile = await getProfile(c.env.DB, user.id)
    return html(c, 'Profile', accountProfilePage({ profile, mailStatus: mailProviderStatus(mailEnvOf(c)), notice: messageFrom(c) }), '/account')
  })

  app.post('/account/profile', async (c: Ctx) => {
    const user = pageUser(c, '/account/profile')
    if (user instanceof Response) return user
    const body = await readForm(c)
    try {
      await updateProfileName(c.env.DB, user.id, body.name)
      return backTo(c, '/account/profile', { ok: 'Your name was saved.' })
    } catch (err) {
      return backTo(c, '/account/profile', { error: outcomeMessage(err) })
    }
  })

  app.post('/account/verify-email', async (c: Ctx) => {
    const user = pageUser(c, '/account/profile')
    if (user instanceof Response) return user
    if (await guardLimit(c, 'verify-email', 5, 3600, String(user.id))) return backTo(c, '/account/profile', { error: 'Too many requests. Please try again later.' })
    const profile = await getProfile(c.env.DB, user.id)
    if (profile.emailVerified) return backTo(c, '/account/profile', { ok: 'Your email address is already confirmed.' })
    const result = await sendVerificationEmail(c.env.DB, mailEnvOf(c), { userId: user.id, email: profile.email, name: profile.name, baseUrl: originOfRequest(c) })
    // The outcome names what actually happened, including "we could not send it".
    if (result.sent) return backTo(c, '/account/profile', { ok: 'A confirmation link has been sent. Open it to confirm your address.' })
    return backTo(c, '/account/profile', { error: `The confirmation link could not be delivered. ${result.deliveryDetail}` })
  })

  app.post('/account/email', async (c: Ctx) => {
    const user = pageUser(c, '/account/profile')
    if (user instanceof Response) return user
    if (await guardLimit(c, 'email-change', 5, 3600, String(user.id))) return backTo(c, '/account/profile', { error: 'Too many requests. Please try again later.' })
    const body = await readForm(c)
    const row = await c.env.DB.prepare('SELECT email, password_hash FROM users WHERE id = ?').bind(user.id).first<{ email: string; password_hash: string }>()
    if (!row) return backTo(c, '/account/profile', { error: 'Your account could not be loaded.' })
    const { verifyPassword } = await import('../auth')
    if (!(await verifyPassword(String(body.currentPassword ?? ''), row.password_hash))) {
      return backTo(c, '/account/profile', { error: 'That password is not correct, so the email address was not changed.' })
    }
    try {
      const result = await requestEmailChange(c.env.DB, mailEnvOf(c), {
        userId: user.id,
        currentEmail: row.email,
        newEmail: String(body.newEmail ?? ''),
        name: user.name,
        baseUrl: originOfRequest(c)
      })
      if (result.deliveryStatus === 'sent') {
        return backTo(c, '/account/profile', { ok: 'We sent a confirmation link to the new address. Your email address has not changed yet.' })
      }
      return backTo(c, '/account/profile', { error: `The confirmation link could not be delivered, so your email address has not changed. ${result.deliveryDetail}` })
    } catch (err) {
      return backTo(c, '/account/profile', { error: outcomeMessage(err) })
    }
  })

  // ---- Email-link landing pages (no session needed for verification) ------
  app.get('/verify-email', async (c: Ctx) => {
    const token = String(c.req.query('token') ?? '')
    let verified: { userId: number; email: string } | null = null
    try {
      verified = await verifyEmail(c.env.DB, mailEnvOf(c), token)
    } catch {
      verified = null
    }
    if (!verified) {
      return html(
        c,
        'Confirm your email',
        tokenResultPage({
          title: 'Confirm your email',
          heading: 'This link cannot be used',
          body: 'This confirmation link is invalid, has expired, or has already been used. Sign in and send a new one from your profile.',
          isError: true,
          links: [{ href: '/account/profile', label: 'Go to my profile' }]
        }),
        '/account'
      )
    }
    return html(
      c,
      'Email confirmed',
      tokenResultPage({
        title: 'Email confirmed',
        heading: 'Your email address is confirmed',
        body: `Thank you — ${verified.email} is now a confirmed address on your account.`,
        isError: false,
        links: [
          { href: '/account', label: 'Go to my account' },
          { href: '/account/claims', label: 'Add a guest order' }
        ]
      }),
      '/account'
    )
  })

  app.get('/account/confirm-email', async (c: Ctx) => {
    const user = pageUser(c, '/account/profile')
    if (user instanceof Response) return user
    const token = String(c.req.query('token') ?? '')
    try {
      const result = await confirmEmailChange(c.env.DB, mailEnvOf(c), token, user.id)
      return html(
        c,
        'Email changed',
        tokenResultPage({
          title: 'Email changed',
          heading: 'Your email address was changed',
          body: `Your account now uses ${result.newEmail}. A notice was sent to the previous address.`,
          isError: false,
          links: [{ href: '/account/profile', label: 'Go to my profile' }]
        }),
        '/account'
      )
    } catch (err) {
      return html(
        c,
        'Email change',
        tokenResultPage({
          title: 'Email change',
          heading: 'This link cannot be used',
          body: outcomeMessage(err),
          isError: true,
          links: [{ href: '/account/profile', label: 'Go to my profile' }]
        }),
        '/account'
      )
    }
  })

  app.get('/account/confirm-claim', async (c: Ctx) => {
    const user = pageUser(c, '/account/claims')
    if (user instanceof Response) return user
    const token = String(c.req.query('token') ?? '')
    try {
      const outcome = await confirmGuestClaim(c.env.DB, { ...mailEnvOf(c), ...c.env }, { userId: user.id, rawToken: token })
      const added = outcome.claimedOrders.length
      return html(
        c,
        'Guest order added',
        tokenResultPage({
          title: 'Guest order added',
          heading: added ? 'Your order is now on your account' : 'Nothing left to add',
          body: added
            ? `${added} order${added === 1 ? '' : 's'} placed with ${outcome.verifiedEmail} ${added === 1 ? 'was' : 'were'} added to your account, along with the personalised books they were built from.`
            : `We confirmed ${outcome.verifiedEmail}, but there was no unclaimed guest order left on that address — it may already have been added.`,
          isError: false,
          links: [
            { href: '/my-books', label: 'View my orders' },
            { href: '/my/books', label: 'View my books' }
          ]
        }),
        '/account'
      )
    } catch (err) {
      return html(
        c,
        'Guest order claim',
        tokenResultPage({ title: 'Guest order claim', heading: 'This link cannot be used', body: outcomeMessage(err), isError: true, links: [{ href: '/account/claims', label: 'Back to guest orders' }] }),
        '/account'
      )
    }
  })

  // ---- Addresses (CUS-03) ------------------------------------------------
  app.get('/account/addresses', async (c: Ctx) => {
    const user = pageUser(c, '/account/addresses')
    if (user instanceof Response) return user
    const rows = (await c.env.DB.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default_shipping DESC, id DESC').bind(user.id).all<Record<string, unknown>>()).results || []
    return html(c, 'Addresses', accountAddressesPage(rows.map(addressViewFromRow), messageFrom(c)), '/account')
  })

  app.post('/account/addresses', async (c: Ctx) => {
    const user = pageUser(c, '/account/addresses')
    if (user instanceof Response) return user
    const body = await readForm(c)
    const parsed = validateAddress(body, 'Address')
    if (!parsed.ok) return backTo(c, '/account/addresses', { error: parsed.error })
    const a = parsed.address
    const publicId = 'ad_' + crypto.randomUUID().replace(/-/g, '')
    const makeDefault = body.isDefaultShipping === '1' || body.isDefaultShipping === true || body.isDefaultShipping === 'true'
    await c.env.DB.batch([
      makeDefault ? c.env.DB.prepare('UPDATE addresses SET is_default_shipping = 0 WHERE user_id = ? AND is_default_shipping = 1').bind(user.id) : c.env.DB.prepare('SELECT 1'),
      c.env.DB
        .prepare(
          `INSERT INTO addresses (public_id, user_id, label, full_name, line1, line2, city, region, postal_code, country, phone, is_default_shipping, is_default_billing)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
        )
        .bind(publicId, user.id, String(body.label || '').slice(0, 40), a.fullName, a.line1, a.line2 || '', a.city, a.region || '', a.postalCode || '', a.country, a.phone || '', makeDefault ? 1 : 0)
    ])
    return backTo(c, '/account/addresses', { ok: 'Address saved.' })
  })

  app.post('/account/addresses/:id/default', async (c: Ctx) => {
    const user = pageUser(c, '/account/addresses')
    if (user instanceof Response) return user
    const existing = await c.env.DB.prepare('SELECT id FROM addresses WHERE public_id = ? AND user_id = ?').bind(c.req.param('id'), user.id).first()
    if (!existing) return backTo(c, '/account/addresses', { error: 'That address was not found.' })
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE addresses SET is_default_shipping = 0 WHERE user_id = ? AND is_default_shipping = 1').bind(user.id),
      c.env.DB.prepare('UPDATE addresses SET is_default_shipping = 1, updated_at = CURRENT_TIMESTAMP WHERE public_id = ? AND user_id = ?').bind(c.req.param('id'), user.id)
    ])
    return backTo(c, '/account/addresses', { ok: 'Default shipping address updated.' })
  })

  app.post('/account/addresses/:id/delete', async (c: Ctx) => {
    const user = pageUser(c, '/account/addresses')
    if (user instanceof Response) return user
    const result = await c.env.DB.prepare('DELETE FROM addresses WHERE public_id = ? AND user_id = ?').bind(c.req.param('id'), user.id).run()
    if (Number(result.meta?.changes ?? 0) === 0) return backTo(c, '/account/addresses', { error: 'That address was not found.' })
    return backTo(c, '/account/addresses', { ok: 'Address removed.' })
  })

  // ---- Security (CUS-02) -------------------------------------------------
  app.get('/account/security', async (c: Ctx) => {
    const user = pageUser(c, '/account/security')
    if (user instanceof Response) return user
    const token = readSessionToken(c)
    const current = await currentSessionPublicId(c.env.DB, token)
    const sessions = await listSessions(c.env.DB, user.id, current)
    const events = await listSecurityEvents(c.env.DB, user.id, 25)
    return html(
      c,
      'Security',
      accountSecurityPage({ sessions, events: events.map((e) => ({ ...e, label: securityEventLabel(e.event_type) })), notice: messageFrom(c) }),
      '/account'
    )
  })

  app.post('/account/security/revoke', async (c: Ctx) => {
    const user = pageUser(c, '/account/security')
    if (user instanceof Response) return user
    const body = await readForm(c)
    let publicId: string
    try {
      publicId = requireSessionId(String(body.sessionId ?? ''))
    } catch {
      return backTo(c, '/account/security', { error: 'That session was not found.' })
    }
    const current = await currentSessionPublicId(c.env.DB, readSessionToken(c))
    const result = await revokeSession(c.env.DB, user.id, publicId, current)
    if (!result.revoked) return backTo(c, '/account/security', { error: 'That session was not found.' })
    await recordSecurityEvent(c.env.DB, { userId: user.id, eventType: 'session_revoked', sessionPublicId: current, metadata: { revoked: publicId } })
    return backTo(c, '/account/security', { ok: 'That session was signed out.' })
  })

  app.post('/account/security/revoke-others', async (c: Ctx) => {
    const user = pageUser(c, '/account/security')
    if (user instanceof Response) return user
    const current = await currentSessionPublicId(c.env.DB, readSessionToken(c))
    const revoked = await revokeOtherSessions(c.env.DB, user.id, current)
    if (revoked > 0) await recordSecurityEvent(c.env.DB, { userId: user.id, eventType: 'sessions_revoked', sessionPublicId: current, metadata: { revoked } })
    return backTo(c, '/account/security', { ok: revoked ? `${revoked} other session${revoked === 1 ? '' : 's'} signed out.` : 'There were no other sessions to sign out.' })
  })

  // ---- Notifications (CUS-13) -------------------------------------------
  app.get('/account/notifications', async (c: Ctx) => {
    const user = pageUser(c, '/account/notifications')
    if (user instanceof Response) return user
    const prefs = await getNotificationPreferences(c.env.DB, user.id)
    return html(c, 'Notifications', accountNotificationsPage(prefs, mailProviderStatus(mailEnvOf(c)), messageFrom(c)), '/account')
  })

  app.post('/account/notifications', async (c: Ctx) => {
    const user = pageUser(c, '/account/notifications')
    if (user instanceof Response) return user
    const body = await readForm(c)
    const asBool = (value: unknown) => value === '1' || value === 'on' || value === true || value === 'true'
    await updateNotificationPreferences(c.env.DB, user.id, {
      orderUpdates: asBool(body.orderUpdates),
      generationUpdates: asBool(body.generationUpdates),
      supportUpdates: asBool(body.supportUpdates),
      productNews: asBool(body.productNews)
    })
    return backTo(c, '/account/notifications', { ok: 'Notification settings saved. Account security notices are always sent and cannot be switched off.' })
  })

  // ---- Support (CUS-12) --------------------------------------------------
  app.get('/account/support', async (c: Ctx) => {
    const user = pageUser(c, '/account/support')
    if (user instanceof Response) return user
    const [tickets, orders] = await Promise.all([listMyTickets(c.env.DB, user.id), listCustomerOrders(c.env.DB, user.id)])
    return html(c, 'Support', supportListPage(tickets, messageFrom(c), orders.map((o) => ({ id: o.id }))), '/account')
  })

  app.post('/account/support', async (c: Ctx) => {
    const user = pageUser(c, '/account/support')
    if (user instanceof Response) return user
    if (await guardLimit(c, 'support-ticket', 10, 3600, String(user.id))) return backTo(c, '/account/support', { error: 'Too many support requests right now. Please try again later.' })
    const body = await readForm(c)
    try {
      const attachment = await readAttachmentFromBody(body)
      const result = await createTicket(c.env.DB, c.env.PHOTOS, { userId: user.id, subject: body.subject, category: body.category, body: body.body, orderId: body.orderId, attachment })
      await recordSecurityEvent(c.env.DB, { userId: user.id, eventType: 'support_ticket_created', metadata: { ticket: result.ticket.id, attachment: !!result.attachmentId } })
      return c.redirect(`/account/support/${encodeURIComponent(result.ticket.id)}?ok=${encodeURIComponent('Your request was recorded.')}`)
    } catch (err) {
      return backTo(c, '/account/support', { error: outcomeMessage(err) })
    }
  })

  app.get('/account/support/:id', async (c: Ctx) => {
    const user = pageUser(c, '/account/support')
    if (user instanceof Response) return user
    try {
      const detail = await getMyTicket(c.env.DB, user.id, String(c.req.param('id')))
      return html(c, `Support: ${detail.ticket.subject}`, supportTicketPage(detail, messageFrom(c)), '/account')
    } catch {
      return htmlNotFound(c)
    }
  })

  app.post('/account/support/:id/reply', async (c: Ctx) => {
    const user = pageUser(c, '/account/support')
    if (user instanceof Response) return user
    if (await guardLimit(c, 'support-message', 60, 3600, String(user.id))) return backTo(c, `/account/support/${c.req.param('id')}`, { error: 'Too many messages right now. Please slow down.' })
    const body = await readForm(c)
    const path = `/account/support/${encodeURIComponent(String(c.req.param('id')))}`
    try {
      const attachment = await readAttachmentFromBody(body)
      await addCustomerMessage(c.env.DB, c.env.PHOTOS, { userId: user.id, publicId: String(c.req.param('id')), body: body.body, attachment })
      return backTo(c, path, { ok: 'Your reply was sent.' })
    } catch (err) {
      return backTo(c, path, { error: outcomeMessage(err) })
    }
  })

  app.post('/account/support/:id/status', async (c: Ctx) => {
    const user = pageUser(c, '/account/support')
    if (user instanceof Response) return user
    const body = await readForm(c)
    const path = `/account/support/${encodeURIComponent(String(c.req.param('id')))}`
    try {
      const ticket = await setTicketStatus(c.env.DB, { userId: user.id, publicId: String(c.req.param('id')), to: String(body.to ?? '') })
      return backTo(c, path, { ok: `This request is now ${ticket.statusLabel.toLowerCase()}.` })
    } catch (err) {
      return backTo(c, path, { error: outcomeMessage(err) })
    }
  })

  // ---- Guest claims (CUS-04) --------------------------------------------
  app.get('/account/claims', async (c: Ctx) => {
    const user = pageUser(c, '/account/claims')
    if (user instanceof Response) return user
    const profile = await getProfile(c.env.DB, user.id)
    const [claims, claimable] = await Promise.all([listClaimsForUser(c.env.DB, user.id), claimableForUser(c.env.DB, user.id, profile.email)])
    return html(
      c,
      'Guest orders',
      accountClaimsPage({ claims, claimable, emailVerified: profile.emailVerified, mailStatus: mailProviderStatus(mailEnvOf(c)), notice: messageFrom(c) }),
      '/account'
    )
  })

  app.post('/account/claims', async (c: Ctx) => {
    const user = pageUser(c, '/account/claims')
    if (user instanceof Response) return user
    if (await guardLimit(c, 'guest-claim', 5, 3600, String(user.id))) return backTo(c, '/account/claims', { error: 'Too many requests. Please try again later.' })
    const body = await readForm(c)
    // Deliberately identical whether or not that address has an order.
    await requestGuestClaim(c.env.DB, { ...mailEnvOf(c), ...c.env }, { userId: user.id, name: user.name, email: String(body.email ?? ''), baseUrl: originOfRequest(c) })
    // Deliberately identical whether or not that address has an order.
    return backTo(c, '/account/claims', { ok: 'If that address has an order that can be added, we have sent a single-use confirmation link to it. Open the link in that inbox to move the order.' })
  })

  app.post('/account/claims/order', async (c: Ctx) => {
    const user = pageUser(c, '/account/claims')
    if (user instanceof Response) return user
    const body = await readForm(c)
    try {
      const outcome = await claimOrderWithCapability(c.env.DB, { ...mailEnvOf(c), ...c.env }, {
        userId: user.id,
        orderId: Number(body.orderId),
        guestToken: String(body.guestToken ?? '')
      })
      const added = outcome.claimedOrders.length
      return backTo(c, '/account/claims', added ? { ok: `Order #${added ? outcome.claimedOrders[0] : ''} was added to your account.` } : { ok: 'That order is already on your account.' })
    } catch (err) {
      return backTo(c, '/account/claims', { error: outcomeMessage(err) })
    }
  })

  // ---- Privacy (CUS-14) -------------------------------------------------
  app.get('/account/privacy', async (c: Ctx) => {
    const user = pageUser(c, '/account/privacy')
    if (user instanceof Response) return user
    const requests = await listPrivacyRequests(c.env.DB, user.id)
    return html(c, 'Privacy', accountPrivacyPage(requests, mailProviderStatus(mailEnvOf(c)), messageFrom(c)), '/account')
  })

  app.post('/account/privacy', async (c: Ctx) => {
    const user = pageUser(c, '/account/privacy')
    if (user instanceof Response) return user
    const body = await readForm(c)
    const kind = String(body.kind ?? '')
    if (await guardLimit(c, `privacy-${kind}`, 5, 3600, String(user.id))) return backTo(c, '/account/privacy', { error: 'Too many requests. Please try again later.' })
    try {
      const result = await createPrivacyRequest(c.env.DB, mailEnvOf(c), { userId: user.id, kind, note: body.note })
      if (!result.created) return backTo(c, '/account/privacy', { ok: 'You already have an open request of that kind — it is shown below.' })
      const suffix = result.limitation ? ` ${result.limitation}` : ''
      return backTo(c, '/account/privacy', { ok: `Your request was recorded as ${result.request.id}.${suffix}` })
    } catch (err) {
      return backTo(c, '/account/privacy', { error: outcomeMessage(err) })
    }
  })

  app.post('/account/privacy/:id/cancel', async (c: Ctx) => {
    const user = pageUser(c, '/account/privacy')
    if (user instanceof Response) return user
    try {
      await cancelPrivacyRequest(c.env.DB, user.id, String(c.req.param('id')))
      return backTo(c, '/account/privacy', { ok: 'Your request was cancelled. Nothing was changed.' })
    } catch (err) {
      return backTo(c, '/account/privacy', { error: outcomeMessage(err) })
    }
  })

  // ---- My books library (CUS-05) ---------------------------------------
  // `/my/books` used to redirect to /my-books (which lists ORDERS). It is now the
  // BOOKS library, because that is what the name means and what CUS-05 requires;
  // /my-books keeps listing orders, and /my/books/:slug keeps being the reader
  // and customizer.
  app.get('/my/books', async (c: Ctx) => {
    const user = pageUser(c, '/my/books')
    if (user instanceof Response) return user
    const books = await listMyBooks(c.env.DB, user.id)
    return html(c, 'My books', myBooksLibraryPage(books, messageFrom(c)), '/my-books')
  })

  app.get('/my/orders', (c: Ctx) => c.redirect('/my-books'))

  // ---- Preview reader + version history (CUS-07/08/09) -----------------
  app.get('/my/previews/:id', async (c: Ctx) => {
    const user = pageUser(c, '/my/books')
    if (user instanceof Response) return user
    try {
      const detail = await getMyBookDetail(c.env.DB, user.id, String(c.req.param('id')))
      return html(c, `Preview: ${detail.summary.productTitle}`, myPreviewPage(detail, revisionPolicy(c.env), messageFrom(c)), '/my-books')
    } catch {
      return htmlNotFound(c)
    }
  })

  app.post('/my/books/:id/generate', async (c: Ctx) => {
    const user = pageUser(c, '/my/books')
    if (user instanceof Response) return user
    const path = `/my/previews/${encodeURIComponent(String(c.req.param('id')))}`
    try {
      const result = await requestGenerationForOwnedBook(c.env.DB, c.env, user.id, String(c.req.param('id')), c.get('requestId') || '')
      return backTo(c, path, {
        ok: result.jobCreated
          ? `Preview generation was queued. This book is now "${result.bookState.replace(/_/g, ' ')}" — reload this page in a moment to see the new version.`
          : `This version of the book has already been generated — reload this page to see it.`
      })
    } catch (err) {
      return backTo(c, path, { error: outcomeMessage(err) })
    }
  })

  app.post('/my/books/:id/approve', async (c: Ctx) => {
    const user = pageUser(c, '/my/books')
    if (user instanceof Response) return user
    const path = `/my/previews/${encodeURIComponent(String(c.req.param('id')))}`
    const body = await readForm(c)
    try {
      const result = await approveExactVersion(c.env.DB, user.id, String(c.req.param('id')), Number(body.previewVersionId))
      return backTo(c, path, {
        ok: result.alreadyApproved
          ? 'That version was already the approved one.'
          : `Version ${result.inputRevision} is approved. If you change anything now, the approval is invalidated and a new version is prepared.`
      })
    } catch (err) {
      return backTo(c, path, { error: outcomeMessage(err) })
    }
  })

  app.post('/my/books/:id/revision', async (c: Ctx) => {
    const user = pageUser(c, '/my/books')
    if (user instanceof Response) return user
    const path = `/my/previews/${encodeURIComponent(String(c.req.param('id')))}`
    if (await guardLimit(c, 'revision-request', 10, 3600, String(user.id))) return backTo(c, path, { error: 'Too many change requests right now. Please try again later.' })
    const body = await readForm(c)
    try {
      // A photo submitted through this form goes through the SAME two-phase
      // upload lifecycle as every other photo, so its bytes are validated by the
      // one policy implementation — never trusted from the form.
      const photo = photoFileFrom(body, 'replacementPhoto')
      const replacementPhotoKey = photo ? await storeFormPhoto(c, user, photo) : undefined
      const result = await requestStructuredRevision(c.env.DB, c.env, user.id, String(c.req.param('id')), {
        reasonCode: body.reasonCode,
        notes: body.notes,
        previewVersion: body.previewVersion,
        replacementPhotoKey
      })
      const parts = ['Your change request was recorded.']
      if (result.replacementPhotoApplied) {
        parts.push(`Your replacement photo became a new version of this book (revision ${result.newInputRevision}); the previous version is kept unchanged, and any approval you had given no longer applies.`)
      } else if (result.approvalInvalidated) {
        parts.push('Your previous approval was invalidated because the book changed.')
      }
      return backTo(c, path, { ok: parts.join(' ') })
    } catch (err) {
      return backTo(c, path, { error: outcomeMessage(err) })
    }
  })

  // ---- Downloads (CUS-11) ----------------------------------------------
  app.get('/my/downloads', async (c: Ctx) => {
    const user = pageUser(c, '/my/downloads')
    if (user instanceof Response) return user
    const downloads = await listMyDownloads(c.env.DB, user.id)
    return html(c, 'Downloads', myDownloadsPage(downloads, messageFrom(c)), '/my-books')
  })

  /**
   * Mints a token and hands the browser straight to the delivery route with a
   * 303. The token therefore never appears in the page's HTML, never reaches
   * localStorage, and is never written to a log — it exists only in the
   * encrypted-in-transit redirect and is single-use for two minutes.
   */
  app.post('/my/downloads/:id', async (c: Ctx) => {
    const user = pageUser(c, '/my/downloads')
    if (user instanceof Response) return user
    if (await guardLimit(c, 'download-token', 60, 3600, String(user.id))) return backTo(c, '/my/downloads', { error: 'Too many downloads right now. Please slow down.' })
    try {
      const minted = await mintDownloadToken(c.env.DB, user.id, String(c.req.param('id')))
      // No per-route Referrer-Policy: the application-wide policy applies and is
      // safe (it never sends the URL cross-origin). `no-store` is what matters
      // here — the redirect carries a single-use token in its Location.
      c.header('Cache-Control', 'no-store')
      return c.redirect(`/api/v1/downloads/${minted.token}`, 303)
    } catch (err) {
      return backTo(c, '/my/downloads', { error: outcomeMessage(err) })
    }
  })

  // ---- Receipt (CUS-10) -------------------------------------------------
  app.get('/my/orders/:id/receipt', async (c: Ctx) => {
    const user = pageUser(c, `/my/orders/${c.req.param('id')}/receipt`)
    if (user instanceof Response) return user
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return htmlNotFound(c)
    const detail = await getCustomerOrder(c.env.DB, user.id, id)
    if (!detail) return htmlNotFound(c)
    return html(c, `Receipt for order #${id}`, receiptPage(detail), '/my-books')
  })

  // ---- The guest-order "add to my account" affordance on the order page --
  // The confirmation page (src/index.tsx /order-success) renders this form for a
  // signed-in visitor whose session does not own the order: the order's own HMAC
  // capability token is what proves the claim, so nothing is taken on trust.
  app.post('/account/claim-order', async (c: Ctx) => {
    const user = pageUser(c, '/account/claims')
    if (user instanceof Response) return user
    const body = await readForm(c)
    const orderId = Number(body.orderId)
    try {
      const outcome = await claimOrderWithCapability(c.env.DB, { ...mailEnvOf(c), ...c.env }, { userId: user.id, orderId, guestToken: String(body.guestToken ?? '') })
      if (!outcome.claimedOrders.length) return c.redirect(`/order-success?id=${orderId}&ok=${encodeURIComponent('This order is already on your account.')}`)
      return c.redirect(`/my-books/${orderId}?ok=${encodeURIComponent('This order is now on your account.')}`)
    } catch (err) {
      return c.redirect(`/order-success?id=${orderId}&error=${encodeURIComponent(outcomeMessage(err))}`)
    }
  })

}

function addressViewFromRow(row: Record<string, unknown>): AddressView {
  return {
    id: String(row.public_id ?? ''),
    label: String(row.label ?? ''),
    fullName: String(row.full_name ?? ''),
    line1: String(row.line1 ?? ''),
    line2: String(row.line2 ?? ''),
    city: String(row.city ?? ''),
    region: String(row.region ?? ''),
    postalCode: String(row.postal_code ?? ''),
    country: String(row.country ?? ''),
    phone: String(row.phone ?? ''),
    isDefaultShipping: Number(row.is_default_shipping ?? 0) === 1,
    isDefaultBilling: Number(row.is_default_billing ?? 0) === 1
  }
}

export type { AccountEnv }
