// COM-07: resolves the payment provider from ENVIRONMENT CONFIGURATION ONLY,
// and reports every adapter's state truthfully.
//
// Resolution rules (the same shape as the Phase-3 generation provider bundle,
// so there is one configuration discipline in this codebase):
//
//   1. `PAYMENTS_DISABLED=1` — the deployment-wide kill switch. Checked FIRST,
//      so it cannot be overridden by anything else. Every capability resolves to
//      the fail-closed adapter.
//   2. `PAYMENT_PROVIDER`:
//        * 'stripe'             -> the real adapter, but ONLY when it is fully
//                                  configured (key + webhook secret). Otherwise
//                                  fail closed — never a credential-less call,
//                                  never a silent fallback to the fake.
//        * 'deterministic-fake' -> the offline fake, and ONLY when
//                                  ENVIRONMENT === 'development'. A stray value
//                                  in a deployed environment therefore cannot
//                                  fabricate a payment.
//        * unset / unknown      -> fail closed. THIS IS THE DEFAULT: this
//                                  repository ships with payment DISABLED.
//   3. A configured-but-unusable real adapter is reported as UNCONFIGURED rather
//      than half-built.
//
// Nothing here reads `process.env`. The bindings come from the Worker
// environment, exactly like every other provider in this project.
import { DisabledPaymentProvider } from './disabled'
import { DeterministicFakePaymentProvider, type FakeFaults } from './fake'
import { StripePaymentProvider, stripeConfig } from './stripe'
import type { PaymentEnv, PaymentProvider, ProviderHealth } from './types'

export const STRIPE_PROVIDER = 'stripe'
export const DETERMINISTIC_FAKE_PROVIDER = 'deterministic-fake'
export const DISABLED_PROVIDER = 'disabled'

export type PaymentProviderOptions = {
  faults?: FakeFaults
  fetchImpl?: typeof fetch
  timeoutMs?: number
  apiBase?: string
}

export function paymentsDisabled(env: PaymentEnv): boolean {
  return String(env.PAYMENTS_DISABLED ?? '') === '1'
}

/** True when the offline fake is permitted here. `development` ONLY, by design. */
export function fakePaymentsAllowed(env: PaymentEnv): boolean {
  return env.ENVIRONMENT === 'development'
}

/** Which adapter key the configuration selects, before availability is considered. */
export function selectedProviderKey(env: PaymentEnv): string {
  const wanted = String(env.PAYMENT_PROVIDER ?? '').trim().toLowerCase()
  if (!wanted) return DISABLED_PROVIDER
  if (wanted === STRIPE_PROVIDER || wanted === DETERMINISTIC_FAKE_PROVIDER) return wanted
  return DISABLED_PROVIDER
}

/**
 * Resolves the ONE provider the checkout, webhook and refund services use.
 * Returns a fail-closed adapter rather than null, so no caller can accidentally
 * treat "no provider" as "skip the payment step".
 */
export function getPaymentProvider(env: PaymentEnv, options: PaymentProviderOptions = {}): PaymentProvider {
  if (paymentsDisabled(env)) {
    return new DisabledPaymentProvider('Payments are switched off (PAYMENTS_DISABLED=1).')
  }
  const key = selectedProviderKey(env)
  if (key === STRIPE_PROVIDER) {
    const config = stripeConfig(env)
    if (!config.configured) return new DisabledPaymentProvider(config.reason)
    return new StripePaymentProvider(env, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, apiBase: options.apiBase })
  }
  if (key === DETERMINISTIC_FAKE_PROVIDER) {
    if (!fakePaymentsAllowed(env)) {
      return new DisabledPaymentProvider('The deterministic test provider is only available in an explicitly-configured development environment.')
    }
    return new DeterministicFakePaymentProvider({ env, faults: options.faults })
  }
  return new DisabledPaymentProvider('No payment provider is configured. Checkout will not take a payment.')
}

/**
 * The honest provider-health report shown in the admin panel (ADM-17 groundwork)
 * and in the public capability summary. NEVER contains a credential, a fragment
 * of one, or a raw provider payload — only configuration state and a reason.
 */
export function paymentProviderHealth(env: PaymentEnv): ProviderHealth {
  if (paymentsDisabled(env)) {
    return { provider: 'disabled', configured: false, active: 'disabled', detail: 'Payments are switched off (PAYMENTS_DISABLED=1).' }
  }
  const key = selectedProviderKey(env)
  if (key === STRIPE_PROVIDER) {
    const config = stripeConfig(env)
    return { provider: STRIPE_PROVIDER, configured: config.configured, active: config.configured ? STRIPE_PROVIDER : 'disabled', detail: config.reason }
  }
  if (key === DETERMINISTIC_FAKE_PROVIDER) {
    const allowed = fakePaymentsAllowed(env)
    return {
      provider: DETERMINISTIC_FAKE_PROVIDER,
      configured: allowed,
      active: allowed ? DETERMINISTIC_FAKE_PROVIDER : 'disabled',
      detail: allowed
        ? 'The offline deterministic test provider is active. No external call is made and no real money moves.'
        : 'The deterministic test provider is only available in an explicitly-configured development environment.'
    }
  }
  return {
    provider: 'disabled',
    configured: false,
    active: 'disabled',
    detail: 'No payment provider is configured, so checkout does not collect payment. Orders are created unpaid.'
  }
}

/**
 * The provider keys the storefront is ALLOWED to advertise. PayPal is
 * deliberately absent: it has no adapter and no webhook processing in this
 * build, so offering it would be a false capability claim (V2 Phase-4 rule).
 */
export function advertisedPaymentMethods(env: PaymentEnv): Array<{ key: string; label: string; available: boolean }> {
  const health = paymentProviderHealth(env)
  const methods = [{ key: 'card', label: 'Card', available: health.configured }]
  if (health.configured && health.provider === DETERMINISTIC_FAKE_PROVIDER) {
    methods.push({ key: 'test-card', label: 'Test card (offline test provider)', available: true })
  }
  return methods
}

/**
 * A TEST-ONLY view of the Stripe configuration, used to prove that the config
 * report never contains a credential fragment. It returns exactly what
 * `stripeConfig()` returns — nothing more — and exists so tests do not have to
 * reach into the adapter's private state.
 */
export function stripeProviderConfigForTests(env: PaymentEnv): { configured: boolean; mode: 'test' | 'live' | null; reason: string } {
  return stripeConfig(env)
}
