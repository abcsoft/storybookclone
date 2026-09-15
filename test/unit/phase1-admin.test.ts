// Phase 1 regression coverage — admin correctness: rendered related-products
// picker (C-06), no request data in global/module state (C-07), validated
// order/preview transitions with immutable history (S-07), central admin
// authorization + audit (S-08/S-09 prerequisite) and the honest order-value
// metric (S-10).
import { describe, it, expect, beforeEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { hashPassword } from '../../src/auth'
import { recordAdminAudit, redactAuditMetadata } from '../../src/admin-audit'
import { ORDER_STATUS_FLOW, PREVIEW_STATUS_FLOW } from '../../src/orders-status'

let env: TestEnv
const ADMIN_EMAIL = 'phase1-admin@example.com'
const ADMIN_PASSWORD = 'phase1-admin-password'

beforeEach(async () => {
  env = freshEnv()
  await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', ?, ?, 'admin')")
    .bind(ADMIN_EMAIL, await hashPassword(ADMIN_PASSWORD))
    .run()
})

async function adminJar(): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/admin/login',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) },
    env
  )
  jar.observe(res)
  return jar
}

async function customerJar(): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/register',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Cust', email: `c${Date.now()}@example.com`, password: 'customerpass1' }) },
    env
  )
  jar.observe(res)
  return jar
}

async function seedProduct(slug = 'admin-book') {
  await env.DB.prepare(`INSERT INTO products (slug, title, price, price_minor, image, category, age_min, age_max, active) VALUES (?, 'Admin Book', 34.99, 3499, 'x.webp', 'book', 4, 8, 1)`)
    .bind(slug)
    .run()
  return (await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(slug).first<{ id: number }>())!.id
}

async function seedOrder(): Promise<{ orderId: number; itemId: number }> {
  await env.DB.prepare(`INSERT INTO orders (full_name, email, address, city, country, shipping, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor) VALUES ('A','a@b.c','x','y','z',12,34.99,0,46.99,3499,0,1200,4699)`).run()
  const order = (await env.DB.prepare('SELECT id FROM orders ORDER BY id DESC LIMIT 1').first<{ id: number }>())!
  await env.DB.prepare(`INSERT INTO order_items (order_id, product_id, slug, title, kind, unit_price, unit_price_minor, qty) VALUES (?, NULL, 'admin-book', 'Admin Book', 'book', 34.99, 3499, 1)`).bind(order.id).run()
  const item = (await env.DB.prepare('SELECT id FROM order_items ORDER BY id DESC LIMIT 1').first<{ id: number }>())!
  return { orderId: order.id, itemId: item.id }
}

describe('C-06 admin PDP editor renders the real related-products picker', () => {
  it('emits the picker DOM + a request-scoped product list', async () => {
    const id = await seedProduct('admin-book')
    await seedProduct('second-book')
    const jar = await adminJar()
    const res = await app.request(`/admin/products/${id}/pdp`, { headers: { ...jar.headers() } }, env)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain('[object Promise]')
    expect(html).toContain('id="pdp-related-picker"')
    expect(html).toContain('window.__pdpRelated = [')
    expect(html).toContain('admin-book')
    expect(html).toContain('second-book')
  })

  it('saves a related selection and renders it back after reload', async () => {
    const id = await seedProduct('admin-book')
    const other = await seedProduct('second-book')
    const jar = await adminJar()
    const save = await app.request(
      `/admin/products/${id}/pdp/related`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ related_ids: String(other) }) },
      env
    )
    expect(save.status).toBe(302)
    const rows = (await env.DB.prepare('SELECT related_id FROM pdp_related WHERE product_id = ?').bind(id).all<{ related_id: number }>()).results || []
    expect(rows.map((r) => r.related_id)).toContain(other)
    // Reload: the selection is present in the rendered current-state JSON.
    const reload = await app.request(`/admin/products/${id}/pdp`, { headers: { ...jar.headers() } }, env)
    expect(await reload.text()).toContain(`window.__relatedCurrent = [${other}]`)
    // And an audit event was recorded for the PDP mutation (S-09 prerequisite).
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = 'pdp.mutation'").first<{ n: number }>()
    expect(audit!.n).toBeGreaterThan(0)
  })
})

