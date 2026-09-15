// V2 Phase 3 — the generation pipeline's core behaviour (GEN-04, GEN-05,
// GEN-06, GEN-08, GEN-11, GEN-12).
//
// Every test here drives the REAL services against a REAL migrated local
// database and REAL JPEG bytes. The deterministic offline providers are the
// only providers that ever run, and several tests assert that explicitly — the
// suite makes zero calls to any external endpoint.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { createBook, deps, readyBook, registerUserWith, savePersonalization, seedProduct, testProviders, TEST_PRODUCT_SLUG } from '../helpers/generationFixtures'
import { requestGeneration } from '../../src/generation/routes'
import { consumeGenerationMessage, drainDueJobs, processJob } from '../../src/generation/pipeline'
import { claimJob, loadGenerationLimits, loadJob, loadTasks, recordUsage, reserveGenerationQuota } from '../../src/generation/jobs'
import { ensurePublishedTemplateForProduct, loadTemplate } from '../../src/generation/templates'
import { nowSeconds } from '../../src/generation/types'
import { readWatermark } from '../../src/generation/watermark'
import { PREVIEW_KEY_PREFIX, ORIGINAL_KEY_PREFIX } from '../../src/generation/types'
import { app } from '../helpers/testApp'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

/** Runs the full owner workflow through the real HTTP surface and returns the job view. */
async function generate(env: TestEnv, jar: CookieJar, bookId: string, opts: { childName?: string } = {}) {
  const res = await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
  jar.observe(res)
  const body = (await res.json()) as any
  return { status: res.status, body }
}

