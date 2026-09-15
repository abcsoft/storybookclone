// V2 Phase 5 — PLT-05: the durable email outbox, the provider adapter and the
// versioned templates.
//
// The property that matters most here is the one the specification calls out
// explicitly: OUTBOX RETRIES MUST NOT DUPLICATE LOGICAL MAIL. That is asserted
// three ways — one row, one attempt row per attempt, and exactly ONE delivery at
// the adapter across the whole retry sequence.
//
// Nothing in this file contacts a network: the only adapters used are the
// recording fake and an HttpEmailAdapter constructed with an injected fetch stub.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { freshEnv, type TestEnv } from '../helpers/testApp'
import { FakeEmailAdapter, setEmailAdapterForTests, clearEmailAdapterOverrideForTests } from '../../src/email'
import { enqueueEmail, sendEmailNow, drainEmailOutbox, deliverOutboxRow, retryDelaySeconds, outboxCounts, type OutboxRow } from '../../src/mail/outbox'
import { HttpEmailAdapter, httpProviderReady, resolveMailProvider, mailProviderStatus } from '../../src/mail/provider'
import { EMAIL_TEMPLATE_KEYS, renderEmailTemplate, renderPlaceholders, loadEmailTemplate } from '../../src/mail/templates'
import { requestPasswordReset } from '../../src/password-reset'

let env: TestEnv

afterEach(() => {
  clearEmailAdapterOverrideForTests()
  vi.restoreAllMocks()
})

function newEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return freshEnv(overrides)
}

const VARS = { brandName: 'Test Brand', name: 'Ada', actionUrl: 'https://example.test/verify?token=abc', expiresMinutes: '60' }

