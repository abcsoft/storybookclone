// CUS-11 — entitled, expiring downloads.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: there is no permanent URL anywhere.
// Not in HTML, not in a JSON response that a page caches, not in localStorage,
// not in a log, not in an email. What exists is:
//
//   entitlement (durable, derived from the ledger)
//     -> short-lived, single-use token (hashed at rest, minted on demand)
//       -> the bytes, streamed once, with the delivery recorded
//
// Every one of those steps re-checks ownership and expiry against the database at
// the moment it runs, so a leaked URL is worth at most one download inside a
// two-minute window — and the event log shows exactly when it happened.
import { DomainError } from '../generation/types'
import { sha256Hex } from '../secrets'
import { buildZip, safeEntryName, type ZipEntry } from '../archive/zip'

/** How long a minted token stays valid. Deliberately minutes, not days. */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 120
/** How long an entitlement lasts after it is granted. */
export const ENTITLEMENT_TTL_DAYS = 30
export const ENTITLEMENT_MAX_DOWNLOADS = 10
/** A cap on how much may be assembled in one request. */
export const ENTITLEMENT_MAX_ASSETS = 60

/**
 * The minimal "read an immutable asset" capability this module needs.
 *
 * Deliberately NOT `R2Bucket`: the generation pipeline stores its watermarked
 * previews through its own storage abstraction (src/generation/providers/
 * storage.ts), and both that abstraction and the real R2 binding must be usable
 * here — in production they are the same bucket, in tests they are an in-memory
 * store. Two thin adapters below bridge them, so this module never depends on
 * either concrete type.
 */
export type AssetObject = { bytes: () => Promise<Uint8Array> }
export type AssetReader = { get: (key: string) => Promise<AssetObject | null> }

/** Adapts a real R2 binding. */
export function r2AssetReader(bucket: R2Bucket): AssetReader {
  return {
    get: async (key: string) => {
      const object = await bucket.get(key)
      if (!object) return null
      return { bytes: async () => new Uint8Array(await object.arrayBuffer()) }
    }
  }
}

/** Adapts the generation pipeline's storage provider (the in-memory one in tests). */
export function storageProviderAssetReader(provider: { get: (key: string) => Promise<{ bytes: Uint8Array } | null> }): AssetReader {
  return {
    get: async (key: string) => {
      const object = await provider.get(key)
      return object ? { bytes: async () => object.bytes } : null
    }
  }
}

export type DownloadEntitlementRow = {
  id: number
  public_id: string
  user_id: number
  order_id: number
  order_item_id: number
  kind: string
  status: 'active' | 'revoked' | 'expired'
  max_downloads: number
  download_count: number
  expires_at: number
  created_at: string
  updated_at: string
}