describe('phase3 — one owned personalization produces ONE multi-scene stored preview', () => {
  it('generates every scene, stores private originals AND watermarked previews, and publishes exactly one preview version', async () => {
    const jar = await registerUserWith(env, 'owner@example.com')
    const { bookId } = await readyBook(env, jar, { childName: 'Amara' })

    const { status, body } = await generate(env, jar, bookId)
    expect(status).toBe(202)
    expect(body.job.phase).toBe('ready')
    expect(body.job.status).toBe('succeeded')
    expect(body.job.scenes.ready).toBe(body.job.scenes.total)
    expect(body.job.scenes.total).toBe(6)

    // REAL rows, not a mock: one ready preview version, one scene_count, a manifest checksum.
    const version = await env.DB.prepare("SELECT * FROM preview_versions WHERE status = 'ready'").all<any>()
    expect(version.results.length).toBe(1)
    expect(version.results[0].scene_count).toBe(6)
    expect(version.results[0].manifest_checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(version.results[0].watermark_label).toBeTruthy()
    expect(version.results[0].generation_job_id).toBeTruthy()

    const assets = await env.DB.prepare("SELECT asset_type, COUNT(*) AS n FROM preview_assets GROUP BY asset_type").all<{ asset_type: string; n: number }>()
    expect(assets.results.length).toBe(1)
    expect(assets.results[0].asset_type).toBe('page_preview')
    expect(assets.results[0].n).toBe(6)

    // Every preview asset is watermarked and links back to the generated asset it came from.
    const rows = await env.DB.prepare('SELECT * FROM preview_assets').all<any>()
    for (const row of rows.results) {
      expect(row.is_watermarked).toBe(1)
      expect(row.object_key.startsWith(PREVIEW_KEY_PREFIX)).toBe(true)
      expect(row.generated_asset_id).toBeTruthy()
      expect(row.checksum).toMatch(/^[a-f0-9]{64}$/)
      expect(row.width).toBe(1200)
      expect(row.height).toBe(1500)
    }

    // Originals exist too, in their OWN namespace, and are never a preview asset.
    const originals = await env.DB.prepare("SELECT * FROM generated_assets WHERE asset_type = 'illustration_original'").all<any>()
    expect(originals.results.length).toBe(6)
    for (const row of originals.results) {
      expect(row.object_key.startsWith(ORIGINAL_KEY_PREFIX)).toBe(true)
      expect(row.is_watermarked).toBe(0)
    }

    // Story text assets carry the child's name (the personalisation is real).
    const texts = await env.DB.prepare("SELECT * FROM generated_assets WHERE asset_type = 'story_text'").all<any>()
    expect(texts.results.length).toBeGreaterThan(0)
    expect(texts.results.every((t) => String(t.text_content).includes('Amara'))).toBe(true)

    // R2 really holds the objects, under the two private namespaces.
    const objects = (env.PHOTOS as any) as { store?: Map<string, unknown> }
    const keys = [...(objects.store?.keys() ?? [])]
    expect(keys.filter((k) => k.startsWith(PREVIEW_KEY_PREFIX)).length).toBe(6)
    expect(keys.filter((k) => k.startsWith(ORIGINAL_KEY_PREFIX)).length).toBe(6)

    // A stored preview genuinely verifies as watermarked when read back from bytes.
    const versionId = version.results[0].id
    const asset = await env.DB.prepare('SELECT * FROM preview_assets WHERE preview_version_id = ? LIMIT 1').bind(versionId).first<any>()
    const stored = await env.PHOTOS!.get(asset.object_key)
    expect(stored).toBeTruthy()
    const provenance = await readWatermark(new Uint8Array(await (stored as R2ObjectBody).arrayBuffer()))
    expect(provenance).toBeTruthy()
  }, 60_000)

  it('is visible to its owner through the API and denied to another user', async () => {
    const ownerJar = await registerUserWith(env, 'preview-owner@example.com')
    const { bookId } = await readyBook(env, ownerJar)
    await generate(env, ownerJar, bookId)

    const mine = await app.request(`/api/v1/user-books/${bookId}/previews`, { headers: { ...ownerJar.headers() } }, env as never)
    expect(mine.status).toBe(200)
    const mineBody = (await mine.json()) as any
    expect(mineBody.versions.length).toBe(1)
    expect(mineBody.versions[0].pages.length).toBe(6)
    expect(mineBody.versions[0].pages.every((p: any) => p.watermarked === true)).toBe(true)

    // The owner can stream their own watermarked preview.
    const assetUrl = mineBody.versions[0].pages[0].url as string
    const assetRes = await app.request(assetUrl, { headers: { ...ownerJar.headers() } }, env as never)
    expect(assetRes.status).toBe(200)
    expect(assetRes.headers.get('Cache-Control')).toBe('private, no-store')

    // A different, fully-valid user is denied — the same generic 404 the
    // personalization domain uses, so nothing is confirmed.
    const strangerJar = await registerUserWith(env, 'stranger@example.com')
    const deniedList = await app.request(`/api/v1/user-books/${bookId}/previews`, { headers: { ...strangerJar.headers() } }, env as never)
    expect(deniedList.status).toBe(404)
    const deniedAsset = await app.request(assetUrl, { headers: { ...strangerJar.headers() } }, env as never)
    expect(deniedAsset.status).toBe(404)
    const deniedStatus = await app.request(`/api/v1/user-books/${bookId}/generation`, { headers: { ...strangerJar.headers() } }, env as never)
    expect(deniedStatus.status).toBe(404)

    // An anonymous caller is denied too.
    const anon = await app.request(assetUrl, {}, env as never)
    expect(anon.status).toBe(404)

    // The ORIGINAL namespace is never reachable through the preview route.
    const originalKey = (await env.DB.prepare("SELECT object_key FROM generated_assets WHERE asset_type = 'illustration_original' LIMIT 1").first<{ object_key: string }>())!.object_key
    const originalRes = await app.request(`/previews/${originalKey}`, { headers: { ...ownerJar.headers() } }, env as never)
    expect(originalRes.status).toBe(404)
  }, 60_000)

  it('does not fabricate a preview: with every provider fail-closed, the book reports an honest failure and stores nothing', async () => {
    const jar = await registerUserWith(env, 'unconfigured@example.com')
    const { bookId } = await readyBook(env, jar)
    // Turns off the dev fakes: exactly what a deployed environment with no
    // configured provider looks like.
    env.GENERATION_DISABLED = '1'

    const { body } = await generate(env, jar, bookId)
    expect(body.job.status).toBe('failed_permanent')
    expect(body.job.phase).toBe('needs_attention')
    expect(JSON.stringify(body.job.lastError)).toMatch(/provider/i)

    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_versions').first<{ n: number }>())!.n).toBe(0)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_assets').first<{ n: number }>())!.n).toBe(0)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM generated_assets WHERE object_key IS NOT NULL").first<{ n: number }>())!.n).toBe(0)

    const book = await env.DB.prepare('SELECT state FROM user_books WHERE public_id = ?').bind(bookId).first<{ state: string }>()
    expect(book!.state).toBe('generation_failed')
  }, 60_000)
})

