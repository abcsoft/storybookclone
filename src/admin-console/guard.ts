/**
 * ADM-02 / ADM-20 — the ONE central admin gate.
 *
 * Registered once, before any admin route, for `/admin/*`, `/api/v1/admin/*` and
 * `/api/admin/*`. It is the only place that decides whether an admin request may
 * proceed, and it decides it from `./policy.ts`, never from the shape of the
 * request or from whether a menu link was rendered:
 *
 *   * no policy entry         → refused (fail closed)
 *   * no session              → refused
 *   * not a staff account     → refused
 *   * permission not held     → refused, JSON for /api paths, a rendered
 *                               refusal page for HTML, and never a write
 *   * `reauth: true` entry    → a single-use, action-bound, session-bound
 *                               password confirmation must be presented
 *
 * The resolved permission set is stored in REQUEST-scoped Hono variables, so two
 * concurrent admin renders with different roles can never observe each other's
 * permissions. There is no module-level request state anywhere in this module.
 */
import type { Context, MiddlewareHandler, Next } from 'hono'
import type { AnyAdminCtx } from './types'
import { getCookie } from 'hono/cookie'
import { hasSessionCookie } from '../security'
import { currentSessionPublicId, readSessionToken } from '../auth'
import { resolveAdminPolicy, type AdminPolicyEntry } from './policy'
import { permissionsForActor, rolesForUser } from './roles'
import { REAUTH_CHALLENGE_FIELD, REAUTH_PASSWORD_FIELD, consumeReauthChallenge, issueReauthChallenge } from './reauth'

export type AdminActorLike = { id?: number | null; email?: string | null; role?: string | null }

export type AdminConsoleBindings = { DB: D1Database; ENVIRONMENT?: string }

export type AdminConsoleVariables = {
  user: AdminActorLike | null
  requestId?: string | null
  csrfToken?: string
  adminPermissions?: string[]
  adminRoles?: string[]
}

type Ctx = Context<{ Bindings: AdminConsoleBindings; Variables: AdminConsoleVariables }>

export const PERMISSION_HEADER = 'X-Admin-Permissions'

/** Does this permission set include `key`? The only authorization predicate. */
export function permits(permissions: readonly string[] | undefined, key: string): boolean {
  return !!permissions && permissions.includes(key)
}

export function currentPermissions(c: { get: (k: 'adminPermissions') => string[] | undefined }): string[] {
  return c.get('adminPermissions') ?? []
}

export function hasPermission(c: Ctx, key: string): boolean {
  return permits(c.get('adminPermissions'), key)
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/')
}

function wantsHtml(c: Ctx): boolean {
  return !isApiPath(new URL(c.req.url).pathname)
}

/**
 * The uniform denial. Never partial: nothing downstream runs, so a denied request
 * writes no row and appends no audit event.
 */
function deny(c: Ctx, opts: { kind: 'unauthenticated' | 'forbidden'; code: string; message: string }): Response {
  if (!wantsHtml(c)) {
    return c.json({ error: { code: opts.code, message: opts.message, requestId: c.get('requestId') ?? null } }, opts.kind === 'unauthenticated' ? 401 : 403)
  }
  // Preserve the Phase-1/2 contract for a caller who simply is not staff: send
  // them to the sign-in screen (a customer must never see an admin refusal page
  // that tells them an admin area exists), and refuse with a rendered page only
  // for a signed-in staff member who lacks the specific permission.
  if (opts.kind === 'unauthenticated') return c.redirect('/admin/login')
  return c.html(refusalPage(opts.message, opts.code), 403)
}