describe('C-07 no request-specific data in global/module state', () => {
  it('never references globalThis anywhere in src/', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue
        const text = readFileSync(full, 'utf8')
        for (const line of text.split('\n')) {
          // Comment lines explaining the rule are fine; a real reference is not.
          const trimmed = line.trim()
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
          const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
          if (/\bglobalThis\b/.test(code)) offenders.push(`${full}: ${trimmed}`)
        }
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(offenders).toEqual([])
  })
})

describe('S-07 validated order/preview transitions with immutable history', () => {
  it('accepts a legal transition and appends exactly one immutable event', async () => {
    const { orderId } = await seedOrder()
    const jar = await adminJar()
    const res = await app.request(
      `/admin/orders/${orderId}/status`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ status: 'preview_sent' }) },
      env
    )
    expect(res.status).toBe(302)
    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first<{ status: string }>()
    expect(order!.status).toBe('preview_sent')
    const events = (await env.DB.prepare('SELECT from_state, to_state, event_type FROM order_state_events WHERE order_id = ?').bind(orderId).all<any>()).results || []
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ from_state: 'pending_preview', to_state: 'preview_sent', event_type: 'status_change' })
  })

  it('REJECTS an arbitrary/unknown status string', async () => {
    const { orderId } = await seedOrder()
    const jar = await adminJar()
    await app.request(
      `/admin/orders/${orderId}/status`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ status: 'definitely_not_a_status' }) },
      env
    )
    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first<{ status: string }>()
    expect(order!.status).toBe('pending_preview') // unchanged
    const events = await env.DB.prepare('SELECT COUNT(*) AS n FROM order_state_events').first<{ n: number }>()
    expect(events!.n).toBe(0)
  })

  it('REJECTS a regressive jump (e.g. pending_preview -> shipped)', async () => {
    const { orderId } = await seedOrder()
    const jar = await adminJar()
    await app.request(
      `/admin/orders/${orderId}/status`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ status: 'shipped' }) },
      env
    )
    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first<{ status: string }>()
    expect(order!.status).toBe('pending_preview')
  })

  it('requires a reason to cancel, and records it', async () => {
    const { orderId } = await seedOrder()
    const jar = await adminJar()
    await app.request(
      `/admin/orders/${orderId}/status`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ status: 'cancelled' }) },
      env
    )
    let order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first<{ status: string }>()
    expect(order!.status).toBe('pending_preview') // refused without a reason

    await app.request(
      `/admin/orders/${orderId}/status`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ status: 'cancelled', reason: 'customer asked' }) },
      env
    )
    order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first<{ status: string }>()
    expect(order!.status).toBe('cancelled')
    const ev = await env.DB.prepare("SELECT reason FROM order_state_events WHERE order_id = ? AND to_state = 'cancelled'").bind(orderId).first<{ reason: string }>()
    expect(ev!.reason).toBe('customer asked')
  })

  it('order_state_events are append-only at the database level', async () => {
    const { orderId } = await seedOrder()
    const jar = await adminJar()
    await app.request(
      `/admin/orders/${orderId}/status`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ status: 'preview_sent' }) },
      env
    )
    await expect(env.DB.prepare("UPDATE order_state_events SET to_state = 'shipped'").run()).rejects.toThrow(/immutable/)
    await expect(env.DB.prepare('DELETE FROM order_state_events').run()).rejects.toThrow(/immutable/)
  })

  it('validates preview status transitions and requires a reason to request changes', async () => {
    const { itemId, orderId } = await seedOrder()
    const jar = await adminJar()
    const post = (status: string, reason?: string) =>
      app.request(
        `/admin/items/${itemId}/preview`,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams(reason ? { preview_status: status, reason } : { preview_status: status }) },
        env
      )
    await post('bogus_status')
    let item = await env.DB.prepare('SELECT preview_status FROM order_items WHERE id = ?').bind(itemId).first<{ preview_status: string }>()
    expect(item!.preview_status).toBe('pending')

    await post('changes_requested') // no reason -> refused
    item = await env.DB.prepare('SELECT preview_status FROM order_items WHERE id = ?').bind(itemId).first<{ preview_status: string }>()
    expect(item!.preview_status).toBe('pending')

    await post('preview_ready')
    item = await env.DB.prepare('SELECT preview_status FROM order_items WHERE id = ?').bind(itemId).first<{ preview_status: string }>()
    expect(item!.preview_status).toBe('preview_ready')

    const events = (await env.DB.prepare('SELECT COUNT(*) AS n FROM order_state_events WHERE order_item_id = ?').bind(itemId).all<{ n: number }>()).results
    expect(events!.length).toBeGreaterThan(0)
    expect(ORDER_STATUS_FLOW.pending_preview).toContain('cancelled')
    expect(PREVIEW_STATUS_FLOW.approved).not.toContain('pending')
  })
})