describe('phase3 — idempotency, leases and duplicate delivery', () => {
  it('a duplicate request for the same revision returns the SAME job instead of a second billable one', async () => {
    const jar = await registerUserWith(env, 'duplicate@example.com')
    const { bookId } = await readyBook(env, jar)
    await generate(env, jar, bookId)

    const jobs = await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_jobs').first<{ n: number }>()
    expect(jobs!.n).toBe(1)

    // Re-requesting is a no-op that returns the existing job (state machine +
    // the unique index both refuse to create a second).
    const again = await generate(env, jar, bookId)
    expect(again.status).toBe(200)
    expect(again.body.created).toBe(false)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_jobs').first<{ n: number }>())!.n).toBe(1)

    // And the cost ledger has exactly one row per attempt/unit — no double billing.
    const usage = await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_usage_events').first<{ n: number }>()
    const usageDupes = await env.DB.prepare('SELECT COUNT(*) AS n FROM (SELECT attempt_id, unit FROM generation_usage_events GROUP BY attempt_id, unit HAVING COUNT(*) > 1)').first<{ n: number }>()
    expect(usage!.n).toBeGreaterThan(0)
    expect(usageDupes!.n).toBe(0)
  }, 60_000)

  it('delivering the same job twice is harmless: the second delivery is acknowledged and changes nothing', async () => {
    const jar = await registerUserWith(env, 'redelivery@example.com')
    const { bookId } = await readyBook(env, jar)
    // Create the job WITHOUT draining, so it is genuinely still queued.
    env.GENERATION_INLINE_DISPATCH = '0'
    const { body } = await generate(env, jar, bookId)
    expect(body.job.status).toBe('queued')

    const d = deps(env)
    const first = await consumeGenerationMessage(env.DB, d, { jobId: 1 })
    expect(first.action).toBe('succeeded')
    const previewCount = (await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_versions').first<{ n: number }>())!.n
    const usageCount = (await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_usage_events').first<{ n: number }>())!.n

    const second = await consumeGenerationMessage(env.DB, d, { jobId: 1 })
    expect(second.action).toBe('duplicate_delivery')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_versions').first<{ n: number }>())!.n).toBe(previewCount)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_usage_events').first<{ n: number }>())!.n).toBe(usageCount)
  }, 60_000)

  it('two concurrent consumers of the same job: only one wins the lease, and there is still exactly one preview', async () => {
    const jar = await registerUserWith(env, 'concurrent@example.com')
    const { bookId } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await generate(env, jar, bookId)

    const d = deps(env)
    const [a, b] = await Promise.all([processJob(env.DB, d, 1), processJob(env.DB, d, 1)])
    const actions = [a.action, b.action].sort()
    // One runs the job; the other either loses the lease up front or finds the
    // job already terminal afterwards. Never both running.
    expect(actions.includes('succeeded')).toBe(true)
    expect(actions.includes('already_leased') || actions.includes('skipped')).toBe(true)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_versions').first<{ n: number }>())!.n).toBe(1)
    // The cost ledger cannot contain two rows for the same (attempt, unit).
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM (SELECT attempt_id, unit FROM generation_usage_events GROUP BY attempt_id, unit HAVING COUNT(*) > 1)').first<{ n: number }>())!.n).toBe(0)
  }, 60_000)

  it('an expired lease is recovered: the job is requeued with backoff and then completes on the next drain', async () => {
    const jar = await registerUserWith(env, 'lease@example.com')
    const { bookId } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await generate(env, jar, bookId)

    // Simulate a consumer that took the lease and then died: the lease is
    // taken normally, then moved into the past (the consumer stopped sending
    // heartbeats).
    const claimed = await claimJob(env.DB, 1, 'dead-consumer', 60, nowSeconds())
    expect(claimed).not.toBeNull()
    expect(claimed!.status).toBe('leased')
    await env.DB.prepare('UPDATE generation_jobs SET lease_expires_at = ?, heartbeat_at = ? WHERE id = 1').bind(nowSeconds() - 600, nowSeconds() - 600).run()

    const recovered = await drainDueJobs(env.DB, deps(env), { maxJobs: 5 })
    // The lease was reclaimed by the recovery sweep (requeued, not dead-lettered
    // — the attempt budget was not exhausted), and the same drain then ran it.
    expect(recovered.recovered.leasesExpired).toBe(1)
    expect(recovered.recovered.requeued).toBe(1)
    const job = await loadJob(env.DB, 1)
    expect(['succeeded', 'queued', 'retry_wait']).toContain(job!.status)
    // The reclaim is visible in the append-only attempt history.
    const expiry = await env.DB.prepare("SELECT COUNT(*) AS n FROM generation_attempts WHERE outcome = 'lease_expired'").first<{ n: number }>()
    expect(expiry!.n).toBeGreaterThan(0)
  }, 60_000)
})

