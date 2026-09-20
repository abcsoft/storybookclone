import { describe, expect, it } from 'vitest'
import { purchaseTrackingGate, shouldEmitPurchase, buildPurchasePayload } from '../../src/marketing/index'

describe('purchase gate — fail closed in every baseline configuration', () => {
  it('is blocked when no provider is configured (the shipped default)', () => {
    const gate = purchaseTrackingGate({})
    expect(gate.active).toBe(false)
    expect(gate.reason).toMatch(/no payment provider/i)
  })

  it('is blocked when payments are switched off', () => {
    expect(purchaseTrackingGate({ PAYMENTS_DISABLED: '1' }).active).toBe(false)
  })

  it('is blocked for the offline test provider', () => {
    const gate = purchaseTrackingGate({ PAYMENT_PROVIDER: 'deterministic-fake', ENVIRONMENT: 'development' })
    expect(gate.active).toBe(false)
    expect(gate.reason).toMatch(/test provider/i)
  })

  it('stays blocked for a real provider until the verified-payment phase arms it', () => {
    const gate = purchaseTrackingGate({ PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh' })
    expect(gate.active).toBe(false)
    expect(gate.reason).toMatch(/verified-payment|not implemented|exactly-once/i)
  })

  it('remains blocked even when the phase switch is set, because no durable record exists', () => {
    const gate = purchaseTrackingGate({ PAYMENT_PROVIDER: 'stripe', MARKETING_PURCHASE_TRACKING: '1' })
    expect(gate.active).toBe(false)
  })
})

describe('purchase gate — a browser can never make it fire', () => {
  const openGate = { active: true, reason: 'test' }
  const closedGate = { active: false, reason: 'blocked' }

  it('never fires for a closed gate, whatever the status', () => {
    expect(shouldEmitPurchase({ paymentStatus: 'captured', amountCapturedMinor: 1299, currency: 'USD' }, closedGate)).toBe(false)
  })

  it('never fires for pending/test-manual/failed/cancelled/abandoned/unpaid', () => {
    for (const status of ['pending', 'test-manual', 'failed', 'cancelled', 'abandoned', 'unpaid', 'awaiting_payment', 'draft', null, undefined]) {
      expect(shouldEmitPurchase({ paymentStatus: status, amountCapturedMinor: 1299, currency: 'USD' }, openGate), String(status)).toBe(false)
    }
  })

  it('fires only for a captured order with a positive trusted amount and currency', () => {
    expect(shouldEmitPurchase({ paymentStatus: 'captured', amountCapturedMinor: 1299, currency: 'USD' }, openGate)).toBe(true)
    expect(shouldEmitPurchase({ paymentStatus: 'captured', amountCapturedMinor: 0, currency: 'USD' }, openGate)).toBe(false)
    expect(shouldEmitPurchase({ paymentStatus: 'captured', amountCapturedMinor: 1299, currency: null }, openGate)).toBe(false)
  })
})

describe('purchase payload — trusted data only, no internal ids', () => {
  it('carries valueMinor + currency + an opaque marketing transaction id', () => {
    const payload = buildPurchasePayload(
      { paymentStatus: 'captured', amountCapturedMinor: 2598, currency: 'USD' },
      [{ slug: 'the-star-collector', quantity: 2 }],
      'mtx_opaque_123'
    )
    expect(payload).toMatchObject({ valueMinor: 2598, currency: 'USD', transactionId: 'mtx_opaque_123' })
    const text = JSON.stringify(payload)
    expect(text).not.toMatch(/orderId|order_id|userBookId|paymentId|email/i)
  })
})
