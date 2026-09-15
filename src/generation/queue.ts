// GEN-04: the queue boundary.
//
// Two things matter here, and they are the reason this is a separate module:
//
//  1. THE DURABLE TRUTH IS THE DATABASE ROW, NOT THE MESSAGE. The message is a
//     wake-up hint carrying only job ids. Every consumer re-reads the job from
//     D1, so a lost, duplicated, reordered or delayed message can never change
//     what work exists — at worst it delays it, and the scheduled recovery
//     sweep picks up anything a message failed to wake.
//
//  2. THE REAL PRODUCER IS OPTIONAL AND EXPLICIT. `CloudflareQueueProducer` is
//     used only when a `GENERATION_QUEUE` binding exists. With no binding the
//     producer is a no-op that reports `not_configured` truthfully (it never
//     pretends to have sent anything).
//
// `GENERATION_INLINE_DISPATCH=1` additionally drains due jobs in the same
// request. That exists so a single-node local/deployment without a queue
// consumer still functions, and it is gated on ENVIRONMENT=development AND the
// explicit flag, so it cannot silently become "the production architecture" —
// see docs/V2_ARCHITECTURE_BASELINE.md for the deployment decision.
import { DomainError } from '../personalization/types'
import { drainDueJobs, processJob, type DrainReport, type PipelineDeps } from './pipeline'

export type GenerationQueueMessage = {
  jobId: number
  jobPublicId: string
  correlationId: string
}

/** The slice of the Cloudflare Queues producer API this project uses. */
export type QueueSender<T> = { send(message: T, options?: unknown): Promise<void> }

export interface GenerationQueueProducer {
  readonly name: string
  send(message: GenerationQueueMessage): Promise<'sent' | 'not_configured'>
}

export class CloudflareQueueProducer implements GenerationQueueProducer {
  readonly name = 'cloudflare-queue'
  constructor(private readonly queue: QueueSender<GenerationQueueMessage>) {}
  async send(message: GenerationQueueMessage): Promise<'sent' | 'not_configured'> {
    await this.queue.send(message)
    return 'sent'
  }
}

/**
 * With no queue binding the job row is still the durable record of the work;
 * this producer records nothing and reports honestly that it sent nothing.
 */
export class NullQueueProducer implements GenerationQueueProducer {
  readonly name = 'none'
  readonly sent: GenerationQueueMessage[] = []
  async send(message: GenerationQueueMessage): Promise<'not_configured'> {
    this.sent.push(message)
    return 'not_configured'
  }
}

export type QueueEnv = { GENERATION_QUEUE?: QueueSender<GenerationQueueMessage> }

export function queueProducerFor(env: QueueEnv): GenerationQueueProducer {
  return env.GENERATION_QUEUE ? new CloudflareQueueProducer(env.GENERATION_QUEUE) : new NullQueueProducer()
}

export type DispatchEnv = {
  ENVIRONMENT?: string
  GENERATION_INLINE_DISPATCH?: string
}

/** True only in an explicitly-flagged development environment. */
export function inlineDispatchEnabled(env: DispatchEnv): boolean {
  return env.ENVIRONMENT === 'development' && String(env.GENERATION_INLINE_DISPATCH ?? '') === '1'
}

export type EnqueueDispatchResult = {
  delivered: 'sent' | 'not_configured'
  inline: DrainReport | null
  /** True when the work is durable but no consumer is configured to pick it up. */
  consumerMissing: boolean
}

/**
 * Delivers a wake-up for `jobId`. Never throws for a transport failure: the job
 * row is already durable, and the recovery sweep is the fallback path — so a
 * queue outage delays generation rather than losing it.
 */
export async function dispatchGenerationJob(db: D1Database, env: DispatchEnv, deps: PipelineDeps, job: { id: number; public_id: string; correlation_id: string }): Promise<EnqueueDispatchResult> {
  const producer = queueProducerFor(env as QueueEnv)
  let delivered: 'sent' | 'not_configured' = 'not_configured'
  try {
    delivered = await producer.send({ jobId: job.id, jobPublicId: job.public_id, correlationId: job.correlation_id })
  } catch (err) {
    // Deliberately swallowed and reported, not rethrown: the durable job is the
    // contract, and the caller's response should not claim the work was lost.
    console.error('[generation] queue delivery failed; the durable job will be picked up by the recovery sweep:', err instanceof Error ? err.message : err)
    delivered = 'not_configured'
  }

  let inline: DrainReport | null = null
  if (inlineDispatchEnabled(env)) {
    inline = await drainDueJobs(db, deps, { maxJobs: 3 })
    return { delivered, inline, consumerMissing: false }
  }
  return { delivered, inline, consumerMissing: delivered === 'not_configured' }
}

/**
 * The worker-side entry point for a batch of queue messages. Idempotent: each
 * message is a hint, and `processJob` is safe to call twice.
 */
export async function consumeBatch(db: D1Database, deps: PipelineDeps, messages: GenerationQueueMessage[]): Promise<{ acknowledged: number; outcomes: Record<string, number> }> {
  const outcomes: Record<string, number> = {}
  let acknowledged = 0
  for (const message of messages) {
    const job = await db.prepare('SELECT id, status FROM generation_jobs WHERE id = ?').bind(message.jobId).first<{ id: number; status: string }>()
    if (!job) {
      acknowledged++
      outcomes.unknown_job = (outcomes.unknown_job ?? 0) + 1
      continue
    }
    const outcome = await processJob(db, deps, job.id)
    outcomes[outcome.action] = (outcomes[outcome.action] ?? 0) + 1
    acknowledged++
  }
  return { acknowledged, outcomes }
}

/** Rejects a malformed queue message rather than guessing at it. */
export function parseQueueMessage(raw: unknown): GenerationQueueMessage {
  if (!raw || typeof raw !== 'object') throw new DomainError('invalid_queue_message', 'The queue message is not an object.', 400)
  const record = raw as Record<string, unknown>
  const jobId = Number(record.jobId)
  if (!Number.isInteger(jobId) || jobId <= 0) throw new DomainError('invalid_queue_message', 'The queue message has no usable job id.', 400)
  return {
    jobId,
    jobPublicId: typeof record.jobPublicId === 'string' ? record.jobPublicId.slice(0, 80) : '',
    correlationId: typeof record.correlationId === 'string' ? record.correlationId.slice(0, 80) : crypto.randomUUID()
  }
}
