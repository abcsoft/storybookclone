// Phase 1 correction — M-1 (blocker): a lost compare-and-swap must write NO
// immutable history event.
//
// The defect: `transitionOrderStatus` / `transitionPreviewStatus` ran
// `db.batch([UPDATE … WHERE id=? AND status=?, INSERT INTO order_state_events])`.
// A guarded UPDATE that matched ZERO rows (the loser of a concurrent race)
// still committed the event INSERT, so the losing request permanently wrote a
// FALSE `order_state_events` row into an append-only table (0015 triggers
// reject UPDATE/DELETE, so it can never be cleaned up).
//
// These tests drive a REAL double transition: a read barrier holds BOTH
// callers after they have read the same `from` state, so both build their CAS
// against the same observed version and genuinely race. Exactly one must win,
// exactly one state change and exactly one event may exist, and the loser must
// get 409. A second harness moves the row underneath a single caller to prove
// the same thing for a one-sided lost CAS.
import { describe, it, expect, beforeEach } from 'vitest'
import { freshEnv, type TestEnv } from '../helpers/testApp'
import { transitionOrderStatus, transitionPreviewStatus } from '../../src/orders-status'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

type FirstHook = (row: unknown) => Promise<void> | void

/**
 * Wraps a D1Database so every statement whose SQL matches `readPattern` runs
 * `before(row)` on `first()` and (optionally) waits on a shared barrier until
 * `participants` callers have arrived. `bind()` is re-wrapped so chained
 * `prepare(sql).bind(...).first()` keeps the instrumentation.
 */
function instrumentReads(real: D1Database, readPattern: RegExp, opts: { participants?: number; after?: FirstHook } = {}): D1Database {
  let arrived = 0
  let release: (() => void) | null = null
  const gate =
    opts.participants && opts.participants > 1
      ? new Promise<void>((resolve) => {
          release = resolve
        })
      : null

  const wrap = (stmt: any): any =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === 'first') {
          return async (...args: unknown[]) => {
            if (gate) {
              arrived += 1
              if (arrived >= opts.participants!) release!()
              await gate
            }
            const row = await target.first(...args)
            if (opts.after) await opts.after(row)
            return row
          }
        }
        if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args))
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      }
    })

  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = (target as any).prepare(sql)
          return readPattern.test(sql) ? wrap(stmt) : stmt
        }
      }
      const value = (target as any)[prop]
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as D1Database
}

async function seedOrder(): Promise<{ orderId: number; itemId: number }> {
  await env.DB.prepare(
    `INSERT INTO orders (full_name, email, address, city, country, shipping, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor)
     VALUES ('A','a@b.c','x','y','z',12,34.99,0,46.99,3499,0,1200,4699)`
  ).run()
  const order = (await env.DB.prepare('SELECT id FROM orders ORDER BY id DESC LIMIT 1').first<{ id: number }>())!
  await env.DB.prepare(`INSERT INTO order_items (order_id, product_id, slug, title, kind, unit_price, unit_price_minor, qty) VALUES (?, NULL, 'b', 'B', 'book', 34.99, 3499, 1)`)
    .bind(order.id)
    .run()
  const item = (await env.DB.prepare('SELECT id FROM order_items ORDER BY id DESC LIMIT 1').first<{ id: number }>())!
  return { orderId: order.id, itemId: item.id }
}

async function eventCount(): Promise<number> {
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM order_state_events').first<{ n: number }>())!.n
}

