// Minimal deterministic R2Bucket test double — in-memory Map. Enough of the
// surface (put/get, writeHttpMetadata) that upload/photo-serving routes work
// against it exactly like real R2, with no network or real Cloudflare account.
type StoredObject = { body: ArrayBuffer; contentType: string }

export class FakeR2Bucket {
  private store = new Map<string, StoredObject>()

  async put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
    const body = value instanceof Uint8Array ? value.slice().buffer : value
    this.store.set(key, { body, contentType: opts?.httpMetadata?.contentType || 'application/octet-stream' })
  }

  async get(key: string) {
    const obj = this.store.get(key)
    if (!obj) return null
    return {
      body: obj.body,
      writeHttpMetadata(headers: Headers) {
        headers.set('Content-Type', obj.contentType)
      },
      arrayBuffer: async () => obj.body
    }
  }

  async delete(key: string) {
    this.store.delete(key)
  }
}

export function createFakeR2() {
  return new FakeR2Bucket() as unknown as R2Bucket
}