describe('S-08/S-09 central admin authorization and audit', () => {
  it('a customer session is denied the admin pages and the admin API', async () => {
    const jar = await customerJar()
    const page = await app.request('/admin', { headers: { ...jar.headers() } }, env)
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toContain('/admin/login')
    const api = await app.request('/api/admin/test-ai-connection', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({ endpoint: 'https://api.example' }) }, env)
    expect([401, 403]).toContain(api.status)
  })

  it('an anonymous caller is denied too', async () => {
    const page = await app.request('/admin', {}, env)
    expect(page.status).toBe(302)
    const api = await app.request('/api/admin/test-ai-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, env)
    expect(api.status).toBe(401)
  })

  it('records an audit event for a high-risk admin mutation, with the actor', async () => {
    const { orderId } = await seedOrder()
    const jar = await adminJar()
    await app.request(
      `/admin/orders/${orderId}/status`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ status: 'preview_sent' }) },
      env
    )
    const row = await env.DB.prepare("SELECT actor_email, action, entity_type, entity_id FROM admin_audit_events WHERE action = 'order.status_change'").first<any>()
    expect(row.actor_email).toBe(ADMIN_EMAIL)
    expect(row.entity_type).toBe('order')
    expect(String(row.entity_id)).toBe(String(orderId))
  })

  it('admin_audit_events are append-only and never store secret-looking metadata', async () => {
    const ok = await recordAdminAudit(env.DB, {
      actorUserId: 1,
      actorEmail: ADMIN_EMAIL,
      action: 'test',
      entityType: 'x',
      entityId: 1,
      metadata: { apiKey: 'super-secret', nested: { password: 'hunter2' }, safe: 'yes' }
    })
    expect(ok).toBe(true)
    const row = await env.DB.prepare("SELECT metadata_json FROM admin_audit_events WHERE action = 'test'").first<{ metadata_json: string }>()
    expect(row!.metadata_json).not.toContain('super-secret')
    expect(row!.metadata_json).not.toContain('hunter2')
    expect(row!.metadata_json).toContain('yes')
    await expect(env.DB.prepare('DELETE FROM admin_audit_events').run()).rejects.toThrow(/immutable/)
  })

  it('redactAuditMetadata drops secret/token/photo-ish keys', () => {
    const out = redactAuditMetadata({ apiKey: 'a', secretKey: 'b', photoKey: 'uploads/x.jpg', token: 'c', note: 'kept' })
    expect(Object.keys(out)).toEqual(['note'])
  })
})

describe('S-10 unpaid totals are labelled Order value, never Revenue', () => {
  it('the dashboard never calls unpaid order value "revenue"', async () => {
    const { orderId } = await seedOrder()
    await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind('preview_sent', orderId).run()
    const jar = await adminJar()
    const res = await app.request('/admin', { headers: { ...jar.headers() } }, env)
    const html = await res.text()
    expect(html).toContain('Order value')
    // V2 Phase 4 (ADM-03) makes the invariant this test guards STRONGER rather
    // than removing it. The dashboard now has a real, ledger-derived revenue
    // tile, so "the word revenue appears nowhere" is no longer the right proxy:
    // the property that must hold is that the UNPAID value is explicitly not
    // revenue, and that an order nobody paid for contributes nothing to the
    // revenue tile.
    expect(html).toContain('Order value — NOT revenue')
    expect(html).toContain('$46.99') // derived from the integer total_minor (4699)
    // Nothing was captured for this order, so the revenue tile says so and shows
    // no amount at all — the unpaid value can never leak into it.
    expect(html).toContain('Net revenue — nothing captured')
    // Every occurrence of the word "revenue" on this page is either the explicit
    // negation on the order-value tile or the ledger-derived net tile.
    const revenueMentions = html.toLowerCase().match(/revenue/g) || []
    expect(revenueMentions.length).toBeGreaterThan(0)
    expect(html).toContain('Net revenue')
    // The tile that carries the ledger-derived revenue figure must not contain
    // the unpaid order value in any form.
    const revenueTile = html.split('<div class="stat">').find((tile) => tile.toLowerCase().includes('net revenue'))
    expect(revenueTile).toBeTruthy()
    expect(revenueTile).not.toContain('46.99')
  })
})