function newPublicId(): string {
  return `dl_${crypto.randomUUID().replace(/-/g, '')}`
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type ProvisionResult = { created: number; existing: number; revoked: number; skipped: string | null }

/**
 * Grants (or revokes) the download entitlements for one order, driven purely by
 * the order's LEDGER-DERIVED payment state:
 *   * money captured and not fully refunded -> an entitlement per order item;
 *   * fully refunded                        -> every active entitlement revoked.
 *
 * Idempotent by construction: UNIQUE(order_item_id, kind) means a replayed
 * webhook cannot double a customer's quota, and a second call is a no-op.
 */
export async function provisionEntitlementsForOrder(
  db: D1Database,
  orderId: number,
  opts: { now?: number; ttlDays?: number; maxDownloads?: number } = {}
): Promise<ProvisionResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const order = await db
    .prepare('SELECT id, user_id, payment_status, amount_captured_minor, amount_refunded_minor FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ id: number; user_id: number | null; payment_status: string; amount_captured_minor: number; amount_refunded_minor: number }>()
  if (!order) return { created: 0, existing: 0, revoked: 0, skipped: 'order_missing' }

  const captured = Number(order.amount_captured_minor ?? 0)
  const refunded = Number(order.amount_refunded_minor ?? 0)
  const fullyRefunded = captured > 0 && refunded >= captured

  if (fullyRefunded || captured <= 0) {
    const revoked = await db
      .prepare("UPDATE download_entitlements SET status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status = 'active'")
      .bind(orderId)
      .run()
    return { created: 0, existing: 0, revoked: Number(revoked.meta?.changes ?? 0), skipped: fullyRefunded ? 'fully_refunded' : 'not_paid' }
  }

  if (order.user_id === null) {
    // A guest order has no account to attach a download to. Claiming the order
    // (CUS-04) is what grants one — and the claim path calls this function again.
    return { created: 0, existing: 0, revoked: 0, skipped: 'guest_order' }
  }

  const items =
    (
      await db.prepare('SELECT id FROM order_items WHERE order_id = ? ORDER BY id').bind(orderId).all<{ id: number }>()
    ).results || []
  const expiresAt = now + Math.floor((opts.ttlDays ?? ENTITLEMENT_TTL_DAYS) * 24 * 3600)
  const maxDownloads = opts.maxDownloads ?? ENTITLEMENT_MAX_DOWNLOADS
  let created = 0
  let existing = 0
  for (const item of items) {
    const result = await db
      .prepare(
        `INSERT INTO download_entitlements (public_id, user_id, order_id, order_item_id, kind, max_downloads, expires_at)
         VALUES (?, ?, ?, ?, 'preview_pages', ?, ?)
         ON CONFLICT(order_item_id, kind) DO NOTHING`
      )
      .bind(newPublicId(), order.user_id, orderId, item.id, maxDownloads, expiresAt)
      .run()
    if (Number(result.meta?.changes ?? 0) > 0) created += 1
    else existing += 1
  }
  return { created, existing, revoked: 0, skipped: null }
}

/** Revokes every entitlement for an order (used when an order is refunded in full). */
export async function revokeEntitlementsForOrder(db: D1Database, orderId: number): Promise<number> {
  const result = await db.prepare("UPDATE download_entitlements SET status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status = 'active'").bind(orderId).run()
  return Number(result.meta?.changes ?? 0)
}

export type DownloadView = {
  id: string
  kind: string
  kindLabel: string
  orderId: number
  orderItemId: number
  itemTitle: string
  status: string
  stateLabel: string
  downloadCount: number
  maxDownloads: number
  remaining: number
  expiresAt: string
  /** Whether a download can be started right now, and — when not — exactly why. */
  downloadable: boolean
  reason: string
  previewVersion: number | null
}

export function entitlementStateLabel(status: string, expired: boolean, exhausted: boolean): string {
  if (status === 'revoked') return 'Revoked'
  if (status === 'expired' || expired) return 'Expired'
  if (exhausted) return 'Download limit reached'
  return 'Available'
}

/** The expiring, honest truth about one entitlement. Shared by the API and the page. */
export async function describeEntitlement(db: D1Database, row: DownloadEntitlementRow, now = Math.floor(Date.now() / 1000)): Promise<DownloadView> {
  const item = await db.prepare('SELECT title FROM order_items WHERE id = ?').bind(row.order_item_id).first<{ title: string }>()
  const expired = Number(row.expires_at) <= now
  const exhausted = Number(row.download_count) >= Number(row.max_downloads)
  const artifact = await resolveArtifactSource(db, row)
  const blockedReason =
    row.status === 'revoked'
      ? 'This download was revoked (the order was refunded).'
      : row.status === 'expired' || expired
        ? 'This download window has expired.'
        : exhausted
          ? 'The download limit for this order item has been reached.'
          : artifact.reason
  return {
    id: row.public_id,
    kind: row.kind,
    kindLabel: row.kind === 'preview_pages' ? 'Watermarked preview pages (archive)' : 'Print-ready PDF',
    orderId: Number(row.order_id),
    orderItemId: Number(row.order_item_id),
    itemTitle: item?.title || 'Your book',
    status: row.status,
    stateLabel: entitlementStateLabel(row.status, expired, exhausted),
    downloadCount: Number(row.download_count),
    maxDownloads: Number(row.max_downloads),
    remaining: Math.max(0, Number(row.max_downloads) - Number(row.download_count)),
    expiresAt: new Date(Number(row.expires_at) * 1000).toISOString(),
    downloadable: !blockedReason,
    reason: blockedReason || '',
    previewVersion: artifact.previewVersion
  }
}

export async function listMyDownloads(db: D1Database, userId: number): Promise<DownloadView[]> {
  const rows =
    (
      await db.prepare('SELECT * FROM download_entitlements WHERE user_id = ? ORDER BY id DESC LIMIT 200').bind(userId).all<DownloadEntitlementRow>()
    ).results || []
  const out: DownloadView[] = []
  for (const row of rows) out.push(await describeEntitlement(db, row))
  return out
}

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

type ArtifactSource =
  | { available: true; reason: ''; previewVersion: number; assets: Array<{ objectKey: string; checksum: string; sceneKey: string | null; sortOrder: number }> }
  | { available: false; reason: string; previewVersion: number | null }

/**
 * What an entitlement would actually deliver, resolved from persisted rows only.
 *
 * `print_pdf` has NO producer in this build — Phase 7 owns PDF rendering — so it
 * is refused with a truthful reason instead of inventing a file.
 */
export async function resolveArtifactSource(db: D1Database, row: DownloadEntitlementRow): Promise<ArtifactSource> {
  if (row.kind === 'print_pdf') {
    return { available: false, reason: 'A print-ready PDF is not produced by this version of the service yet.', previewVersion: null }
  }
  const item = await db
    .prepare('SELECT user_book_id, personalization_input_revision FROM order_items WHERE id = ?')
    .bind(row.order_item_id)
    .first<{ user_book_id: number | null; personalization_input_revision: number | null }>()
  if (!item?.user_book_id) {
    return { available: false, reason: 'This order item has no personalised book attached, so there are no generated pages to download.', previewVersion: null }
  }
  const version = await db
    .prepare("SELECT id, input_revision FROM preview_versions WHERE user_book_id = ? AND status = 'ready' ORDER BY input_revision DESC, id DESC LIMIT 1")
    .bind(item.user_book_id)
    .first<{ id: number; input_revision: number }>()
  if (!version) {
    return { available: false, reason: 'No preview has been generated for this book yet, so there is nothing to download. Ask for a preview from the book page first.', previewVersion: null }
  }
  const assets =
    (
      await db
        .prepare(
          `SELECT pa.object_key, pa.checksum, pa.asset_type, bs.scene_key, COALESCE(bs.sort_order, 0) AS sort_order
             FROM preview_assets pa
             LEFT JOIN book_scenes bs ON bs.id = pa.scene_id
            WHERE pa.preview_version_id = ? AND pa.asset_type = 'page_preview'
            ORDER BY COALESCE(bs.sort_order, 0), pa.id`
        )
        .bind(version.id)
        .all<{ object_key: string; checksum: string; asset_type: string; scene_key: string | null; sort_order: number }>()
    ).results || []
  if (!assets.length) {
    return { available: false, reason: 'The generated preview for this book has no page images to package yet.', previewVersion: Number(version.input_revision) }
  }
  if (assets.length > ENTITLEMENT_MAX_ASSETS) {
    return { available: false, reason: `This book has ${assets.length} pages, above the ${ENTITLEMENT_MAX_ASSETS}-page limit for a single download.`, previewVersion: Number(version.input_revision) }
  }
  return {
    available: true,
    reason: '',
    previewVersion: Number(version.input_revision),
    assets: assets.map((a) => ({ objectKey: a.object_key, checksum: a.checksum, sceneKey: a.scene_key, sortOrder: Number(a.sort_order) }))
  }
}

const ARTIFACT_NOTICE = (input: { orderId: number; itemTitle: string; previewVersion: number; watermarkLabel: string }) => `This archive was produced by this store's own preview pipeline.

What it contains
  Watermarked page previews for order ${input.orderId}, item "${input.itemTitle}",
  generated from preview version ${input.previewVersion}.

Preview pages are watermarked with "${input.watermarkLabel}" and are not a substitute for
the finished printed book: they are the same images shown in your account, at the same
resolution, so that what you see is what was generated. A print-ready PDF is not yet
produced by this version of the service; it arrives with the print pipeline.

If you did not request this download, change your password and revoke your other
sessions from your account security page.

This archive is reproducible: every page is named with the first characters of its
recorded checksum.
`

export type BuiltArtifact = { bytes: Uint8Array; filename: string; contentType: string; entryCount: number }

/**
 * Assembles the archive from the immutable preview assets in private storage.
 * Returns null when any asset is unreadable — a partial archive would silently
 * misrepresent what the customer paid for.
 */
export async function buildEntitlementArtifact(
  db: D1Database,
  reader: AssetReader,
  row: DownloadEntitlementRow,
  opts: { watermarkLabel?: string; now?: Date; at?: Date } = {}
): Promise<BuiltArtifact | null> {
  const source = await resolveArtifactSource(db, row)
  if (!source.available) return null
  const item = await db.prepare('SELECT title FROM order_items WHERE id = ?').bind(row.order_item_id).first<{ title: string }>()

  const entries: ZipEntry[] = []
  let index = 1
  for (const asset of source.assets) {
    const object = await reader.get(asset.objectKey)
    if (!object) return null
    const bytes = await object.bytes()
    const name = `${String(index).padStart(2, '0')}-${safeEntryName(asset.sceneKey || 'page')}-${asset.checksum.slice(0, 8)}.jpg`
    entries.push({ name, bytes })
    index += 1
  }
  entries.push({
    name: 'README.txt',
    bytes: new TextEncoder().encode(
      ARTIFACT_NOTICE({ orderId: Number(row.order_id), itemTitle: item?.title || 'your book', previewVersion: source.previewVersion, watermarkLabel: opts.watermarkLabel || 'this store' })
    )
  })

  return {
    bytes: buildZip(entries, opts.at ?? opts.now ?? new Date()),
    filename: `order-${row.order_id}-preview-r${source.previewVersion}.zip`,
    // A ZIP is served as an opaque download; the browser must never try to
    // render it, and no HTML can be smuggled through it as a page.
    contentType: 'application/zip',
    entryCount: entries.length
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type MintedToken = { token: string; expiresAt: number; entitlement: DownloadView }

/**
 * Mints ONE short-lived, single-use token for an entitlement the caller owns.
 * The raw value is returned to the caller in this response only; the database
 * keeps its SHA-256.
 */
export async function mintDownloadToken(db: D1Database, userId: number, entitlementPublicId: string): Promise<MintedToken> {
  const row = await db.prepare('SELECT * FROM download_entitlements WHERE public_id = ? AND user_id = ?').bind(entitlementPublicId, userId).first<DownloadEntitlementRow>()
  if (!row) throw new DomainError('not_found', 'Not found.', 404)

  const view = await describeEntitlement(db, row)
  if (!view.downloadable) throw new DomainError('download_unavailable', view.reason, 409)

  // Retire this customer's outstanding tokens for this entitlement: minting a new
  // one must not leave several live capabilities behind.
  await db
    .prepare("UPDATE download_tokens SET used_at = CURRENT_TIMESTAMP WHERE entitlement_id = ? AND used_at IS NULL")
    .bind(row.id)
    .run()

  const token = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const tokenHash = await sha256Hex(token)
  const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_TTL_SECONDS
  await db.prepare('INSERT INTO download_tokens (entitlement_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').bind(row.id, userId, tokenHash, expiresAt).run()
  return { token, expiresAt, entitlement: view }
}

export type RedemptionResult =
  | { ok: true; entitlement: DownloadEntitlementRow; artifact: BuiltArtifact; filename: string }
  | { ok: false; code: string; message: string; status: number }

async function recordDownloadEvent(db: D1Database, entitlementId: number, userId: number, outcome: string, extra: { artifactKind?: string; byteSize?: number | null; ipDigest?: string | null } = {}): Promise<void> {
  await db
    .prepare('INSERT INTO download_events (entitlement_id, user_id, outcome, artifact_kind, byte_size, ip_hash) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(entitlementId, userId, outcome, extra.artifactKind ?? '', extra.byteSize ?? null, extra.ipDigest ?? null)
    .run()
}

/**
 * Redeems a token: verifies it, re-checks the entitlement and its expiry, builds
 * the artifact, records the delivery, consumes the token and increments the
 * counter. Every failure mode is recorded too, so "why did my download fail" has
 * a persisted answer.
 */
export async function redeemDownloadToken(
  db: D1Database,
  reader: AssetReader | undefined,
  rawToken: string,
  opts: { watermarkLabel?: string; ipDigest?: string | null; now?: number } = {}
): Promise<RedemptionResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const token = String(rawToken ?? '').trim()
  if (!token) return { ok: false, code: 'not_found', message: 'Not found.', status: 404 }
  const tokenHash = await sha256Hex(token)
  const tokenRow = await db.prepare('SELECT * FROM download_tokens WHERE token_hash = ?').bind(tokenHash).first<{ id: number; entitlement_id: number; user_id: number; expires_at: number; used_at: string | null }>()
  if (!tokenRow) return { ok: false, code: 'not_found', message: 'Not found.', status: 404 }

  const entitlement = await db.prepare('SELECT * FROM download_entitlements WHERE id = ?').bind(tokenRow.entitlement_id).first<DownloadEntitlementRow>()
  if (!entitlement) return { ok: false, code: 'not_found', message: 'Not found.', status: 404 }

  const deny = async (code: string, message: string, outcome: string, status: number): Promise<RedemptionResult> => {
    await recordDownloadEvent(db, entitlement.id, Number(entitlement.user_id), outcome, { artifactKind: entitlement.kind, ipDigest: opts.ipDigest ?? null })
    return { ok: false, code, message, status }
  }

  if (tokenRow.used_at) return deny('token_used', 'This download link has already been used. Start a new download from your account.', 'denied_token', 410)
  if (Number(tokenRow.expires_at) <= now) return deny('token_expired', 'This download link has expired. Start a new download from your account.', 'denied_token', 410)
  // A token is only ever valid for the account that minted it.
  if (Number(entitlement.user_id) !== Number(tokenRow.user_id)) return deny('not_found', 'Not found.', 'denied_foreign', 404)
  if (entitlement.status === 'revoked') return deny('entitlement_revoked', 'This download is no longer available.', 'denied_revoked', 409)
  if (entitlement.status === 'expired' || Number(entitlement.expires_at) <= now) {
    await db.prepare("UPDATE download_entitlements SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'").bind(entitlement.id).run()
    return deny('entitlement_expired', 'This download window has expired.', 'denied_expired', 409)
  }
  if (Number(entitlement.download_count) >= Number(entitlement.max_downloads)) return deny('limit_reached', 'The download limit for this order item has been reached.', 'denied_limit', 409)
  if (!reader) return deny('storage_unavailable', 'Download storage is not available in this deployment.', 'artifact_unavailable', 503)

  // Consume the token BEFORE assembling the artifact: a token is single-use, and
  // two concurrent redemptions of the same value must not both stream a file.
  const consumed = await db.prepare('UPDATE download_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL').bind(tokenRow.id).run()
  if (Number(consumed.meta?.changes ?? 0) === 0) return deny('token_used', 'This download link has already been used.', 'denied_token', 410)

  const artifact = await buildEntitlementArtifact(db, reader, entitlement, { watermarkLabel: opts.watermarkLabel })
  if (!artifact) {
    // Release the token: nothing was delivered, so consuming it would punish the
    // customer for a server-side problem.
    await db.prepare('UPDATE download_tokens SET used_at = NULL WHERE id = ?').bind(tokenRow.id).run()
    return deny('artifact_unavailable', 'The pages for this download could not be read. Please try again, or contact support if it continues.', 'artifact_unavailable', 503)
  }

  // The counter is guarded by the CHECK download_count <= max_downloads, so even
  // a lost race cannot exceed the limit.
  const bumped = await db
    .prepare('UPDATE download_entitlements SET download_count = download_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ? AND download_count < max_downloads')
    .bind(entitlement.id, 'active')
    .run()
  if (Number(bumped.meta?.changes ?? 0) === 0) {
    await db.prepare('UPDATE download_tokens SET used_at = NULL WHERE id = ?').bind(tokenRow.id).run()
    return deny('limit_reached', 'The download limit for this order item has been reached.', 'denied_limit', 409)
  }

  await recordDownloadEvent(db, entitlement.id, Number(entitlement.user_id), 'delivered', { artifactKind: entitlement.kind, byteSize: artifact.bytes.byteLength, ipDigest: opts.ipDigest ?? null })
  return { ok: true, entitlement, artifact, filename: artifact.filename }
}
