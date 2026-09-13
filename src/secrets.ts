// Server-generated, DB-persisted secrets (e.g. the HMAC key used to sign
// guest order-access tokens). Never a hard-coded literal in source: created
// once on first use with Web Crypto randomness, then reused. See Phase 0's
// admin-credential fix for the same pattern applied to admin bootstrap.
function toHex(buf: ArrayBuffer | Uint8Array) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export async function getOrCreateSecret(db: D1Database, key: string): Promise<string> {
  const existing = await db.prepare('SELECT value FROM app_secrets WHERE key = ?').bind(key).first<{ value: string }>()
  if (existing) return existing.value
  const generated = toHex(crypto.getRandomValues(new Uint8Array(32)))
  await db.prepare('INSERT OR IGNORE INTO app_secrets (key, value) VALUES (?, ?)').bind(key, generated).run()
  // Re-read in case of a race with another concurrent first-request (INSERT
  // OR IGNORE means the loser reads back the winner's value instead of two
  // isolates disagreeing on the secret).
  const row = await db.prepare('SELECT value FROM app_secrets WHERE key = ?').bind(key).first<{ value: string }>()
  return row!.value
}

export async function hmacSha256Hex(secretHex: string, message: string): Promise<string> {
  const keyBytes = new Uint8Array(secretHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return toHex(sig)
}

export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))
  return toHex(digest)
}

/** Constant-time string compare (equal-length hex/opaque tokens). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
