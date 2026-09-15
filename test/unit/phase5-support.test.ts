// V2 Phase 5 — CUS-12: support tickets, messages and safe attachments.
//
// Two properties are asserted here beyond the happy path:
//   * OWNERSHIP: a ticket thread is readable only by the account that opened it —
//     a foreign ticket, a foreign attachment and a foreign message are all
//     ordinary 404s;
//   * ATTACHMENT SAFETY: the declared type must match the FILE'S OWN BYTES, markup
//     is refused, and the served response is always an inert download (attachment
//     disposition, nosniff, sandboxed CSP) rather than something a browser could
//     execute.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app, freshEnv, makeValidJpegBytes, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { FakeEmailAdapter, setEmailAdapterForTests, clearEmailAdapterOverrideForTests } from '../../src/email'
import { validateSupportAttachment, SUPPORT_ATTACHMENT_MAX_BYTES, safeOriginalName, supportObjectKey } from '../../src/account/attachments'
import { CUSTOMER_TICKET_TRANSITIONS } from '../../src/account/support'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
  setEmailAdapterForTests(new FakeEmailAdapter())
})

afterEach(() => {
  clearEmailAdapterOverrideForTests()
})

async function register(email: string, name = 'Support Customer'): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/register',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name, email, password: 'password123' }) },
    env as never
  )
  jar.observe(res)
  return jar
}

function get(jar: CookieJar | null, path: string) {
  return app
    .request(path, { headers: jar ? { ...jar.headers() } : {} }, env as never)
    .then((res) => {
      jar?.observe(res)
      return res
    })
}

function postJson(jar: CookieJar | null, path: string, body: unknown) {
  return app
    .request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(jar ? jar.headers() : {}) }, body: JSON.stringify(body) }, env as never)
    .then((res) => {
      jar?.observe(res)
      return res
    })
}

function postForm(jar: CookieJar, path: string, fields: Record<string, string>, file?: { name: string; type: string; bytes: Uint8Array }) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  if (file) form.append('attachment', new File([file.bytes], file.name, { type: file.type }))
  return app
    .request(path, { method: 'POST', headers: { ...jar.headers() }, body: form }, env as never)
    .then((res) => {
      jar.observe(res)
      return res
    })
}

async function newTicket(jar: CookieJar, body: Record<string, unknown> = {}) {
  const res = await postJson(jar, '/api/v1/support/tickets', {
    subject: 'My preview shows the wrong animal',
    category: 'personalization',
    body: 'On page three the fox should be a badger.',
    ...body
  })
  return res
}

