// COM-03: integer minor-unit money, end to end.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: an authoritative money path never
// touches a float. Every amount is a non-negative integer count of a currency's
// minor unit (cents, pence, yen), and every derived amount is produced by
// INTEGER arithmetic with an explicitly stated rounding rule. The legacy REAL
// columns on `products`/`orders`/`order_items` remain for compatibility and
// display only; nothing here ever reads or writes them.
//
// Currency validity is not guessed from a string shape: the authoritative
// allowlist is the `iso_currencies` table published by migration 0018, and
// `assertCurrency` checks against it (matching the DB triggers, which would
// reject the write anyway — this gives a clear error instead of a raw abort).

/** ISO-4217 exponent (how many decimal places the minor unit represents). */
export const MINOR_UNIT_EXPONENT: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, NZD: 2, CHF: 2, SEK: 2, NOK: 2, DKK: 2,
  PLN: 2, CZK: 2, HUF: 2, JPY: 0, KRW: 0, INR: 2, BRL: 2, MXN: 2, ZAR: 2,
  SGD: 2, HKD: 2, AED: 2
}

/** Basis points in one whole unit (100% == 10000 bps). Integer, always. */
export const BPS_SCALE = 10000

export type MoneyError = { code: string; message: string }

export class MoneyInvariantError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'MoneyInvariantError'
    this.code = code
  }
}

function isPlainInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/**
 * Validates an authoritative amount: a non-negative INTEGER number of minor
 * units. Returns a stable error code instead of throwing so a route can return
 * a field-level validation error.
 */
export function validateMinor(value: unknown, field: string, opts: { allowNull?: boolean } = {}): MoneyError | null {
  if (value === null || value === undefined) {
    if (opts.allowNull) return null
    return { code: 'money_missing', message: `${field} is required.` }
  }
  if (typeof value === 'string' && value.trim() !== '' && /^-?\d+$/.test(value.trim())) {
    // A canonical integer string is accepted and coerced by parseMinor().
    return null
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { code: 'money_not_integer', message: `${field} must be a whole number of minor units (no decimals, no floating point).` }
  }
  if (value < 0) return { code: 'money_negative', message: `${field} cannot be negative.` }
  return null
}

/**
 * Coerces a client- or config-supplied value into an authoritative minor-unit
 * integer, or returns null. Accepts a canonical integer string (a form field)
 * — never a decimal (10.5 is rejected, not rounded), because silently rounding
 * an authoritative amount is exactly the behaviour this build forbids.
 */
export function parseMinor(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const n = Number(trimmed)
    if (!Number.isSafeInteger(n)) return null
    return n
  }
  return null
}

export function addMinor(...amounts: number[]): number {
  let total = 0
  for (const a of amounts) {
    if (!isPlainInt(a)) throw new MoneyInvariantError('money_not_integer', `Cannot add a non-integer amount (${String(a)}).`)
    total += a
  }
  return total
}

export function subMinor(a: number, b: number): number {
  if (!isPlainInt(a) || !isPlainInt(b)) throw new MoneyInvariantError('money_not_integer', 'Cannot subtract a non-integer amount.')
  const result = a - b
  if (result < 0) throw new MoneyInvariantError('money_negative', 'A money amount cannot go negative.')
  return result
}

/** unit price x quantity — pure integer multiplication. */
export function mulMinor(unitMinor: number, qty: number): number {
  if (!isPlainInt(unitMinor) || !isPlainInt(qty)) throw new MoneyInvariantError('money_not_integer', 'Cannot multiply a non-integer amount.')
  return unitMinor * qty
}

/**
 * A percentage rate expressed in INTEGER basis points applied to an integer
 * amount. Rounding is half-up, computed with integer arithmetic only:
 *   round(a * bps / 10000) == floor((2*a*bps + 10000) / 20000)
 * so 2000 bps of 3499 == 700 exactly, with no float ever involved.
 */
export function bpsOf(amountMinor: number, bps: number): number {
  if (!isPlainInt(amountMinor) || amountMinor < 0) throw new MoneyInvariantError('money_not_integer', 'Cannot apply a rate to a non-integer amount.')
  if (!isPlainInt(bps) || bps < 0) throw new MoneyInvariantError('money_not_integer', `A rate must be a whole number of basis points (got ${String(bps)}).`)
  return Math.floor((2 * amountMinor * bps + BPS_SCALE) / (2 * BPS_SCALE))
}