/** A real page, not a blank screen — an operator must be told why. */
function refusalPage(message: string, code: string): string {
  // Deliberately dependency-free: this must render even if the caller's data
  // load would fail, because it is the one response the admin panel can always
  // produce.
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not permitted</title><link href="/static/admin.css" rel="stylesheet"><link href="/static/icons.css" rel="stylesheet"></head>
<body class="admin-login"><div class="admin-login-card" role="alert" data-admin-denial="${code}">
<h1>Not permitted</h1><p class="a-notice error">${message}</p>
<p class="tiny">Your account does not carry the permission this page requires. If you believe this is wrong, ask a super administrator to review your roles.</p>
<p><a class="a-link" href="/admin">Back to the dashboard</a> · <a class="a-link" href="/">View store</a></p>
</div></body></html>`
}

function readFormField(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  return value == null ? '' : String(value)
}

/**
 * Enforce the re-auth requirement for one high-risk entry. The body is read
 * through Hono's request cache, so the handler downstream still parses exactly
 * the same body.
 */
async function enforceReauth(c: Ctx, entry: AdminPolicyEntry, actor: AdminActorLike): Promise<Response | null> {
  const action = `${entry.method} ${entry.path}`
  const entityRef = new URL(c.req.url).pathname
  let body: Record<string, unknown> = {}
  const contentType = c.req.header('Content-Type') || ''
  try {
    body = contentType.includes('application/json')
      ? ((await c.req.json()) as Record<string, unknown>)
      : ((await c.req.parseBody()) as unknown as Record<string, unknown>)
  } catch {
    body = {}
  }
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(actor.id ?? null)
    .first<{ password_hash: string }>()
  const sessionPublicId = await currentSessionPublicId(c.env.DB, readSessionToken(c))
  const result = await consumeReauthChallenge(c.env.DB, {
    publicId: readFormField(body, REAUTH_CHALLENGE_FIELD),
    userId: Number(actor.id ?? 0),
    sessionPublicId,
    action,
    entityRef,
    password: readFormField(body, REAUTH_PASSWORD_FIELD),
    passwordHash: row?.password_hash ?? null
  })
  if (result.ok) return null
  if (!wantsHtml(c)) {
    return c.json(
      { error: { code: `reauth_${result.outcome}`, message: result.message, reauthRequired: true, requestId: c.get('requestId') ?? null } },
      403
    )
  }
  return c.html(
    refusalHtmlWithReauth(result.message),
    403
  )
}

function refusalHtmlWithReauth(message: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirmation required</title><link href="/static/admin.css" rel="stylesheet"><link href="/static/icons.css" rel="stylesheet"></head>
<body class="admin-login"><div class="admin-login-card" role="alert" data-admin-denial="reauth">
<h1>Confirmation required</h1><p class="a-notice error">${message}</p>
<p class="tiny">Refunds, role and permission changes, privacy decisions, template publishing, feature flags and data exports always require your current password. The action was NOT performed.</p>
<p><a class="a-link" href="/admin">Back to the dashboard</a></p>
</div></body></html>`
}

/** The context a high-risk form needs in order to carry a fresh confirmation. */
export type ReauthTicket = { challenge: string; action: string; fieldName: string; passwordFieldName: string }

/**
 * Issue a challenge for the high-risk form the caller is about to render. Called
 * from the GET handler of the page that owns the form (and from the JSON API's
 * `GET /api/v1/admin/…` equivalents is NOT needed: API clients fetch
 * `POST /api/v1/admin/reauth` instead).
 */
export async function issueReauthTicket(c: AnyAdminCtx, action: string, entityRef?: string): Promise<ReauthTicket> {
  const actor = c.get('user')
  const sessionPublicId = await currentSessionPublicId(c.env.DB, readSessionToken(c))
  const challenge = await issueReauthChallenge(c.env.DB, {
    userId: Number(actor?.id ?? 0),
    sessionPublicId,
    action,
    entityRef: entityRef ?? '/api/v1/admin/reauth'
  })
  return {
    challenge,
    action,
    fieldName: REAUTH_CHALLENGE_FIELD,
    passwordFieldName: REAUTH_PASSWORD_FIELD
  }
}

/**
 * The public endpoint an API client uses to obtain a challenge:
 * `POST /api/v1/admin/reauth { path }` → `{ challenge, action, expiresInSeconds }`.
 *
 * The client names the CONCRETE path it is about to act on (e.g.
 * `/api/v1/admin/orders/12/refunds`); the server resolves it to the policy entry
 * itself, so the challenge is bound to the real route pattern and the caller must
 * already hold that route's permission to be given one. A caller therefore can
 * never mint a confirmation for an action it could not perform.
 */
/**
 * Issue a confirmation for a CONCRETE path, resolving the action from the policy
 * table so the challenge is bound to exactly the string the guard compares.
 * Returns null when the path has no policy, or the caller does not hold its
 * permission — a confirmation is never minted for an action the caller could not
 * perform.
 */