describe('phase5 — CUS-12 tickets and messages', () => {
  it('creates a ticket with its first message and an append-only created event', async () => {
    const jar = await register('ticket-create@example.test')
    const res = await newTicket(jar)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ticket.id).toMatch(/^tk_[a-f0-9]{32}$/)
    expect(body.ticket.status).toBe('open')
    expect(body.ticket.categoryLabel).toBe('Personalization')
    expect(body.ticket.expectation).toMatch(/queued for our team/i)

    const messages = await env.DB.prepare('SELECT author_type, is_internal FROM support_messages').all<{ author_type: string; is_internal: number }>()
    expect(messages.results).toHaveLength(1)
    expect(messages.results![0].author_type).toBe('customer')
    expect(Number(messages.results![0].is_internal)).toBe(0)
    const events = await env.DB.prepare('SELECT event_type, to_status FROM support_ticket_events').all<{ event_type: string; to_status: string }>()
    expect((events.results || []).map((e) => e.event_type)).toContain('created')

    // The thread is readable back with the customer's own words.
    const detail = await (await get(jar, `/api/v1/support/tickets/${body.ticket.id}`)).json()
    expect(detail.messages).toHaveLength(1)
    expect(detail.messages[0].body).toContain('fox should be a badger')
    expect(detail.messages[0].authorLabel).toBe('You')
  })

  it('validates the subject, category and message before writing anything', async () => {
    const jar = await register('ticket-validation@example.test')
    expect((await newTicket(jar, { subject: '' })).status).toBe(400)
    expect((await newTicket(jar, { category: 'complaint' })).status).toBe(400)
    expect((await newTicket(jar, { body: 'too short' })).status).toBe(400)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM support_tickets').first<{ n: number }>())!.n).toBe(0)
  })

  it('an optional order reference must be the caller\'s OWN order', async () => {
    const owner = await register('ticket-order-owner@example.test')
    const other = await register('ticket-order-other@example.test')
    const order = await env.DB.prepare(
      `INSERT INTO orders (user_id, full_name, email, address, city, country, subtotal, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, status)
       VALUES ((SELECT id FROM users WHERE email = 'ticket-order-owner@example.test'), 'Owner', 'ticket-order-owner@example.test', '1 St', 'Town', 'US', 10, 10, 1000, 0, 0, 1000, 'USD', 'paid')`
    ).run()
    const orderId = Number(order.meta.last_row_id)

    expect((await newTicket(owner, { orderId })).status).toBe(201)
    // The other account cannot attach someone else's order to its own thread.
    const foreign = await newTicket(other, { orderId })
    expect(foreign.status).toBe(400)
    expect((await foreign.json()).error.fields.orderId).toMatch(/not one of your orders/i)
  })

  it('moves to waiting_staff when the customer replies, refuses a reply on a closed ticket, and reopens it', async () => {
    const jar = await register('ticket-flow@example.test')
    const ticket = (await (await newTicket(jar)).json()).ticket

    const replied = await postJson(jar, `/api/v1/support/tickets/${ticket.id}/messages`, { body: 'Here is some more detail for you.' })
    expect(replied.status).toBe(200)
    const repliedBody = await replied.json()
    expect(repliedBody.ticket.status).toBe('waiting_staff')
    expect(repliedBody.ticket.expectation).toMatch(/working on this/i)

    const closed = await postJson(jar, `/api/v1/support/tickets/${ticket.id}/status`, { to: 'closed' })
    expect(closed.status).toBe(200)
    expect((await closed.json()).ticket.status).toBe('closed')

    const blocked = await postJson(jar, `/api/v1/support/tickets/${ticket.id}/messages`, { body: 'One more thing after closing.' })
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).error.code).toBe('ticket_closed')

    const reopened = await postJson(jar, `/api/v1/support/tickets/${ticket.id}/status`, { to: 'open' })
    expect(reopened.status).toBe(200)
    expect((await reopened.json()).ticket.status).toBe('open')

    // Every accepted change left an append-only history row.
    const events = await env.DB.prepare('SELECT from_status, to_status FROM support_ticket_events ORDER BY id').all<{ from_status: string | null; to_status: string }>()
    const transitions = (events.results || []).map((e) => `${e.from_status}->${e.to_status}`)
    expect(transitions).toContain('open->waiting_staff')
    expect(transitions).toContain('waiting_staff->closed')
    expect(transitions).toContain('closed->open')
  })

  it('a customer cannot perform an operator-only transition, and the database refuses an illegal one', async () => {
    const jar = await register('ticket-operator@example.test')
    const ticket = (await (await newTicket(jar)).json()).ticket

    // 'assigned' is an operator state: a customer may not set it.
    expect(CUSTOMER_TICKET_TRANSITIONS.open).not.toContain('assigned')
    const attempt = await postJson(jar, `/api/v1/support/tickets/${ticket.id}/status`, { to: 'assigned' })
    expect(attempt.status).toBe(409)

    // The status trigger is the final authority, even against direct SQL.
    await env.DB.prepare("UPDATE support_tickets SET status = 'closed' WHERE public_id = ?").bind(ticket.id).run()
    await expect(env.DB.prepare("UPDATE support_tickets SET status = 'assigned' WHERE public_id = ?").bind(ticket.id).run()).rejects.toThrow(/invalid support ticket status transition/i)
  })

  it('hides an operator\'s internal note from the customer thread', async () => {
    const jar = await register('ticket-internal@example.test')
    const ticket = (await (await newTicket(jar)).json()).ticket
    const ticketRow = await env.DB.prepare('SELECT id FROM support_tickets WHERE public_id = ?').bind(ticket.id).first<{ id: number }>()
    await env.DB.prepare("INSERT INTO support_messages (public_id, ticket_id, author_type, author_id, body, is_internal) VALUES ('sm_internal_1', ?, 'staff', '1', 'Internal note: check the template scene 3.', 1)")
      .bind(ticketRow!.id)
      .run()

    const detail = await (await get(jar, `/api/v1/support/tickets/${ticket.id}`)).json()
    expect(detail.messages.some((m: any) => /Internal note/i.test(m.body))).toBe(false)
    // And it is not reachable through any other customer surface either.
    const list = await (await get(jar, '/api/v1/support/tickets')).json()
    expect(JSON.stringify(list)).not.toMatch(/Internal note/)
  })
})

