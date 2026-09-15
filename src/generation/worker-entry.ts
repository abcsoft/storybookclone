// The worker-side seam used by the companion Worker entry (src/worker.ts).
//
// Kept in its own module so the Worker entry stays a thin adapter and so both
// the queue handler and the scheduled handler share one definition of "run the
// recovery sweep, then dispatch due work" — the same ordering the tests assert.
import { drainDueJobs, type DrainReport, type PipelineDeps } from './pipeline'
import { loadGenerationLimits, recoverExpiredLeases, type RecoveryReport } from './jobs'

/**
 * Reclaims jobs (and tasks) whose consumer stopped heartbeating, using the
 * operator-configured attempt budget.
 */
export async function recoverStuckLeases(db: D1Database, deps: PipelineDeps): Promise<RecoveryReport> {
  const limits = await loadGenerationLimits(db)
  return recoverExpiredLeases(db, { now: (deps.now ?? (() => Math.floor(Date.now() / 1000)))(), jitter: deps.jitter, maxAttempts: limits.maxAttempts })
}

export { drainDueJobs }
export type { DrainReport }