export async function issueTicketForPath(c: AnyAdminCtx, path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST'): Promise<ReauthTicket | null> {
  const entry = resolveAdminPolicy(method, path)
  if (!entry || entry.permission === null) return null
  const permissions = (c.get('adminPermissions') as string[] | undefined) ?? []
  if (!permits(permissions, entry.permission)) return null
  return issueReauthTicket(c, `${entry.method} ${entry.path}`, path)
}

export async function reauthTicketHandler(c: Ctx): Promise<Response> {
  const body = await c.req
    .json<{ path?: string; entityRef?: string }>()
    .catch(() => ({} as { path?: string; entityRef?: string }))
  const targetPath = String(body.path ?? body.entityRef ?? '').trim()
  if (!targetPath || !targetPath.startsWith('/')) {
    return c.json(
      { error: { code: 'validation_failed', message: 'Provide the concrete path you are about to act on, e.g. /api/v1/admin/refunds.', fields: { path: 'required' } } },
      400
    )
  }
  const entry = resolveAdminPolicy('POST', targetPath) ?? resolveAdminPolicy('GET', targetPath)
  if (!entry || entry.permission === null) {
    return c.json({ error: { code: 'not_found', message: 'That path has no admin permission policy.' } }, 404)
  }
  const permissions = c.get('adminPermissions') ?? []
  if (!permits(permissions, entry.permission)) {
    return c.json(
      { error: { code: 'forbidden', message: `Your roles do not include "${entry.permission}", so no confirmation can be issued for that action.` } },
      403
    )
  }
  const action = `${entry.method} ${entry.path}`
  const ticket = await issueReauthTicket(c, action, targetPath)
  // Same `{ data, requestId }` envelope as every other admin API response, so a
  // client has one shape to parse.
  return c.json({
    data: {
      challenge: ticket.challenge,
      field: ticket.fieldName,
      passwordField: ticket.passwordFieldName,
      action,
      entityRef: targetPath,
      expiresInSeconds: 600
    },
    requestId: c.get('requestId') ?? null
  })
}

/** The central gate. */
export const adminConsoleGuard: MiddlewareHandler<{ Bindings: AdminConsoleBindings; Variables: AdminConsoleVariables }> = async (
  c: Ctx,
  next: Next
) => {
  const pathname = new URL(c.req.url).pathname
  const entry = resolveAdminPolicy(c.req.method, pathname)
  if (!entry) {
    // Fail closed. A route added without a policy entry is unreachable, and the
    // coverage test in test/unit/phase6-rbac.test.ts fails before it ships.
    console.warn(`[admin-guard] no policy entry for ${c.req.method} ${pathname} — refusing`)
    return deny(c, {
      kind: 'forbidden',
      code: 'policy_missing',
      message: 'This admin route has no permission policy, so it is refused by default.'
    })
  }
  if (entry.permission === null) {
    await next()
    return
  }

  const user = c.get('user')
  if (!user || !user.id) {
    return deny(c, { kind: 'unauthenticated', code: 'auth_required', message: 'Sign in as an administrator.' })
  }
  // A non-staff account never reaches a permission decision: the panel is for
  // staff only, and the legacy `role` flag is the sign-in gate.
  if (user.role !== 'admin') {
    return deny(c, { kind: 'unauthenticated', code: 'forbidden', message: 'This account is not a staff account.' })
  }

  const [permissions, roles] = await Promise.all([permissionsForActor(c.env.DB, user), rolesForUser(c.env.DB, user)])
  c.set('adminPermissions', permissions)
  c.set('adminRoles', roles)
  c.header(PERMISSION_HEADER, permissions.join(' '))

  if (!permits(permissions, entry.permission)) {
    return deny(c, {
      kind: 'forbidden',
      code: 'forbidden',
      message: `Your roles (${roles.join(', ') || 'none'}) do not include the permission "${entry.permission}" required to ${entry.label.toLowerCase()}.`
    })
  }

  if (entry.reauth) {
    const refused = await enforceReauth(c, entry, user)
    if (refused) return refused
  }

  await next()
}

/** Exported for the e2e/audit harnesses: does a browser hold a session cookie? */
export function requestHasSession(c: Ctx): boolean {
  return hasSessionCookie(c) || !!getCookie(c, 'ww_session')
}