describe('phase5 — CUS-12 two-user denial on every support surface', () => {
  it('a stranger cannot list, read, reply to, change or download from another customer\'s ticket', async () => {
    const owner = await register('support-owner@example.test')
    const stranger = await register('support-stranger@example.test')
    const created = await newTicket(owner)
    const ticket = (await created.json()).ticket

    const strangerList = await (await get(stranger, '/api/v1/support/tickets')).json()
    expect(strangerList.tickets).toEqual([])

    expect((await get(stranger, `/api/v1/support/tickets/${ticket.id}`)).status).toBe(404)
    expect((await postJson(stranger, `/api/v1/support/tickets/${ticket.id}/messages`, { body: 'Let me in please.' })).status).toBe(404)
    expect((await postJson(stranger, `/api/v1/support/tickets/${ticket.id}/status`, { to: 'closed' })).status).toBe(404)

    // The owner's thread is untouched by the attempts.
    const detail = await (await get(owner, `/api/v1/support/tickets/${ticket.id}`)).json()
    expect(detail.messages).toHaveLength(1)
    expect(detail.ticket.status).toBe('open')

    // An attachment on the owner's ticket is not readable by the stranger.
    const attachment = await postForm(
      owner,
      `/api/v1/support/tickets/${ticket.id}/messages`,
      { body: 'Here is the screenshot.' },
      { name: 'screenshot.jpg', type: 'image/jpeg', bytes: makeValidJpegBytes(900, 900) }
    )
    const attachmentId = (await attachment.json()).attachmentId
    expect(attachmentId).toBeTruthy()
    expect((await get(stranger, `/api/v1/support/attachments/${attachmentId}`)).status).toBe(404)
    expect((await get(owner, `/api/v1/support/attachments/${attachmentId}`)).status).toBe(200)
  })

  it('requires a signed-in account for every support route', async () => {
    expect((await get(null, '/api/v1/support/tickets')).status).toBe(401)
    expect((await postJson(null, '/api/v1/support/tickets', { subject: 's', category: 'other', body: 'a long enough body' })).status).toBe(401)
    expect((await get(null, '/api/v1/support/tickets/tk_does_not_exist')).status).toBe(401)
  })
})

