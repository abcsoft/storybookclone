// Client-side money formatting for the SELECTED store currency (V2 Phase 2).
//
// The currency and its symbol are rendered by the SERVER onto <body> from the
// resolved country/currency choice in the database, and every amount the client
// displays comes from a server response (a quote or an order) in INTEGER MINOR
// units. The browser never calculates a price, and it never guesses a symbol:
// before this change the cart hard-coded "$" regardless of the currency the
// server was about to charge in.

export function storeCurrency() {
  return (document.body && document.body.dataset.currency) || 'USD'
}

export function storeSymbol() {
  return (document.body && document.body.dataset.currencySymbol) || '$'
}

/** Currencies with no minor unit. */
function minorUnitsFor(currency) {
  return currency === 'JPY' || currency === 'KRW' ? 0 : 2
}

/**
 * Formats an INTEGER minor-unit amount in the store currency.
 * `minor` must come from the server; a caller with only a legacy decimal value
 * should use moneyFromMajor() and say so.
 */
export function money(minor, currency = storeCurrency()) {
  const units = minorUnitsFor(currency)
  const value = Number(minor) || 0
  const abs = Math.abs(Math.round(value))
  const divisor = Math.pow(10, units)
  const whole = Math.floor(abs / divisor)
  const frac = abs % divisor
  const wholeText = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const text = units > 0 ? `${wholeText}.${String(frac).padStart(units, '0')}` : wholeText
  return `${value < 0 ? '-' : ''}${storeSymbol()}${text}`
}

/** Formats a legacy decimal (major-unit) amount. Only for pre-Phase-2 fields. */
export function moneyFromMajor(major, currency = storeCurrency()) {
  return money(Math.round((Number(major) || 0) * Math.pow(10, minorUnitsFor(currency))), currency)
}

/** Prefers the server's integer minor amount, falling back to the decimal twin. */
export function moneyFrom(server, minorKey, majorKey) {
  if (server && server[minorKey] != null) return money(server[minorKey])
  if (server && server[majorKey] != null) return moneyFromMajor(server[majorKey])
  return money(0)
}