describe('phase5 — PLT-05 templates', () => {
  it('ships a published template for every key the application can enqueue', async () => {
    env = newEnv()
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const row = await loadEmailTemplate(env.DB, key, 'en')
      expect(row, `no published template for ${key}`).toBeTruthy()
      expect(row!.status).toBe('published')
    }
  })

  it('refuses to render with a missing variable rather than sending an incomplete message', () => {
    expect(() => renderPlaceholders('Hello {{name}}', {})).toThrow(/missing value\(s\) for: name/)
    expect(renderPlaceholders('Hello {{name}}', { name: 'Ada' })).toBe('Hello Ada')
  })

  it('fails loudly for an unknown template key instead of sending an empty email', async () => {
    env = newEnv()
    await expect(renderEmailTemplate(env.DB, 'not_a_template', VARS)).rejects.toThrow(/No published email template/)
  })

  it('escapes substituted values in the HTML body, so a customer-supplied name cannot inject markup', async () => {
    env = newEnv()
    const rendered = await renderEmailTemplate(env.DB, 'verify_email', { ...VARS, name: '<img src=x onerror=alert(1)>' })
    expect(rendered.bodyHtml).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(rendered.bodyHtml).not.toContain('<img src=x')
    // The text body keeps the value verbatim — it is not markup.
    expect(rendered.bodyText).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('phase5 — PLT-05 deduplication and retry', () => {
  it('treats the same dedupe key as ONE logical mail, and reports the duplicate', async () => {
    env = newEnv()
    const fake = new FakeEmailAdapter()
    setEmailAdapterForTests(fake)

    const first = await enqueueEmail(env.DB, env, { dedupeKey: 'logical-1', templateKey: 'verify_email', to: 'a@example.test', variables: VARS })
    const second = await enqueueEmail(env.DB, env, { dedupeKey: 'logical-1', templateKey: 'verify_email', to: 'a@example.test', variables: VARS })

    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    expect(second.id).toBe(first.id)
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_outbox').first<{ n: number }>()
    expect(rows!.n).toBe(1)
  })

  it('retrying a failed delivery never produces a second message: one row, one attempt per try, exactly ONE send', async () => {
    env = newEnv()
    let failNext = true
    const recording = new FakeEmailAdapter()
    setEmailAdapterForTests({
      name: 'flaky',
      send: async (email) => {
        if (failNext) {
          failNext = false
          throw Object.assign(new Error('provider temporarily unavailable'), { code: 'provider_5xx' })
        }
        return recording.send(email)
      }
    })

    const queued = await sendEmailNow(env.DB, env, { dedupeKey: 'retry-me', templateKey: 'order_paid', to: 'b@example.test', variables: { ...VARS, orderNumber: '7', amountPaid: '$10.00', orderUrl: '/order-success?id=7' } })
    expect(queued.status).toBe('queued') // failed once, still deliverable

    let row = await env.DB.prepare('SELECT * FROM email_outbox WHERE dedupe_key = ?').bind('retry-me').first<OutboxRow>()
    expect(row!.attempt_count).toBe(1)
    expect(row!.available_at).toBeGreaterThan(Math.floor(Date.now() / 1000) - 1)

    // The retry sweep, run "later", delivers it — through the SAME row.
    const drained = await drainEmailOutbox(env.DB, env, { now: Number(row!.available_at) + 1 })
    expect(drained.sent).toBe(1)

    row = await env.DB.prepare('SELECT * FROM email_outbox WHERE dedupe_key = ?').bind('retry-me').first<OutboxRow>()
    expect(row!.status).toBe('sent')
    expect(row!.attempt_count).toBe(2)

    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_outbox').first<{ n: number }>()
    expect(rows!.n).toBe(1)
    const attempts = await env.DB.prepare('SELECT attempt_no, outcome FROM email_attempts WHERE outbox_id = ? ORDER BY attempt_no').bind(row!.id).all<{ attempt_no: number; outcome: string }>()
    expect((attempts.results || []).map((a) => [Number(a.attempt_no), a.outcome])).toEqual([[1, 'failed'], [2, 'sent']])
    // THE POINT: one logical mail, one delivered copy.
    expect(recording.sent).toHaveLength(1)
    expect(recording.sent[0].to).toBe('b@example.test')
    expect(recording.sent[0].idempotencyKey).toBe('retry-me')
  })

  it('stops retrying after max_attempts and records the terminal failure honestly', async () => {
    env = newEnv()
    setEmailAdapterForTests({
      send: async () => {
        throw Object.assign(new Error('still down'), { code: 'provider_5xx' })
      }
    })
    await sendEmailNow(env.DB, env, { dedupeKey: 'dead', templateKey: 'verify_email', to: 'c@example.test', variables: VARS, maxAttempts: 2 })
    let row = await env.DB.prepare('SELECT * FROM email_outbox WHERE dedupe_key = ?').bind('dead').first<OutboxRow>()
    await drainEmailOutbox(env.DB, env, { now: Number(row!.available_at) + 1 })
    row = await env.DB.prepare('SELECT * FROM email_outbox WHERE dedupe_key = ?').bind('dead').first<OutboxRow>()
    expect(row!.status).toBe('failed')
    expect(row!.attempt_count).toBe(2)
    expect(row!.last_error_code).toBe('provider_5xx')
    // A 'failed' row is never picked up again.
    const again = await drainEmailOutbox(env.DB, env, { now: Number(row!.available_at) + 10_000 })
    expect(again.claimed).toBe(0)
  })

  it('uses a bounded, deterministic backoff', () => {
    expect(retryDelaySeconds(1)).toBe(60)
    expect(retryDelaySeconds(2)).toBe(120)
    expect(retryDelaySeconds(3)).toBe(240)
    expect(retryDelaySeconds(99)).toBe(3600)
  })

  it('the database refuses to re-queue a sent message, and refuses to change its content', async () => {
    env = newEnv()
    setEmailAdapterForTests(new FakeEmailAdapter())
    await sendEmailNow(env.DB, env, { dedupeKey: 'immutable', templateKey: 'verify_email', to: 'd@example.test', variables: VARS })
    await expect(env.DB.prepare("UPDATE email_outbox SET status = 'queued' WHERE dedupe_key = 'immutable'").run()).rejects.toThrow(/cannot be re-queued/i)
    await expect(env.DB.prepare("UPDATE email_outbox SET to_email = 'someone-else@example.test' WHERE dedupe_key = 'immutable'").run()).rejects.toThrow(/immutable/i)
  })

  it('records an atomic attempt number, so a duplicated worker cannot deliver twice', async () => {
    env = newEnv()
    setEmailAdapterForTests(new FakeEmailAdapter())
    const queued = await enqueueEmail(env.DB, env, { dedupeKey: 'attempt-race', templateKey: 'verify_email', to: 'e@example.test', variables: VARS })
    const row = await env.DB.prepare('SELECT * FROM email_outbox WHERE id = ?').bind(queued.id).first<OutboxRow>()
    // Two workers both think this is attempt 1; the second INSERT must lose.
    await deliverOutboxRow(env.DB, env, row)
    const stale = { ...row } as OutboxRow
    await deliverOutboxRow(env.DB, env, stale)
    const attempts = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_attempts WHERE attempt_no = 1').first<{ n: number }>()
    expect(attempts!.n).toBe(1)
  })
})

describe('phase5 — PLT-05 truthful "disabled by default" behaviour', () => {
  it('with no provider configured, queues the message, records it as SUPPRESSED, and sends nothing', async () => {
    env = newEnv({ ENVIRONMENT: 'production' })
    const globalFetch = vi.fn(() => {
      throw new Error('NO NETWORK CALL IS PERMITTED IN THIS TEST')
    })
    vi.stubGlobal('fetch', globalFetch)

    const status = mailProviderStatus(env)
    expect(status.deliveryMode).toBe('disabled')
    expect(status.deliversRealMail).toBe(false)
    expect(status.detail).toMatch(/no email provider is configured/i)

    const result = await sendEmailNow(env.DB, env, { dedupeKey: 'suppressed-1', templateKey: 'verify_email', to: 'f@example.test', variables: VARS })
    expect(result.status).toBe('suppressed')
    expect(result.delivery?.errorCode).toBe('no_provider_configured')

    const row = await env.DB.prepare('SELECT * FROM email_outbox WHERE dedupe_key = ?').bind('suppressed-1').first<OutboxRow>()
    expect(row!.suppressed_reason).toBe('no_provider_configured')
    expect(row!.sent_at).toBeNull()
    // The durable record exists, and nothing was sent anywhere.
    expect((await outboxCounts(env.DB)).suppressed).toBe(1)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('a configured-but-INCOMPLETE http provider is a truthful misconfiguration, not a weaker fallback', () => {
    const incomplete = mailProviderStatus({ ENVIRONMENT: 'production', EMAIL_PROVIDER: 'http', EMAIL_API_URL: 'https://mail.example.test/send' })
    expect(incomplete.deliveryMode).toBe('disabled')
    expect(incomplete.detail).toMatch(/EMAIL_API_KEY is missing/)
    expect(httpProviderReady({ EMAIL_PROVIDER: 'http', EMAIL_API_URL: 'https://mail.example.test/send', EMAIL_API_KEY: 'x', ENVIRONMENT: 'production' }).reason).toMatch(/EMAIL_FROM is missing/)
    // A non-https endpoint is refused outside explicit development.
    expect(httpProviderReady({ EMAIL_PROVIDER: 'http', EMAIL_API_URL: 'http://mail.example.test/send', EMAIL_API_KEY: 'x', EMAIL_FROM: 'a@b.test', ENVIRONMENT: 'production' }).ready).toBe(false)
  })

  it('the console adapter is refused outside an explicit development environment', () => {
    expect(mailProviderStatus({ ENVIRONMENT: 'production', EMAIL_PROVIDER: 'console' }).deliveryMode).toBe('disabled')
    const dev = mailProviderStatus({ ENVIRONMENT: 'development', EMAIL_PROVIDER: 'console' })
    expect(dev.deliveryMode).toBe('development-console')
    expect(dev.deliversRealMail).toBe(false)
  })

  it('a test override always wins, in every environment — the Phase-1 precedence is preserved', () => {
    const fake = new FakeEmailAdapter()
    setEmailAdapterForTests(fake)
    const resolved = resolveMailProvider({ ENVIRONMENT: 'production', EMAIL_PROVIDER: 'http', EMAIL_API_URL: 'https://x.test', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.test' })
    expect(resolved.status.deliveryMode).toBe('test-double')
    expect(resolved.adapter).toBe(fake)
  })
})

describe('phase5 — PLT-05 the real provider adapter (production-shaped, never called for real)', () => {
  it('sends one authenticated JSON request and reads the provider message id back', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ id: 'msg_123' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const adapter = new HttpEmailAdapter({ endpoint: 'https://mail.example.test/v1/send', apiKey: 'test-key-value', from: 'Store <store@example.test>', fetchImpl })
    const result = await adapter.send({ to: 'g@example.test', subject: 'Hello', text: 'Body', html: '<p>Body</p>', idempotencyKey: 'logical-9' })

    expect(result.providerMessageId).toBe('msg_123')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://mail.example.test/v1/send')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-key-value')
    expect(headers['Idempotency-Key']).toBe('logical-9')
    const body = JSON.parse(String(calls[0].init.body))
    expect(body).toMatchObject({ from: 'Store <store@example.test>', to: 'g@example.test', subject: 'Hello' })
  })

  it('reports a provider rejection by status only — never by echoing the response body', async () => {
    const fetchImpl = (async () => new Response('{"secret":"leaked-response-body"}', { status: 500 })) as unknown as typeof fetch
    const adapter = new HttpEmailAdapter({ endpoint: 'https://mail.example.test/v1/send', apiKey: 'k', from: 'a@b.test', fetchImpl })
    await expect(adapter.send({ to: 'h@example.test', subject: 's', text: 't' })).rejects.toThrow(/HTTP 500/)
    await expect(adapter.send({ to: 'h@example.test', subject: 's', text: 't' })).rejects.not.toThrow(/leaked-response-body/)
  })
})

describe('phase5 — PLT-05 the password-reset path uses the same outbox', () => {
  it('records ONE outbox row for a reset request and delivers it through the adapter exactly once', async () => {
    env = newEnv()
    const fake = new FakeEmailAdapter()
    setEmailAdapterForTests(fake)
    await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Ada', 'reset@example.test', 'pbkdf2$aa$bb', 'customer')").run()

    await requestPasswordReset(env.DB, 'reset@example.test', 'https://example.test/reset-password', 'test')

    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0].text).toContain('https://example.test/reset-password?token=')
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_outbox').first<{ n: number }>()
    expect(rows!.n).toBe(1)
    const row = await env.DB.prepare('SELECT * FROM email_outbox').first<OutboxRow>()
    expect(row!.template_key).toBe('password_reset')
    expect(row!.status).toBe('sent')

    // A second request is a NEW logical mail (new token) — it must not be deduped away.
    await requestPasswordReset(env.DB, 'reset@example.test', 'https://example.test/reset-password', 'test')
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_outbox').first<{ n: number }>()
    expect(after!.n).toBe(2)
  })
})