describe('phase5 — CUS-12 attachment validation is byte-level, not declaration-level', () => {
  it('accepts a real JPEG and serves it as an inert, sandboxed download', async () => {
    const jar = await register('attach-ok@example.test')
    const ticket = (await (await newTicket(jar)).json()).ticket
    const uploaded = await postForm(
      jar,
      `/api/v1/support/tickets/${ticket.id}/messages`,
      { body: 'Attaching the photo of the page.' },
      { name: 'page.jpg', type: 'image/jpeg', bytes: makeValidJpegBytes(900, 900) }
    )
    expect(uploaded.status).toBe(200)
    const attachmentId = (await uploaded.json()).attachmentId
    expect(attachmentId).toMatch(/^sa_[a-f0-9]{32}$/)

    const row = await env.DB.prepare('SELECT object_key, content_type, byte_size FROM support_attachments WHERE public_id = ?').bind(attachmentId).first<{ object_key: string; content_type: string; byte_size: number }>()
    // Stored under the private support prefix, with a server-generated key.
    expect(row!.object_key).toMatch(/^support\/tk_[a-f0-9]{32}\/[a-f0-9]{32}\.jpg$/)
    expect(row!.content_type).toBe('image/jpeg')
    expect(Number(row!.byte_size)).toBeGreaterThan(0)

    const served = await get(jar, `/api/v1/support/attachments/${attachmentId}`)
    expect(served.status).toBe(200)
    expect(served.headers.get('Content-Type')).toBe('image/jpeg')
    expect(served.headers.get('Content-Disposition')).toMatch(/^attachment/)
    expect(served.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(served.headers.get('Content-Security-Policy')).toMatch(/sandbox/)
    expect(served.headers.get('Cache-Control')).toMatch(/no-store/)
  })

  it('refuses markup wearing a text/plain label, a type that does not match the bytes, and an oversize file', async () => {
    const jar = await register('attach-negative@example.test')
    const ticket = (await (await newTicket(jar)).json()).ticket
    const html = new TextEncoder().encode('<!doctype html><html><body><script>alert(1)</script></body></html>')

    const markup = await postForm(jar, `/api/v1/support/tickets/${ticket.id}/messages`, { body: 'Here you go.' }, { name: 'note.txt', type: 'text/plain', bytes: html })
    expect(markup.status).toBe(400)
    expect(JSON.stringify(await markup.json())).toMatch(/markup/i)

    const mismatch = await postForm(jar, `/api/v1/support/tickets/${ticket.id}/messages`, { body: 'Here you go.' }, { name: 'evil.jpg', type: 'image/jpeg', bytes: html })
    expect(mismatch.status).toBe(400)
    expect(JSON.stringify(await mismatch.json())).toMatch(/does not match its type|not a JPEG/i)

    const svg = await postForm(jar, `/api/v1/support/tickets/${ticket.id}/messages`, { body: 'Here you go.' }, { name: 'x.svg', type: 'image/svg+xml', bytes: html })
    expect(svg.status).toBe(400)

    const big = new Uint8Array(SUPPORT_ATTACHMENT_MAX_BYTES + 1024)
    const oversize = await postForm(jar, `/api/v1/support/tickets/${ticket.id}/messages`, { body: 'Here you go.' }, { name: 'big.jpg', type: 'image/jpeg', bytes: big })
    expect(oversize.status).toBe(400)

    // NOTHING was stored or written for any rejected attempt.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM support_attachments').first<{ n: number }>())!.n).toBe(0)
    // The rejected message was not silently recorded either.
    const detail = await (await get(jar, `/api/v1/support/tickets/${ticket.id}`)).json()
    expect(detail.messages).toHaveLength(1)
  })

  it('rejects a truncated image, a binary-pretending-to-be-text file, and a mismatched PDF', async () => {
    const jpeg = makeValidJpegBytes(900, 900)
    const truncated = jpeg.slice(0, Math.floor(jpeg.length * 0.5))

    const badImage = await validateSupportAttachment({ declaredType: 'image/jpeg', bytes: truncated, originalName: 'x.jpg' })
    expect(badImage.ok).toBe(false)

    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x41, 0x42])
    const notText = await validateSupportAttachment({ declaredType: 'text/plain', bytes: binary, originalName: 'x.txt' })
    expect(notText.ok).toBe(false)

    const notPdf = await validateSupportAttachment({ declaredType: 'application/pdf', bytes: new TextEncoder().encode('just some words'), originalName: 'x.pdf' })
    expect(notPdf.ok).toBe(false)

    // And a genuine plain-text note IS accepted.
    const ok = await validateSupportAttachment({ declaredType: 'text/plain', bytes: new TextEncoder().encode('Line one\nLine two with a < character.'), originalName: 'note.txt' })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.contentType).toBe('text/plain')
  })

  it('sanitizes the display filename and never derives the storage key from it', () => {
    expect(safeOriginalName('../../etc/passwd')).toBe('.._.._etc_passwd'.replace(/^\.+/, ''))
    expect(safeOriginalName('a\u0000b.jpg')).toBe('ab.jpg')
    expect(safeOriginalName('')).toBe('')
    const key = supportObjectKey('tk_abc', 'jpg')
    expect(key).toMatch(/^support\/tk_abc\/[a-f0-9]{32}\.jpg$/)
    // A hostile ticket id cannot escape the prefix.
    expect(supportObjectKey('../../../etc', 'png')).toMatch(/^support\/etc\/[a-f0-9]{32}\.png$/)
  })
})