describe('M-1 concurrent order status transition is one atomic CAS + event', () => {
  it('exactly one winner, exactly one event, loser gets 409, no false event', async () => {
    const { orderId } = await seedOrder()
    const db = instrumentReads(env.DB, /SELECT status FROM orders WHERE id = \?/, { participants: 2 })
    const actor = { userId: 1, email: 'admin@example.com', requestId: 'race-order' }

    const [a, b] = await Promise.all([
      transitionOrderStatus(db, { orderId, to: 'preview_sent', actor }),
      transitionOrderStatus(db, { orderId, to: 'preview_sent', actor })
    ])

    const wins = [a, b].filter((r) => r.ok)
    const losses = [a, b].filter((r) => !r.ok)
    expect(wins).toHaveLength(1)
    expect(losses).toHaveLength(1)
    expect(losses[0]).toMatchObject({ ok: false, status: 409 })

    // Exactly one state change on the real row.
    const row = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first<{ status: string }>()
    expect(row!.status).toBe('preview_sent')

    // Exactly one event — and it is the winner's, not a phantom from the loser.
    const events = (await env.DB.prepare('SELECT from_state, to_state, order_id FROM order_state_events').all<any>()).results || []
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ order_id: orderId, from_state: 'pending_preview', to_state: 'preview_sent' })
    expect(await eventCount()).toBe(1)
  })

  it('a one-sided lost CAS (row moved after the read) writes no event and returns 409', async () => {
    const { orderId } = await seedOrder()
    // Simulate a competing admin committing between our read and our CAS:
    // after the service observes `pending_preview`, the row is already
    // `preview_sent`, so the guarded UPDATE matches ZERO rows.
    const db = instrumentReads(env.DB, /SELECT status FROM orders WHERE id = \?/, {
      after: async () => {
        await env.DB.prepare("UPDATE orders SET status = 'preview_sent' WHERE id = ?").bind(orderId).run()
      }
    })

    const res = await transitionOrderStatus(db, { orderId, to: 'preview_sent', actor: { userId: 1, email: 'admin@example.com', requestId: 'stale' } })
    expect(res).toMatchObject({ ok: false, status: 409 })
    // The loser wrote no event, and the row is still the competing winner's.
    expect(await eventCount()).toBe(0)
    const row = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first<{ status: string }>()
    expect(row!.status).toBe('preview_sent')
  })

  it('is idempotent for a repeat of the same target state (no duplicate event)', async () => {
    const { orderId } = await seedOrder()
    const actor = { userId: 1, email: 'admin@example.com' }
    expect(await transitionOrderStatus(env.DB, { orderId, to: 'preview_sent', actor })).toMatchObject({ ok: true, noop: false })
    expect(await eventCount()).toBe(1)
    expect(await transitionOrderStatus(env.DB, { orderId, to: 'preview_sent', actor })).toMatchObject({ ok: true, noop: true })
    expect(await eventCount()).toBe(1)
  })
})

describe('M-1 concurrent preview status transition is one atomic CAS + event', () => {
  it('exactly one winner, exactly one event, loser gets 409, no false event', async () => {
    const { itemId } = await seedOrder()
    const db = instrumentReads(env.DB, /SELECT preview_status, order_id FROM order_items WHERE id = \?/, { participants: 2 })
    const actor = { userId: 1, email: 'admin@example.com', requestId: 'race-preview' }

    const [a, b] = await Promise.all([
      transitionPreviewStatus(db, { itemId, to: 'preview_ready', actor }),
      transitionPreviewStatus(db, { itemId, to: 'preview_ready', actor })
    ])

    const wins = [a, b].filter((r) => r.ok)
    const losses = [a, b].filter((r) => !r.ok)
    expect(wins).toHaveLength(1)
    expect(losses).toHaveLength(1)
    expect(losses[0]).toMatchObject({ ok: false, status: 409 })

    const row = await env.DB.prepare('SELECT preview_status FROM order_items WHERE id = ?').bind(itemId).first<{ preview_status: string }>()
    expect(row!.preview_status).toBe('preview_ready')

    const events = (await env.DB.prepare('SELECT from_state, to_state, order_item_id, subject FROM order_state_events').all<any>()).results || []
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ order_item_id: itemId, subject: 'item', from_state: 'pending', to_state: 'preview_ready' })
    expect(await eventCount()).toBe(1)
  })

  it('a one-sided lost CAS on a preview writes no event and returns 409', async () => {
    const { itemId } = await seedOrder()
    const db = instrumentReads(env.DB, /SELECT preview_status, order_id FROM order_items WHERE id = \?/, {
      after: async () => {
        await env.DB.prepare("UPDATE order_items SET preview_status = 'preview_ready' WHERE id = ?").bind(itemId).run()
      }
    })
    const res = await transitionPreviewStatus(db, { itemId, to: 'preview_ready', actor: { userId: 1, email: 'admin@example.com' } })
    expect(res).toMatchObject({ ok: false, status: 409 })
    expect(await eventCount()).toBe(0)
  })
})

describe('M-1 the history table stays append-only', () => {
  it('rejects UPDATE and DELETE on order_state_events at the database level', async () => {
    const { orderId } = await seedOrder()
    const res = await transitionOrderStatus(env.DB, { orderId, to: 'preview_sent', actor: { userId: 1, email: 'a@b.c' } })
    expect(res.ok).toBe(true)
    expect(await eventCount()).toBe(1)
    await expect(env.DB.prepare("UPDATE order_state_events SET to_state = 'delivered'").run()).rejects.toThrow(/immutable/)
    await expect(env.DB.prepare('DELETE FROM order_state_events').run()).rejects.toThrow(/immutable/)
    expect(await eventCount()).toBe(1)
    const row = await env.DB.prepare('SELECT to_state FROM order_state_events').first<{ to_state: string }>()
    expect(row!.to_state).toBe('preview_sent')
  })
})