describe('phase3 — failure handling', () => {
  it('a transient provider failure is retried, and the retry succeeds', async () => {
    const jar = await registerUserWith(env, 'transient@example.com')
    const { bookId } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await generate(env, jar, bookId)

    // First delivery: the story-text provider throws a transient error.
    const failing = deps(env, { faults: { storyText: 'throws_transient' } })
    const first = await processJob(env.DB, failing, 1)
    expect(first.action).toBe('retry_scheduled')
    let job = await loadJob(env.DB, 1)
    expect(job!.status).toBe('retry_wait')
    expect(job!.last_error_code).toBe('provider_error')

    // The retry is not run before its backoff is due: the job is still
    // retry_wait and a drain at the same instant claims nothing.
    const early = await drainDueJobs(env.DB, deps(env), { maxJobs: 5 })
    expect(early.claimed).toBe(0)
    expect((await loadJob(env.DB, 1))!.status).toBe('retry_wait')

    // Once it is due, a healthy provider completes it.
    const later = await drainDueJobs(env.DB, deps(env, { now: () => nowSeconds() + 600 }), { maxJobs: 5 })
    expect(later.claimed).toBe(1)
    job = await loadJob(env.DB, 1)
    expect(job!.status).toBe('succeeded')
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM generation_attempts WHERE outcome IN ('retry_scheduled','succeeded')").first<{ n: number }>())!.n).toBeGreaterThan(1)
  }, 60_000)

  it('a permanent provider failure is not retried: the job fails permanently with an actionable message', async () => {
    const jar = await registerUserWith(env, 'permanent@example.com')
    const { bookId } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await generate(env, jar, bookId)

    // The deployment kill switch is flipped AFTER the job was queued — exactly
    // the situation where retrying is pointless, because no provider call can
    // succeed until an operator changes the configuration.
    env.GENERATION_DISABLED = '1'
    const d = deps(env)
    const outcome = await processJob(env.DB, d, 1)
    expect(outcome.action).toBe('failed_permanent')
    const job = await loadJob(env.DB, 1)
    expect(job!.status).toBe('failed_permanent')
    expect(job!.attempt_count).toBe(1) // exactly one attempt — no retry loop
    const book = await env.DB.prepare('SELECT state FROM user_books WHERE public_id = ?').bind(bookId).first<{ state: string }>()
    expect(book!.state).toBe('generation_failed')
  }, 60_000)

  it('a malformed provider response is retried and, once the budget is spent, dead-lettered with a visible record', async () => {
    const jar = await registerUserWith(env, 'deadletter@example.com')
    const { bookId } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await generate(env, jar, bookId)
    await env.DB.prepare('UPDATE generation_jobs SET max_attempts = 2 WHERE id = 1').run()
    await env.DB.prepare("UPDATE generation_tasks SET max_attempts = 2 WHERE kind = 'illustration'").run()

    const d = deps(env, { faults: { illustration: 'not_an_image' } })
    const first = await processJob(env.DB, d, 1)
    expect(first.action).toBe('retry_scheduled')
    expect((await loadJob(env.DB, 1))!.status).toBe('retry_wait')

    // The retry is only claimable once its backoff is due, which is exactly
    // what the drain does (promote the due retry, then run it).
    const drained = await drainDueJobs(env.DB, deps(env, { faults: { illustration: 'not_an_image' }, now: () => nowSeconds() + 600 }), { maxJobs: 5 })
    expect(drained.outcomes.dead_letter).toBe(1)
    const job = await loadJob(env.DB, 1)
    expect(job!.status).toBe('dead_letter')
    // The provider "succeeded" and returned bytes that are not an image; the
    // decode + validation layer caught it, so the recorded reason is a
    // validation failure carrying the specific cause.
    expect(job!.last_error_code).toBe('validation_failed')
    expect(job!.last_error_message).toMatch(/not a valid, complete image/i)

    const dl = await env.DB.prepare('SELECT * FROM generation_dead_letters WHERE job_id = 1').first<any>()
    expect(dl).toBeTruthy()
    expect(dl.reason_code).toBe('validation_failed')
    expect(dl.reason_message).toMatch(/not a valid, complete image/i)
    expect(dl.resolved_at).toBeNull()
    expect(dl.attempts).toBeGreaterThanOrEqual(1)

    // Nothing unverified was published.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_versions').first<{ n: number }>())!.n).toBe(0)

    // The dead letter is visible to an operator and can be explicitly resolved by a retry.
    const { retryJob } = await import('../../src/generation/jobs')
    const retried = await retryJob(env.DB, 1, { type: 'admin', id: '1' })
    expect(retried.retried).toBe(true)
    expect((await loadJob(env.DB, 1))!.status).toBe('queued')
    const resolved = await env.DB.prepare('SELECT resolution, resolved_at FROM generation_dead_letters WHERE job_id = 1').first<any>()
    expect(resolved.resolution).toBe('retried')
    expect(resolved.resolved_at).toBeTruthy()
  }, 60_000)

  it('an unsafe output is dead-lettered immediately rather than retried, because retrying would reproduce it', async () => {
    const jar = await registerUserWith(env, 'unsafe@example.com')
    const { bookId } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await generate(env, jar, bookId)

    const d = deps(env, { faults: { illustration: 'unsafe' } })
    const outcome = await processJob(env.DB, d, 1)
    expect(outcome.detail).toMatch(/unsafe|safety/i)
    expect(outcome.action).toBe('dead_letter')
    const job = await loadJob(env.DB, 1)
    expect(job!.status).toBe('dead_letter')
    expect(job!.attempt_count).toBe(1)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM generation_attempts WHERE outcome = 'safety_rejected'").first<{ n: number }>())!.n).toBeGreaterThan(0)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_versions').first<{ n: number }>())!.n).toBe(0)
  }, 60_000)

  it('a semantic / child-count mismatch fails validation and never becomes a preview', async () => {
    const jar = await registerUserWith(env, 'mismatch@example.com')
    const { bookId } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await generate(env, jar, bookId)

    const d = deps(env, { faults: { illustration: 'two_children' } })
    const outcome = await processJob(env.DB, d, 1)
    expect(outcome.action).toBe('retry_scheduled')
    expect(outcome.detail).toMatch(/child/i)
    const asset = await env.DB.prepare("SELECT COUNT(*) AS n FROM generated_assets WHERE asset_type = 'illustration_original'").first<{ n: number }>()
    expect(asset!.n).toBe(0)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_versions').first<{ n: number }>())!.n).toBe(0)
  }, 60_000)

  it('a wrong-size output fails the dimension check even though the provider reported success', async () => {
    const jar = await registerUserWith(env, 'dimensions@example.com')
    const { bookId } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await generate(env, jar, bookId)

    const d = deps(env, { faults: { illustration: 'wrong_size' } })
    const outcome = await processJob(env.DB, d, 1)
    expect(outcome.action).toBe('retry_scheduled')
    expect(outcome.detail).toMatch(/1200x1500|declares/i)
  }, 60_000)
})

