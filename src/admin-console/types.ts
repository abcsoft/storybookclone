/**
 * Shared types for the admin console modules.
 *
 * `AnyAdminCtx` exists because these helpers are called both from routes declared
 * with the application's full `Bindings`/`Vars` (src/index.tsx) and from routes
 * declared with the narrower admin environment in `src/admin_routes.ts`. Hono's
 * `Context` is a class whose methods are bivariant, so a narrower context is not
 * reliably assignable in both directions; the helpers therefore accept the
 * request context structurally. Everything they actually touch — `env.DB`,
 * `get('user')`, `get('adminPermissions')`, `get('requestId')`, `req` — is
 * present on both.
 */
import type { Context } from 'hono'

export type AdminActorLike = { id?: number | null; email?: string | null; role?: string | null }

export type AdminConsoleBindings = { DB: D1Database; PHOTOS?: R2Bucket; ENVIRONMENT?: string }

export type AdminConsoleVariables = {
  user: AdminActorLike | null
  requestId?: string | null
  csrfToken?: string
  adminPermissions?: string[]
  adminRoles?: string[]
}

export type AdminEnv = { Bindings: AdminConsoleBindings; Variables: AdminConsoleVariables }

/** The typed request context inside the admin console modules. */
export type AdminCtx = Context<AdminEnv>

/**
 * The same context seen structurally. Needed only by helpers that are also called
 * from routes declared with the application's much wider `Bindings`.
 */
export type AnyAdminCtx = Context<any>

/** The actor currently signed in, or null. */
export function actorOf(c: AnyAdminCtx): { id: number | null; email: string | null; role: string | null } {
  const user = (c.get('user') as AdminActorLike | null) ?? null
  return { id: user?.id ?? null, email: user?.email ?? null, role: user?.role ?? null }
}
