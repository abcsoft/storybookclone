// Tiny cookie jar for route-level tests that call app.request() directly —
// Hono's test client has no built-in cookie jar, and several Phase 1 flows
// (session login, the upload-owner token) are cookie-based.
export class CookieJar {
  private jar = new Map<string, string>()

  observe(res: Response) {
    const raw = (res.headers as any).getSetCookie ? (res.headers as any).getSetCookie() : res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []
    for (const line of raw) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  clear() {
    this.jar.clear()
  }
}