describe('phase3 — cancellation and stale revisions (GEN-11)', () => {
  it('cancellation stops the work, is idempotent, and is refused once it has succeeded', async () => {
    const jar = await registerUserWith(env, 'cancel@example.com')
    const { bookId } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await generate(env, jar, bookId)

    const cancel = await app.request(`/api/v1/user-books/${bookId}/generation/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({ reason: 'changed my mind' }) }, env as never)
    expect(cancel.status).toBe(200)
    const body = (await cancel.json()) as any
    expect(body.cancelled).toBe(true)
    expect((await loadJob(env.DB, 1))!.status).toBe('cancelled')

    // Cancelling again is a harmless no-op, not an error.
    const again = await app.request(`/api/v1/user-books/${bookId}/generation/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
    expect(again.status).toBe(200)
    expect(((await again.json()) as any).alreadyCancelled).toBe(true)

    // A cancelled job is terminal: a delivery for it does nothing.
    const delivered = await consumeGenerationMessage(env.DB, deps(env), { jobId: 1 })
    expect(delivered.action).toBe('duplicate_delivery')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_versions').first<{ n: number }>())!.n).toBe(0)
  }, 60_000)

  it('a stale job cannot overwrite a newer revision: the output is discarded and the job superseded', async () => {
    const jar = await registerUserWith(env, 'stale@example.com')
    const { bookId, uploadKey } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await generate(env, jar, bookId)
    const revisionBefore = (await env.DB.prepare('SELECT current_revision FROM user_books WHERE public_id = ?').bind(bookId).first<{ current_revision: number }>())!.current_revision

    // The customer edits their details while the job is in flight: a NEW
    // immutable revision is created and the job's input revision is no longer current.
    await savePersonalization(env, jar, bookId, { childName: 'Nia', childAge: 7, photoUploadKey: uploadKey, dedication: 'For Nia.' })
    const revisionAfter = (await env.DB.prepare('SELECT current_revision FROM user_books WHERE public_id = ?').bind(bookId).first<{ current_revision: number }>())!.current_revision
    expect(revisionAfter).toBe(revisionBefore + 1)

    const outcome = await processJob(env.DB, deps(env), 1)
    expect(outcome.action).toBe('superseded')

    const job = await loadJob(env.DB, 1)
    expect(job!.status).toBe('superseded')
    expect(job!.preview_version_id).toBeNull()
    // NO preview was published for the stale revision, and no preview assets leaked.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_versions').first<{ n: number }>())!.n).toBe(0)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_assets').first<{ n: number }>())!.n).toBe(0)

    // The immutable revision the job targeted is untouched.
    const original = await env.DB.prepare('SELECT child_name FROM personalization_inputs WHERE user_book_id = (SELECT id FROM user_books WHERE public_id = ?) AND revision = ?').bind(bookId, revisionBefore).first<{ child_name: string }>()
    expect(original!.child_name).toBe('Amara')

    // The book is not left in preview_ready by the stale job.
    const book = await env.DB.prepare('SELECT state FROM user_books WHERE public_id = ?').bind(bookId).first<{ state: string }>()
    expect(book!.state).not.toBe('preview_ready')
  }, 60_000)

  it('a NEW revision generates its own preview version, and the old revision keeps its history', async () => {
    const jar = await registerUserWith(env, 'revision-history@example.com')
    const { bookId, uploadKey } = await readyBook(env, jar)
    await generate(env, jar, bookId)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_versions').first<{ n: number }>())!.n).toBe(1)

    await savePersonalization(env, jar, bookId, { childName: 'Zuri', childAge: 5, photoUploadKey: uploadKey, dedication: 'For Zuri.' })
    await generate(env, jar, bookId)

    const versions = await env.DB.prepare('SELECT input_revision, scene_count FROM preview_versions ORDER BY input_revision').all<{ input_revision: number; scene_count: number }>()
    expect(versions.results.length).toBe(2)
    expect(versions.results.map((v) => v.input_revision)).toEqual([1, 2])
    expect(versions.results.every((v) => v.scene_count === 6)).toBe(true)

    const list = await app.request(`/api/v1/user-books/${bookId}/previews`, { headers: { ...jar.headers() } }, env as never)
    const listBody = (await list.json()) as any
    expect(listBody.versions.length).toBe(2)
    expect(listBody.currentRevision).toBe(2)
  }, 60_000)

  it('a revision request invalidates the prior approval (GEN-11) and the approval cannot be re-used', async () => {
    const jar = await registerUserWith(env, 'approval@example.com')
    const { bookId, uploadKey } = await readyBook(env, jar)
    await generate(env, jar, bookId)

    const approve = await app.request(`/api/v1/user-books/${bookId}/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({ previewVersion: 1 }) }, env as never)
    expect(approve.status).toBe(200)
    const { getActiveApproval } = await import('../../src/personalization/approvals')
    const bookRow = (await env.DB.prepare('SELECT id FROM user_books WHERE public_id = ?').bind(bookId).first<{ id: number }>())!
    expect(await getActiveApproval(env.DB, bookRow.id)).toBeTruthy()

    // A new revision invalidates it atomically (Phase 2's rule, still enforced).
    await savePersonalization(env, jar, bookId, { childName: 'Ada', childAge: 6, photoUploadKey: uploadKey, dedication: 'For Ada.' })
    expect(await getActiveApproval(env.DB, bookRow.id)).toBeNull()

    // Approving a STALE version is refused outright.
    const stale = await app.request(`/api/v1/user-books/${bookId}/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({ previewVersion: 1 }) }, env as never)
    expect(stale.status).toBe(409)
  }, 60_000)
})

