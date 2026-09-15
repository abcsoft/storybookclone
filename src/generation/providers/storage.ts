// GEN-08: private object storage with an enforced namespace split.
//
// Generated ORIGINALS and watermarked PREVIEW derivatives live under two
// distinct private R2 prefixes. The split is enforced here, in the provider,
// not at the call site: `putOriginal` refuses any key that is not under the
// original prefix and `putPreview` refuses any key that is not under the
// preview prefix. A bug (or a future refactor) in the pipeline therefore
// cannot place an unwatermarked original where a preview is served from.
//
// Nothing in this module ever mints a URL. Private objects are only ever read
// back through an entitlement-checked route (src/generation/routes.ts), which
// streams the bytes after resolving ownership — never a signed URL, never a
// public bucket path, never a redirect to storage.
import { DomainError } from '../../personalization/types'
import { ORIGINAL_KEY_PREFIX, PREVIEW_KEY_PREFIX } from '../types'
import { DisabledStorageProvider } from './disabled'
import type { StorageProvider } from './types'

function assertPrefix(key: string, prefix: string, operation: string): void {
  if (typeof key !== 'string' || !key.startsWith(prefix)) {
    // Deliberately does not echo the key.
    throw new DomainError('invalid_storage_namespace', `${operation} may only write objects under the "${prefix}" namespace.`, 500)
  }
  if (key.includes('..') || key.includes('//') || key.length > 400) {
    throw new DomainError('invalid_storage_key', `${operation} was given a malformed object key.`, 500)
  }
}

export class R2StorageProvider implements StorageProvider {
  readonly name = 'r2'
  constructor(private readonly bucket: R2Bucket) {}

  async putOriginal(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertPrefix(key, ORIGINAL_KEY_PREFIX, 'putOriginal')
    await this.bucket.put(key, bytes, { httpMetadata: { contentType } })
  }

  async putPreview(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertPrefix(key, PREVIEW_KEY_PREFIX, 'putPreview')
    await this.bucket.put(key, bytes, { httpMetadata: { contentType } })
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    // Reads are restricted to the two generation namespaces: this provider is
    // never a general read/write handle on the whole bucket, so a caller
    // cannot use it to reach an uploaded child photo.
    if (!key.startsWith(ORIGINAL_KEY_PREFIX) && !key.startsWith(PREVIEW_KEY_PREFIX)) return null
    const object = await this.bucket.get(key)
    if (!object) return null
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    return { bytes: new Uint8Array(await object.arrayBuffer()), contentType: headers.get('Content-Type') || 'application/octet-stream' }
  }

  async delete(key: string): Promise<void> {
    if (!key.startsWith(ORIGINAL_KEY_PREFIX) && !key.startsWith(PREVIEW_KEY_PREFIX)) {
      throw new DomainError('invalid_storage_namespace', 'delete may only remove objects from the generation namespaces.', 500)
    }
    await this.bucket.delete(key)
  }
}

/**
 * In-memory storage for automated tests. Same namespace enforcement as the R2
 * implementation, so a test cannot pass against a laxer contract than
 * production.
 */
export class InMemoryStorageProvider implements StorageProvider {
  readonly name = 'memory'
  private readonly store = new Map<string, { bytes: Uint8Array; contentType: string }>()

  async putOriginal(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertPrefix(key, ORIGINAL_KEY_PREFIX, 'putOriginal')
    this.store.set(key, { bytes, contentType })
  }

  async putPreview(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertPrefix(key, PREVIEW_KEY_PREFIX, 'putPreview')
    this.store.set(key, { bytes, contentType })
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    return this.store.get(key) ?? null
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  /** Test-only introspection. */
  keys(): string[] {
    return [...this.store.keys()].sort()
  }
}

/**
 * Wraps an R2 binding as a StorageProvider, or returns the fail-closed adapter
 * when the binding is absent — the same shape every other capability uses.
 */
export function storageProviderFor(bucket: R2Bucket | undefined): StorageProvider {
  return bucket ? new R2StorageProvider(bucket) : new DisabledStorageProvider()
}
