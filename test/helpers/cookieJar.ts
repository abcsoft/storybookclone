// Tiny cookie jar for route-level tests that call app.request() directly —
// Hono's test client has no built-in cookie jar, and several Phase 1 flows
// (session login, the upload-owner token) are cookie-based.
//
// `headers()` returns the header set a REAL same-origin browser would send on
// a mutation: the Cookie header plus the Origin proof and the double-submit
// CSRF token header. Tests that exercise a cookie-authenticated mutation
// should spread it (`...jar.headers()`), which keeps them honest without
// hand-crafting security headers; the negative CSRF tests build their own
// headers explicitly.
export const TEST_ORIGIN = 'http://localhost'

export class CookieJar {
  private jar = new Map<string, string>()

  observe(res: Response) {
    const raw = (res.headers as any).getSetCookie ? (res.headers as any).getSetCookie() : res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []
    for (const line of raw) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      // A deletion sets an empty value / past expiry — drop it from the jar.
      if (!value) this.jar.delete(name)
      else this.jar.set(name, value)
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** The CSRF double-submit token this jar holds, if any. */
  csrfToken(): string | undefined {
    return this.jar.get('ww_csrf')
  }

  get(name: string): string | undefined {
    return this.jar.get(name)
  }

  /** Headers a same-origin browser sends on a mutation (Cookie + Origin + CSRF token). */
  headers(): Record<string, string> {
    const out: Record<string, string> = { Cookie: this.header(), Origin: TEST_ORIGIN }
    const token = this.csrfToken()
    if (token) out['X-CSRF-Token'] = token
    return out
  }

  clear() {
    this.jar.clear()
  }
}