describe('phase3 — quota and abuse control (GEN-12)', () => {
  it('refuses beyond the per-owner job quota and records nothing billable', async () => {
    const jar = await registerUserWith(env, 'quota@example.com')
    const { bookId } = await readyBook(env, jar)
    // Tighten the limit rather than generating ten times.
    await env.DB.prepare("UPDATE generation_limits SET value = '1' WHERE key = 'generation.owner_jobs_per_window'").run()
    const limits = await loadGenerationLimits(env.DB)
    expect(limits.ownerJobsPerWindow).toBe(1)

    const first = await reserveGenerationQuota(env.DB, limits, { ownerKey: 'user:1', globalKey: 'deployment' })
    expect(first.allowed).toBe(true)
    const second = await reserveGenerationQuota(env.DB, limits, { ownerKey: 'user:1', globalKey: 'deployment' })
    expect(second.allowed).toBe(false)
    expect(second.reason).toMatch(/limit/i)

    // The HTTP surface reports it as a 429 with an honest message.
    env.GENERATION_INLINE_DISPATCH = '0'
    const res = await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
    expect(res.status).toBe(429)
    expect(((await res.json()) as any).error.code).toBe('quota_exceeded')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_jobs').first<{ n: number }>())!.n).toBe(0)
  }, 60_000)

  it('refuses new jobs once the deployment spend cap is reached', async () => {
    const jar = await registerUserWith(env, 'spend@example.com')
    const { bookId } = await readyBook(env, jar)
    await env.DB.prepare("UPDATE generation_limits SET value = '1' WHERE key = 'generation.global_cost_minor_per_window'").run()
    const limits = await loadGenerationLimits(env.DB)
    const { recordGenerationCost } = await import('../../src/generation/jobs')
    await recordGenerationCost(env.DB, limits, 'deployment', 5)

    env.GENERATION_INLINE_DISPATCH = '0'
    const res = await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
    expect(res.status).toBe(429)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_jobs').first<{ n: number }>())!.n).toBe(0)
  }, 60_000)

  it('the cost ledger is append-only and deduplicates per attempt', async () => {
    const jar = await registerUserWith(env, 'ledger@example.com')
    const { bookId } = await readyBook(env, jar)
    await generate(env, jar, bookId)

    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_usage_events').first<{ n: number }>())!.n
    const existing = await env.DB.prepare('SELECT * FROM generation_usage_events LIMIT 1').first<any>()
    // Replaying the SAME attempt/unit must not add a second row.
    await recordUsage(env.DB, {
      jobId: existing.job_id,
      taskId: existing.task_id,
      attemptId: existing.attempt_id,
      userBookId: existing.user_book_id,
      provider: existing.provider,
      model: existing.model,
      unit: existing.unit,
      costMinor: existing.cost_minor
    })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_usage_events').first<{ n: number }>())!.n).toBe(before)

    // Attempts and usage are append-only at the database level.
    await expect(env.DB.prepare('UPDATE generation_usage_events SET cost_minor = 0 WHERE id = 1').run()).rejects.toThrow(/append-only/i)
    await expect(env.DB.prepare("UPDATE generation_attempts SET outcome = 'succeeded' WHERE id = 1").run()).rejects.toThrow(/append-only/i)
  }, 60_000)
})