/**
 * The tax component INCLUDED IN an inclusive (VAT-style) gross amount:
 *   round(gross * bps / (10000 + bps)) == floor((2*gross*bps + (10000+bps)) / (2*(10000+bps)))
 * Integer-only, half-up. This is the only tax model 0018's
 * `total_minor = subtotal - discount + shipping` identity can express, so an
 * exclusive rate is refused by the quote service rather than mis-charged.
 */
export function inclusiveTaxOf(grossMinor: number, bps: number): number {
  if (!isPlainInt(grossMinor) || grossMinor < 0) throw new MoneyInvariantError('money_not_integer', 'Cannot tax a non-integer amount.')
  if (!isPlainInt(bps) || bps < 0) throw new MoneyInvariantError('money_not_integer', `A rate must be a whole number of basis points (got ${String(bps)}).`)
  if (bps === 0) return 0
  const divisor = BPS_SCALE + bps
  return Math.floor((2 * grossMinor * bps + divisor) / (2 * divisor))
}

/** Minor -> major decimal for DISPLAY ONLY. Never feed the result back into a price. */
export function minorToMajor(minor: number, exponent = 2): number {
  const safeExponent = Number.isInteger(exponent) && exponent >= 0 ? exponent : 2
  return minor / Math.pow(10, safeExponent)
}

/** Major decimal -> minor, half-up. Only used for legacy/import boundaries. */
export function majorToMinor(major: number, exponent = 2): number {
  const safeExponent = Number.isInteger(exponent) && exponent >= 0 ? exponent : 2
  return Math.round(major * Math.pow(10, safeExponent))
}

const CURRENCY_SHAPE = /^[A-Z]{3}$/

/** A syntactically valid ISO-4217 code (uppercased). Shape only — not validity. */
export function normalizeCurrencyCode(value: unknown): string | null {
  const code = String(value ?? '').trim().toUpperCase()
  return CURRENCY_SHAPE.test(code) ? code : null
}

/**
 * The currencies this store can actually charge in: the rows published by
 * migration 0018. A code outside that set is refused here AND by the DB
 * triggers/FKs, so it can never reach a money column.
 */
export async function listIsoCurrencies(db: D1Database): Promise<Array<{ code: string; minorUnits: number; label: string }>> {
  const rows = (await db.prepare('SELECT code, minor_units, label FROM iso_currencies ORDER BY code').all<{ code: string; minor_units: number; label: string }>()).results || []
  return rows.map((r) => ({ code: r.code, minorUnits: r.minor_units, label: r.label }))
}

/** Validates a currency against the authoritative allowlist; throws MoneyInvariantError when unknown. */
export async function assertCurrency(db: D1Database, value: unknown): Promise<string> {
  const code = normalizeCurrencyCode(value)
  if (!code) throw new MoneyInvariantError('currency_invalid', 'A three-letter ISO-4217 currency code is required.')
  const row = await db.prepare('SELECT code, minor_units FROM iso_currencies WHERE code = ?').bind(code).first<{ code: string; minor_units: number }>()
  if (!row) throw new MoneyInvariantError('currency_unsupported', `The currency "${code}" is not supported by this store.`)
  return row.code
}

/** Minor-unit exponent for a currency, from the DB allowlist (falls back to 2). */
export async function minorUnitsFor(db: D1Database, code: string): Promise<number> {
  const row = await db.prepare('SELECT minor_units FROM iso_currencies WHERE code = ?').bind(String(code).toUpperCase()).first<{ minor_units: number }>()
  return row ? Number(row.minor_units) : (MINOR_UNIT_EXPONENT[String(code).toUpperCase()] ?? 2)
}

/**
 * The currency identity of a set of lines: every line must agree, otherwise the
 * quote is refused rather than silently mixing currencies (COM-03's "ISO
 * currency end to end" is what makes a mixed-currency total meaningless).
 */
export function assertSingleCurrency(currencies: Array<string | null | undefined>): { ok: true; currency: string } | { ok: false; error: MoneyError } {
  const present = [...new Set(currencies.filter((c): c is string => !!c).map((c) => String(c).toUpperCase()))]
  if (present.length === 0) return { ok: true, currency: 'USD' }
  if (present.length > 1) {
    return { ok: false, error: { code: 'currency_mismatch', message: `A single order cannot mix currencies (found: ${present.join(', ')}).` } }
  }
  return { ok: true, currency: present[0] }
}
