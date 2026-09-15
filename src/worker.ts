// V2 Phase 3 — the companion Cloudflare Worker that CONSUMES generation work.
//
// WHY THIS FILE EXISTS (the deployment decision)
// ----------------------------------------------
// The application is a Hono app deployed to **Cloudflare Pages**
// (`wrangler.jsonc` → `pages_build_output_dir: ./dist`, `npm run deploy` →
// `wrangler pages deploy dist`). It keeps serving every request exactly as
// before; the framework, the runtime bindings (D1 + R2) and the build are
// unchanged.
//
// What Pages cannot host is a **Queue consumer**: a `queue()` handler is a
// Worker entry point, and a Queue consumer (with its retry/dead-letter policy)
// is configured on a Worker, not on a Pages project. Rather than migrate the
// whole application's deployment model — a large, risky change that Phase 3
// does not need — the smallest Cloudflare-compatible adjustment is this
// companion Worker:
//
//   * `queue()`      — the real consumer. It imports the SAME domain modules
//                      (`src/generation/*`) and therefore runs the SAME
//                      idempotent, lease-based pipeline as everything else.
//   * `scheduled()`  — a recovery + dispatch sweep, so work still progresses
//                      when the Queue producer path is unavailable.
//   * `fetch()`      — deliberately minimal: a liveness probe and nothing else.
//
// Both deployments bind to the SAME D1 database and the SAME private R2 bucket,
// so the queue consumer and the web app share one source of truth. The durable
// job rows in D1 — not the messages — are what guarantee exactly-once
// *effective* work, which is why this indirection is safe: a lost, duplicated
// or delayed message can only change WHEN work happens, never WHAT happens.
//
// Nothing here mints a URL, exposes a credential, or returns provider detail.
import { runRetentionSweep } from './personalization/retention'
import { getGenerationProviders } from './generation/providers'
import { consumeBatch, parseQueueMessage, type GenerationQueueMessage } from './generation/queue'
import { drainDueJobs, recoverStuckLeases } from './generation/worker-entry'

export type WorkerEnv = {
  DB: D1Database
  PHOTOS?: R2Bucket
  ENVIRONMENT?: string
  GENERATION_DISABLED?: string
  GENERATION_QUEUE?: unknown
  GENERATION_STORY_API_URL?: string
  GENERATION_STORY_API_KEY?: string
  GENERATION_ILLUSTRATION_API_URL?: string
  GENERATION_ILLUSTRATION_API_KEY?: string
  GENERATION_TRANSLATION_API_URL?: string
  GENERATION_TRANSLATION_API_KEY?: string
  GENERATION_VALIDATION_API_URL?: string
  GENERATION_VALIDATION_API_KEY?: string
  FACE_ANALYSIS_API_URL?: string
  FACE_ANALYSIS_API_KEY?: string
  FACE_ANALYSIS_PROVIDER?: string
  /** Bounded per-invocation work, so one sweep can never run away. */
  GENERATION_DISPATCH_MAX_JOBS?: string
  /** '1' runs the generation recovery/dispatch sweep only; retention stays Phase 8's cron. */
  GENERATION_SCHEDULED_GRACE_SECONDS?: string
}

function maxJobs(env: WorkerEnv, fallback: number): number {
  const value = Number(env.GENERATION_DISPATCH_MAX_JOBS)
  return Number.isFinite(value) && value > 0 ? Math.min(50, Math.floor(value)) : fallback
}

/** The provider bundle for this environment. Identical resolution rules as the web app. */
function depsFor(env: WorkerEnv) {
  return { providers: getGenerationProviders(env, env.PHOTOS) }
}

export default {
  /**
   * The application itself is served by the Pages deployment. This companion
   * Worker exposes ONLY a liveness probe — it has no product routes, so there
   * is no second surface to keep authorized.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, role: 'generation-consumer' })
    }
    return new Response('Not found', { status: 404 })
  },

  /**
   * The real Queue consumer. Each message is a hint carrying a job id; the job
   * row is re-read from D1 and every step is a guarded compare-and-swap, so a
   * redelivered message is harmless.
   *
   * A message is only retried for an INFRASTRUCTURE failure (e.g. D1
   * unavailable). A business failure is already recorded on the job and moves
   * it through retry/dead-letter in D1, so retrying the MESSAGE would only
   * duplicate work — hence the distinction below.
   */
  async queue(batch: { messages: Array<{ body: unknown; retry(): void; ack(): void }> }, env: WorkerEnv): Promise<void> {
    const deps = depsFor(env)
    for (const message of batch.messages) {
      try {
        const parsed: GenerationQueueMessage = parseQueueMessage(message.body)
        const result = await consumeBatch(env.DB, deps, [parsed])
        void result
        message.ack()
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        if (/invalid_queue_message/.test(text)) {
          // A malformed message can never become valid: acknowledge it so it
          // does not occupy the queue forever.
          message.ack()
          continue
        }
        console.error('[generation-consumer] infrastructure failure while consuming a message; retrying:', text)
        message.retry()
      }
    }
  },

  /**
   * Recovery + dispatch sweep. Runs on the cron in `wrangler.generation-worker.jsonc`.
   *
   * Order matters: reclaim leases from consumers that died FIRST, then promote
   * due retries, then dispatch. That ordering means a job whose consumer
   * vanished is picked up in the same tick as newly queued work.
   */
  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    const deps = depsFor(env)
    const recovery = await recoverStuckLeases(env.DB, deps)
    const drain = await drainDueJobs(env.DB, deps, { maxJobs: maxJobs(env, 10) })
    console.log('[generation-consumer] sweep complete', JSON.stringify({ recovery, drain: { claimed: drain.claimed, outcomes: drain.outcomes, promotedRetries: drain.promotedRetries } }))
  }
}

/**
 * Scheduled retention is Phase 8's cron (PLT-10). The function is exported here
 * so a deployment can opt in to running the SAME retention sweep from this
 * worker without a second code path — it is never called implicitly.
 */
export async function runScheduledRetention(env: WorkerEnv) {
  return runRetentionSweep(env.DB, env.PHOTOS, () => Math.floor(Date.now() / 1000))
}