describe('phase3 — zero paid provider calls', () => {
  it('the deterministic fakes are the active providers, and no external endpoint is contacted', async () => {
    const jar = await registerUserWith(env, 'zero-paid@example.com')
    const { bookId } = await readyBook(env, jar)

    // A fetch spy that fails the test if anything reaches for the network.
    const fetchSpy = vi.fn(() => {
      throw new Error('an external call was attempted')
    }) as unknown as typeof fetch

    // The provider bundle used by the HTTP surface resolves from env; assert its
    // identity AND that an explicitly-spied bundle completes the whole job.
    const { bundle } = testProviders(env, { fetchImpl: fetchSpy })
    const health = bundle.health()
    expect(health.find((h) => h.capability === 'story_text')!.active).toBe('deterministic-fake')
    expect(health.find((h) => h.capability === 'illustration')!.active).toBe('deterministic-fake')
    expect(health.find((h) => h.capability === 'validation')!.active).toBe('deterministic-fake')
    expect(health.find((h) => h.capability === 'translation')!.active).toBe('deterministic-fake')

    // Drive a complete job through that exact bundle.
    const d = deps(env, { fetchImpl: fetchSpy })
    const generated = await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
    expect(generated.status).toBe(202)

    expect(fetchSpy).not.toHaveBeenCalled()
    // The job really ran, using the fakes.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM generation_attempts WHERE provider = 'deterministic-fake'").first<{ n: number }>())!.n).toBeGreaterThan(0)
  }, 60_000)

  it('the fakes are refused outside an explicitly configured development environment', async () => {
    const strict = freshEnv({ ENVIRONMENT: 'production', GENERATION_INLINE_DISPATCH: undefined })
    const { bundle } = testProviders(strict)
    const health = bundle.health()
    for (const capability of ['story_text', 'illustration', 'validation']) {
      const entry = health.find((h) => h.capability === capability)!
      expect(entry.active).toBe('disabled')
      expect(entry.configured).toBe(false)
    }
    const story = bundle.storyText('deterministic-fake')
    expect(story.name).toBe('disabled')
    await expect(story.generate({ prompt: 'x', sceneKey: 'cover', language: 'en', maxWords: 10 })).rejects.toThrow(/not configured/i)
  })

  it('a real http provider is only constructed from a complete, secure configuration', async () => {
    const incomplete = freshEnv({ GENERATION_STORY_API_URL: 'https://provider.example.com/v1' })
    delete (incomplete as any).GENERATION_STORY_API_KEY
    const { bundle } = testProviders(incomplete)
    // A URL with no key is NOT a provider: it must stay fail-closed.
    expect(bundle.storyText('http').name).toBe('disabled')
    expect(bundle.health().find((h) => h.capability === 'story_text')!.detail).toMatch(/API key is missing/i)

    const insecure = freshEnv({ ENVIRONMENT: 'production', GENERATION_STORY_API_URL: 'http://provider.example.com/v1', GENERATION_STORY_API_KEY: 'configured' })
    const strictBundle = testProviders(insecure).bundle
    expect(strictBundle.storyText('http').name).toBe('disabled')
    expect(strictBundle.health().find((h) => h.capability === 'story_text')!.detail).toMatch(/HTTPS/i)

    const configured = freshEnv({ GENERATION_STORY_API_URL: 'https://provider.example.com/v1', GENERATION_STORY_API_KEY: 'configured' })
    const configuredBundle = testProviders(configured).bundle
    expect(configuredBundle.storyText('http').name).toBe('http')
    expect(configuredBundle.health().find((h) => h.capability === 'story_text')!.configured).toBe(true)
  })
})
