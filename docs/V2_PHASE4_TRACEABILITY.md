# V2 Phase 4 Traceability — Server Cart, Money, Quotes, Payments and Refunds

Branch: `feat/commerce-payments-v2`
Baseline HEAD: `2d6ccb0504c3cc45ea6105a4783f72e216d9c86b` (accepted Phase-3 tip)
Migrations added: `0026_commerce_cart_quotes.sql`, `0027_commerce_payments_ledger.sql`
(forward-only; `0001`–`0025` byte-identical)

Every row below is a claim backed by a code path AND a test (or a browser
journey). A row with no proof does not appear here. "Limitation" states honestly
what the row does NOT cover.

Test file key: **CQ** = `test/unit/phase4-cart-quote.test.ts`,
**PW** = `test/unit/phase4-payments-webhooks.test.ts`,
**RA** = `test/unit/phase4-refunds-admin.test.ts`,
**J** = the `phase4-commerce-payments` browser journey (`scripts/e2e-phase4.mjs`),
**I** = the `[phase4 upgrade]` scenario in `scripts/test-integration.mjs`.

---

## COM-01 — First-class server-side cart and cart items

| | |
|---|---|
| Code | `migrations/0026_commerce_cart_quotes.sql` (`carts` with an exactly-one-owner CHECK and three partial unique indexes on the ACTIVE cart per owner, `cart_items` with a canonical `line_key`, append-only `cart_events`), `src/commerce/cart.ts` (`findActiveCart`, `getOrCreateCart`, `createCart`, `addCartItem`, `setCartItemQty`, `removeCartItem`, `clearCartItems`, `setCartCoupon`, `setShippingMethod`, `viewCart`, `reconcileClientCart`, `mergeCarts`, `markCartConverted`), `src/commerce/routes.ts` (`GET/POST/PATCH/DELETE /api/v1/cart…`), `src/security.ts` (`ww_cart` added to `AUTH_COOKIES`, so every cart mutation is CSRF-guarded), `public/static/cart.js` (`syncCartToServer`), `public/static/app.js` + `pdp.js` (mirror on every cart change) |
| Test proof | CQ: lines persist across requests with integer `recordedUnitPriceMinor` and an opaque item id; an exact duplicate MERGES; a guest's cart is invisible to another visitor, whose mutations of the owner's item id return 404; quantity is clamped to [1,10]; an unknown/inactive product and a forged variant are rejected; the response contains no `photo_key`/`uploads/`/`user_book_id` |
| Browser proof | J phase4.1–4.3: personalizing a book through the real PDP populates the durable server cart, a full RELOAD keeps the same server cart id, and a cross-sell sticker joins the same cart without exposing an internal identifier |
| Limitation | The offline localStorage cart still exists as a CACHE and is driver of the fast UI; the server cart is authoritative only after `syncCartToServer` mirrors it, so a page whose mirror call fails (offline) is reconciled at the next change or at checkout. Guest carts are scoped to the cart capability cookie, so clearing cookies abandons that guest cart (by design). |

## COM-02 — Authoritative product variants and price versions

| | |
|---|---|
| Code | `migrations/0026` (`price_versions` + an update/delete-blocking trigger; the `discounts.percent_bps` integer rate with range triggers), `src/commerce/pricing.ts` (`resolveVariantPrice` with an explicit four-step precedence and a recorded `price_source` + `price_version_id`, `activeVariantsFor`, `pickVariant`, `recordPriceVersion`), `src/commerce/cart.ts` (`resolveOwnedBook`, `lineKeyFor`) |
| Test proof | CQ: the newest effective price version wins and an older `at` timestamp resolves the historical price (nothing is rewritten); a forged/inactive variant and an unavailable currency are refused honestly; a fractional, negative or unsupported-currency price version is refused. PW: the order snapshot's `variant_code`/`variant_id`/`unit_price_minor` equal the quote line they came from. I: `price_versions` is immutable (UPDATE and DELETE both abort) |
| Browser proof | J phase4.5: the charged snapshot agrees with the quote line, read from the database |
| Limitation | A variant's price is still single-currency per row: a title offered in several currencies needs one price version (or variant/product price row) per currency. There is no currency CONVERSION anywhere in this build — a missing price is reported as unavailable instead. |

## COM-03 — Integer minor-unit multi-currency money

| | |
|---|---|
| Code | `src/money.ts` (`validateMinor`, `parseMinor`, `addMinor`, `subMinor`, `mulMinor`, `bpsOf`, `inclusiveTaxOf`, `assertCurrency`, `listIsoCurrencies`, `assertSingleCurrency`, `normalizeCurrencyCode`), `src/commerce/quote.ts` (all totals built with `money.ts`; the DB identity `total_minor = subtotal_minor − discount_minor + shipping_minor` is asserted by a CHECK on `checkout_quotes` and by 0018's triggers on `orders`), `src/commerce/coupons.ts` (basis points only) |
| Test proof | CQ: `bpsOf` and `inclusiveTaxOf` round half-up with integer arithmetic (1499 @ 20% = 300, 10000 @ 20% inclusive = 1667); a decimal, negative or missing amount is refused; `parseMinor` rejects `14.99`; a mixed-currency cart is reported unavailable, never converted; a quote's totals satisfy the identity. RA: multi-currency revenue is reported per currency and never summed. I: `orders`' money triggers still refuse NULL/negative/invalid-currency writes |
| Limitation | `products.price`, `orders.total`, `order_items.unit_price` and `discounts.percent` remain as legacy REAL/display mirrors for compatibility; they are never read on an authoritative path, and `percent_bps` is the rate. There is no foreign-exchange capability by design. |

## COM-04 — Server-authoritative expiring quote

| | |
|---|---|
| Code | `migrations/0026` (`checkout_quotes` with the total-identity/tax-boundary CHECKs and `checkout_quote_lines` with a per-line arithmetic trigger plus no-update/no-delete triggers), `src/commerce/quote.ts` (`priceCart`, `createQuote`, `readQuote` (re-derives and supersedes on change), `consumeQuote` (compare-and-swap), `pricedCartFromQuote`, `catalogVersionFor`), `src/commerce/routes.ts` (`POST /api/v1/cart/quote` durable path, `GET /api/v1/checkout/quotes/:id`) |
| Test proof | CQ: the durable quote prices the SERVER cart and returns integer minor units that add up; a hostile body (`totalMinor: 1`, `discountMinor: 999999`, a bogus `items[].priceMinor`) changes nothing, and a body that SUPPLIES items gets only the advisory display quote (`durable: false`, `quoteId: null`); an EXPIRED quote is refused with `quote_expired` and retired; a quote whose catalogue price MOVED is superseded with `quote_changed` and the fresh pricing; another visitor's quote is a 404; a line that went inactive is reported as unavailable. I: the quote identity CHECK and the line-arithmetic trigger hold |
| Browser proof | J phase4.4: the quote is created and re-read through the real API, its total equals the catalogue subtotal, and the tampered body is ignored |
| Limitation | The durable quote is issued per cart activity; a quote is single-use (consumed) and a changed cart requires a new quote — which the UI does by re-quoting, not by re-using. Quote TTL defaults to 15 minutes and is not yet operator-configurable from the admin UI. |

## COM-05 — Coupon/promotion rules, scope and usage limits

| | |
|---|---|
| Code | `migrations/0026` (`discounts.percent_bps`/`scope`/`starts_at`/`ends_at`/`min_subtotal_minor`/`max_uses`/`max_uses_per_owner`/`stackable`/`priority`/`max_discount_minor` with a rule trigger; `coupon_redemptions` with UNIQUE(discount_id, order_id) and no-update/no-delete triggers), `src/commerce/coupons.ts` (`evaluateCoupons`, `scopeBaseMinor`, `bookCountOf`, `discountPercentBps`, `recordRedemptions`, `ineligibilityReason`), `src/commerce/routes.ts` (`POST /api/v1/cart/coupon`), `src/index.tsx` (`/admin/discounts` create/update — ADM-16) |
| Test proof | CQ: a scope-discount applies only to its own scope's subtotal; a code before its start / after its end / below its minimum is refused with a specific reason; a global usage limit and a per-customer limit are evaluated from REAL `coupon_redemptions` rows (and a different customer remains eligible); stackable codes combine in priority order while a non-stackable one is applied ALONE; a coupon's own cap and the cart subtotal both bound it; an explicitly requested but unusable code is a HARD error on the authoritative path and the code is REMOVED from the cart. I: a duplicate redemption of one coupon on one order is refused |
| Limitation | Automatic (auto-apply) selection picks from the whole eligible set; there is no per-product or per-collection scope beyond `books`/`stickers`/`all`, and no "first order only" rule. A coupon's `percent_bps` must be supplied by the writer (the trigger refuses a NULL rate) — the legacy `percent` REAL column is a display mirror only. |

## COM-06 — Addresses, shipping methods/quotes and the tax boundary

| | |
|---|---|
| Code | `migrations/0026` (`addresses` with one-default-per-kind partial unique indexes, `tax_settings` as a single configured row), `migrations/0027` (`order_addresses` immutable snapshot + `orders.shipping_address_json`/`billing_address_json`/`shipping_method_label`/`tax_minor`), `src/commerce/quote.ts` (`resolveShipping` — currency-local rate rows only, no fallback; `resolveTaxModel`), `src/commerce/checkout.ts` (`validateAddress`, `addressHash`), `src/commerce/routes.ts` (`/api/v1/me/addresses` CRUD) |
| Test proof | CQ: shipping is priced only from the currency's own `shipping_rates` rows and a forged method is refused; the tax model defaults to `none` with a ZERO rate (no fabricated rate) and an `exclusive` model is refused with an actionable error; an INCLUSIVE rate is a component of the total, so the money identity is unchanged. PW: the address snapshot is written and is immutable (UPDATE and DELETE both abort). I: the tax row is created with mode `none` and rate 0 |
| Browser proof | J phase4.9: the order page renders the address snapshot |
| Limitation | No tax jurisdiction rates are configured and none are invented; an EXCLUSIVE (added-on-top) tax model is deliberately not enabled because the published `orders.total_minor` identity cannot express it — enabling it requires a future migration that extends that identity. Only a two-letter country code is validated, not a full address-format/verification service. |

## COM-07 — Payment-provider abstraction; Stripe implementation first

| | |
|---|---|
| Code | `src/commerce/payments/types.ts` (the `PaymentProvider` contract + `VerifiedEvent`), `payments/disabled.ts` (fail-closed), `payments/fake.ts` (the deterministic offline provider, double-gated), `payments/stripe.ts` (`stripeConfig` validation that never exposes a key, `createPaymentIntent`, `refund`, `fetchIntent`, `parseStripeSignature`, raw-body `verifyWebhook`), `payments/index.ts` (`getPaymentProvider`, `paymentProviderHealth`, `advertisedPaymentMethods`), `payments/attempts.ts` |
| Config | `PAYMENT_PROVIDER` (`stripe` \| `deterministic-fake` \| unset = DISABLED, the shipped default), `PAYMENTS_DISABLED=1` (kill switch), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_BASE`, `STRIPE_WEBHOOK_TOLERANCE_SECONDS`, `PAYMENT_FAKE_WEBHOOK_SECRET` |
| Test proof | PW: the default is DISABLED with a plain reason; the kill switch wins; the fake is refused outside `ENVIRONMENT=development`; a half-configured Stripe (key without webhook secret, a placeholder key, a key without a recognised prefix) resolves to `disabled` and the reported reason contains no fragment of the key; a fully configured Stripe resolves to `stripe` with mode `test`/`live` and no key text; PayPal is never advertised; an unconfigured adapter performs ZERO network calls while a configured one performs exactly one, sending the integer minor-unit amount; `/api/v1/payments/config` exposes no secret; `/api/v1/webhooks/{stripe,paypal}` 404 when that provider is not configured |
| Limitation | **No real credential is present in this repository or in CI, so no live provider call is made anywhere.** Marking a real staging call would require the owner's `STRIPE_*` values and is recorded as `EXTERNAL CREDENTIAL REQUIRED`. The Stripe adapter is complete and signature-correct, but it has not been exercised against Stripe's live API in this environment. PayPal has no adapter, no webhook and is not offered. |

## COM-08 — Signed, deduplicated, out-of-order-safe webhooks

| | |
|---|---|
| Code | `payments/stripe.ts::verifyWebhook` + `payments/fake.ts::verifyWebhook` (HMAC over `t.rawBody`, constant-time compare, replay tolerance, multiple `v1` signatures), `src/commerce/payments/service.ts` (`ingestProviderEvent`, `handleVerifiedWebhook`), `src/commerce/routes.ts` (`POST /api/v1/webhooks/stripe`, `…/deterministic-fake`, raw body via `c.req.text()`), `migrations/0027` (`payment_events` with UNIQUE(provider, provider_event_id) and an outcome-only-immutable trigger) |
| Test proof | PW: a correctly signed event is accepted and its stored summary contains no raw payload; a re-encoded/re-signed body fails; a missing, stale and tampered signature and a wrong secret are all refused (400) and pay NOTHING; the SAME event delivered three times sequentially is `processed` once and `duplicate` twice with exactly ONE capture entry; three CONCURRENT deliveries produce exactly one `processed`; events for an unknown intent are recorded and ignored with a reason |
| Browser proof | J phase4.7: the browser is redirected to the offline provider page, whose button delivers a REAL signed webhook through the real verification path — and only then does the order become paid. J phase4.6 asserts the opposite direction first: a redirect-only return reports the order as unpaid |
| Limitation | `payment_events` keeps only bounded, redacted fields (never the raw payload), deliberately. A stale `received`/`failed` event is retried on re-delivery; there is no automatic provider-side event re-fetch/replay cron yet (a Phase-8/platform item). |

## COM-09 — Payment attempt/event/refund/dispute ledger with immutable histories

| | |
|---|---|
| Code | `migrations/0027` (`payment_attempts` with identity-immutability, status-machine and refund-cap triggers and provider-intent/charge uniqueness plus one-open-attempt-per-order; `refunds` with cap and settled-immutability triggers; `disputes`; `order_financial_entries` with a signed `direction`, three uniqueness authorities, one-capture-per-order and no-update/no-delete triggers), `src/commerce/ledger.ts` (`postLedgerEntry`, `ledgerTotalsForOrder`, `paymentStatusFromTotals`, `refreshOrderFinancialState`, `refundableRemainderMinor`), `payments/service.ts` (capture/failure/cancel/refund/dispute application) |
| Test proof | PW: a verified success posts exactly one capture, moves the attempt to `captured` and writes ONE `payment_captured` history event; a replayed event posts nothing more; a SECOND capture for one order is refused by the database even from a different attempt; the ledger refuses UPDATE, DELETE and zero/negative amounts; an order cannot claim `captured` without `paid_at` and cannot claim `refunded` with no money; a late success after a refund cannot regress the order; an externally-issued provider refund is recorded as a real refund row and reconciled; the payment status machine refuses an illegal transition. I: the attempt identity/status/cap triggers, the double-capture index and the outcome-only event immutability all hold |
| Browser proof | J phase4.7b/4.7c: exactly one capture entry totalling the charged amount, and a signature-verified provider event linked to the paid order |
| Limitation | `orders.amount_captured_minor`/`amount_refunded_minor`/`payment_status` are a DERIVED cache refreshed after every posting (and at the end of every event), not an independent authority; the reconciliation view exists precisely to detect any drift. Partial/authorize-then-capture flows are modelled but this build only uses automatic capture. |

## COM-10 — Atomic order/item/personalization/variant snapshot

| | |
|---|---|
| Code | `src/commerce/checkout.ts` (`createCheckoutSession` — one `db.batch()` for order + items + address snapshots; personalization read from the user_book's CURRENT immutable revision via `bookSnapshotFor`), `migrations/0027` (`order_addresses`, `orders.cart_id` + `UNIQUE(cart_id)` "exactly one order per cart", `orders.checkout_session_id`), `src/commerce/routes.ts` (`POST /api/v1/checkout/session`) |
| Test proof | PW: the order is created `awaiting_payment`/`unpaid` with the quote's total, and the item snapshot's `unit_price_minor`/`variant_id`/`variant_code` equal the quote line's; the address snapshot is immutable; the SAME idempotency key returns the same session/order with exactly one order and one attempt; a SECOND checkout for a cart already in flight is a 409 and still exactly one order; a consumed quote cannot be reused. CQ: the reorder path re-resolves the personalized link for the caller. I: two orders for one cart are refused by a unique index |
| Browser proof | J phase4.5: the order total equals the quote, `amount_captured_minor` is 0, and the charged snapshot is read back and compared against the quote line in the database |
| Limitation | One order per cart is a hard rule, so a genuine "buy the same cart again later" means re-adding the lines (the reorder feature does exactly that). A retry reuses the durable order and adds a new payment attempt — supported, and the reason the cart/order link is a unique index rather than a session-unique index. |

## COM-11 — Explicit order state machine and history

| | |
|---|---|
| Code | `src/orders-status.ts` (`ORDER_STATUSES` and `ORDER_STATUS_FLOW` extended with the V2 §7 payment half; `transitionOrderStatus` unchanged in its CAS + conditional-history guarantee), `migrations/0015` (`order_state_events`, append-only), `src/commerce/payments/service.ts` (the provider/system transitions, each with an immutable event), `src/commerce/refunds.ts` (`syncOrderRefundState`), `src/admin.ts` (the admin UI offers only legal transitions) |
| Test proof | PW: every PRE-Phase-4 edge is still legal and verbatim; the payment edges form the closed §7 machine; a provider capture writes `payment_captured` with actor type `provider`; `paid → pending_preview` works through the validated admin transition and appends history; an illegal jump from `paid` is still refused; the money-moving states require a reason. I: the state and money triggers still hold |
| Browser proof | J phase4.9: the order page renders the timeline including the provider's `payment_captured` event |
| Limitation | `payment_status` (ledger-derived) and `orders.status` (workflow) are two axes written together by the payment domain; an operator changing only `orders.status` cannot corrupt the financial axis, and reconciliation reports any cached-money drift. |

## Phase-4 rule — production/print state controls cancellation eligibility

| | |
|---|---|
| Code | `src/orders-status.ts` (`PRODUCTION_STATES`, `cancellationEligibility` — derived from `ORDER_STATUS_FLOW`, so the answer and the transition guard can never drift), `src/admin.ts` (`adminOrderDetail` shows the refusal reason when cancellation is unavailable, as `data-cancellation-eligibility="ineligible"`), `transitionOrderStatus` (the CAS guard that actually refuses the move) |
| Test proof | PW: `cancellationEligibility` agrees with `ORDER_STATUS_FLOW` for EVERY status (a refusal always carries a reason, an allow never invents one); `shipped`/`delivered` are not cancellable and say why; `refunded` is not cancellable; `cancelled` reports it is already cancelled; `awaiting_payment`/`paid`/`pending_preview`/`printing` remain cancellable; and the SERVICE agrees — a `shipped` order's `→ cancelled` request is refused and its status is unchanged |
| Limitation | The line is drawn at production COMPLETION (`shipped`/`delivered`). `printing → cancelled` is a pre-existing Phase-1 edge and is preserved verbatim rather than narrowed, because narrowing it would change a Phase-0…3 contract; graining eligibility inside the print pipeline itself is FUL-10 (Phase 7). A shipped order can still be REFUNDED — that is a ledger operation on the payment axis and does not claim the book was never made. |

## COM-12 — Full/partial refunds and reconciliation

| | |
|---|---|
| Code | `src/commerce/refunds.ts` (`requestRefund` — ledger-derived remainder, idempotency key, provider call, ledger entry, order/attempt state), `payments/attempts.ts` (`addAttemptRefundedMinor` — amount and derived status in ONE statement), `migrations/0027` (`refunds` cap trigger on INSERT and on UPDATE, settled-refund immutability, `order_financial_entries` refund uniqueness), `src/commerce/reporting.ts` (`reconciliationIssues`), `src/admin_finance.ts` + `src/admin_routes.ts` (`GET /admin/finance/*`, `POST /admin/orders/:id/refunds`) |
| Test proof | RA: a full refund settles to `refunded` with net revenue of zero; partial refunds work and exhausting the remainder reaches `refunded`; an excess refund is refused with `refund_exceeds_capture` and the exact remaining amount, changing nothing; an order with no capture cannot be refunded; a repeated idempotency key replays with ONE refund row and ONE ledger entry; a provider failure is recorded as a `failed` refund row with no ledger entry; a direct over-cap INSERT and a failed-refund revival are both refused by the schema; the admin form refunds, audits (`order.refund`) and refuses a missing reason and an over-cap amount. PW: the ledger refund entry is unique per refund |
| Browser proof | J phase4.9–4.10: an admin refunds $10.00 through the real finance UI; the order becomes `partially_refunded`, the cached refunded total matches the ledger, the finance page shows the reduced net, the refunds view lists it, and reconciliation reports NO mismatch |
| Limitation | Refunds are issued against the captured payment attempt chosen as the latest captured one; a multi-attempt order (retry after failure) refunds against whichever attempt actually captured. Disputes are recorded and can be reversed on a win, but evidence submission to the provider is not implemented. |

## COM-13 — Cart recovery, payment-return recovery and double-submit safety

| | |
|---|---|
| Code | `src/commerce/cart.ts` (`reconcileClientCart` — per-line validation and reporting; `mergeCarts` on login; cart TTL and retirement), `src/commerce/routes.ts` (`POST /api/v1/cart/reconcile`, `resolveCheckoutReturnOrderId`, `POST /api/v1/checkout/sessions/:id/return`, `GET /api/v1/checkout/sessions/:id`), `src/commerce/checkout.ts` (`recordCheckoutReturn` — the weakest operation in the flow), `src/index.tsx` (`/order-success?cs=…` recovery), `public/static/payment-return.js`, `public/static/cart.js` (`syncCartToServer` dedupe), `src/commerce/routes.ts` (Idempotency-Key coercion on the session route) |
| Test proof | CQ: the offline cart is adopted line by line and unvalidatable lines are REPORTED; an expired cart is retired and replaced rather than resurrected; a failed payment leaves the cart ACTIVE. PW: the same idempotency key returns the same session (no double order); a return call is idempotent and NEVER pays, however many times it is called, and reports `paid: true` only after a real capture. RA/CQ: sessions require an `Idempotency-Key` of at least 8 characters |
| Browser proof | J phase4.2 (reload keeps the server cart), phase4.6 (visiting the return page before paying says no payment has been recorded; the DB is still unpaid), phase4.8 (a full reload of the return page recovers the paid state from the ledger, with the captured amount and a `data-payment-status="captured"`), phase4.11 (an abandoned session leaves an unpaid order that contributes no revenue) |
| Limitation | The return page polls the session for a bounded window (~20s) to catch a webhook that lands just after render; a customer who closes the tab and returns later sees the correct state on the next load. Cart retention is a TTL; there is no "email me my cart" recovery message (that is PLT-05/CUS territory in Phase 5). |

## COM-14 — Sticker cross-sell/reorder without ownership leakage

| | |
|---|---|
| Code | `src/commerce/cart.ts` (`addCartItem` with the sticker/book `line_key` and `hasPersonalization` boolean; `resolveOwnedBook` refuses a foreign/not-ready book generically), `src/commerce/routes.ts` (`POST /api/v1/my/orders/:id/reorder` — ownership enforced in the SQL predicate) |
| Test proof | CQ: a sticker and a book coexist in one cart and the API exposes no `user_book_id`/`uploads/`/`object_key`; a reorder of the caller's OWN order adds its lines, while a reorder of another customer's order is a 404 |
| Browser proof | J phase4.3: the cross-sell sticker joins the same server cart and the response carries no internal identifier |
| Limitation | Reorder re-adds catalog lines; a personalized line is only re-added when that user_book is still owned AND still checkout-ready, and is otherwise reported in `rejected` rather than silently substituted. |

---

## ADM-03 — Paid/net revenue and operational dashboard

| | |
|---|---|
| Code | `src/commerce/reporting.ts` (`financialSummary` — every figure summed from `order_financial_entries`, per currency, with unpaid/manual volume reported SEPARATELY), `src/admin.ts` (`adminDashboard` — a ledger-derived Net revenue tile and an order-value tile explicitly labelled NOT revenue), `src/index.tsx` (`GET /admin`) |
| Test proof | RA: revenue is empty when nothing was captured; a manually-created unpaid order appears ONLY in `unpaid` (count + value) and never in revenue; captured/refunded/net are reported after a real capture and refund with paid-order and entry counts; two currencies are reported side by side and never summed. `phase1-admin.test.ts` (updated): the dashboard keeps the "Order value — NOT revenue" label, the revenue tile says nothing was captured when nothing was, and the tile carrying the revenue figure never contains the unpaid order value |
| Browser proof | J phase4.9/4.11: the dashboard shows the ledger-derived net revenue and the NOT-revenue label; the finance page labels the unpaid backlog and reports the reduced net after a refund |
| Limitation | Revenue is reported per currency with no conversion (see COM-03). The dashboard's time range is "all time"; the API supports a range (`financialSummary({from,to})`) but no admin date-picker is exposed yet. |

## ADM-04 — Orders/items/timeline/actions

| | |
|---|---|
| Code | `src/index.tsx` (`GET /admin/orders`, `GET /admin/orders/:id` — now loads attempts, refunds, ledger, timeline and address snapshot; `POST /admin/orders/:id/status`, `…/notes`, `POST /admin/items/:id/preview`), `src/admin.ts` (`ordersTable` with a Payment column; `adminOrderDetail` with the authoritative minor-unit totals and the injected finance panel), `src/admin_finance.ts` (`orderFinancePanel`) |
| Test proof | RA: the order page renders the financial ledger, the capture entry, the timeline and the address snapshot for an admin; the orders table shows the payment state and "no payment captured" where that is the truth; illegal transitions are still refused by the validated service. PW: `paid → pending_preview` is a validated transition that appends history |
| Browser proof | J phase4.9b: the admin order page shows the ledger, capture, timeline and address snapshot; J audits `/admin/finance/*` and the order page at desktop + mobile with 0 findings |
| Limitation | Order actions are limited to the validated status/preview/notes/refund set; line-item editing, manual order creation and address amendment after the snapshot are intentionally absent (an order snapshot is immutable). |

## ADM-12 — Payments/refunds/disputes/reconciliation

| | |
|---|---|
| Code | `src/admin_finance.ts` (`adminFinanceDashboard`, `adminFinancePayments`, `adminFinanceRefunds`, `adminFinanceDisputes`, `adminFinanceEvents`, `adminFinanceReconciliation`), `src/admin_routes.ts` (`registerFinanceAdminRoutes` — `/admin/finance`, `/payments`, `/refunds`, `/disputes`, `/events`, `/reconciliation`, `POST /admin/orders/:id/refunds`, plus `financePermissionsFor`/`hasFinancePermission`), `src/commerce/reporting.ts` (`reconciliationIssues`) |
| Test proof | RA: all six pages render for an admin with no credential, raw payload or storage key in the HTML; the dashboard renders a real captured amount and the net; an admin refund through the form is audited and updates the ledger; a missing reason and an over-cap amount are refused; reconciliation reports NO issues when the cache agrees with the ledger and reports an `order_capture_mismatch` and a `settled_refund_without_ledger` when it does not; a customer is denied every finance page and the refund action even by direct URL (and creates no refund); an anonymous caller is denied |
| Browser proof | J phase4.9/4.10: the finance dashboard, order page, refunds view, reconciliation and provider-event views are driven through a real Chromium session; reconciliation reports no mismatch after a real refund; the event view shows the verified event type and no credential-shaped data |
| Limitation | The reconciliation view is READ-ONLY by design: a mismatch is investigated and explained, never "fixed" by rewriting history. Dispute evidence submission and provider-side event re-fetch are not implemented (noted under COM-12/COM-08). Per-role permission narrowing beyond the single `admin` role arrives with the Phase-6 matrix; the gate is already permission-shaped so no route changes then. |

## ADM-16 — Discounts/promotions

| | |
|---|---|
| Code | `src/index.tsx` (`GET /admin/discounts` with usage counts, `POST /admin/discounts` create, `POST /admin/discounts/:id/update`, `POST /admin/discounts/:id/toggle`), `src/admin.ts` (`adminDiscounts` — the rate, scope, rules, redemption count and an edit form), `src/commerce/coupons.ts` (the rules the admin form writes) |
| Test proof | RA: creating a promotion stores `percent_bps` (25% → 2500) with scope, priority, minimum subtotal, usage limits and cap; an invalid percentage and a reversed date window are refused by URL-encoded error instead of being written; updating a promotion keeps the basis-point rate in step and re-validates. `phase1-variants-money.test.ts` (updated): the fixture writes the now-required integer rate |
| Browser proof | J audits `/admin/discounts` at desktop + mobile with 0 findings; the finance journey exercises the refund path rather than creating a promo (the promotion rules are covered by the unit suite) |
| Limitation | Percentage promotions only (no fixed-amount or BOGUS/free-shipping codes), one scope axis, and no scheduled activation job — the date window is evaluated at pricing time, which is deterministic and timezone-explicit (UTC ISO-8601). |

---

## Cross-cutting

| Item | Value |
|---|---|
| Contract preservation | Every Phase-0…3 contract is intact: `AUTH_COOKIES` gained `ww_cart` (a NEW cookie, nothing removed); `PRIVATE_PATH_PREFIXES` gained the cart/checkout/me API paths; the CSP, cookie policy and CSRF gate are unchanged; 0018's money triggers and 0015's history triggers are untouched; `transitionOrderStatus`'s CAS + conditional-event guarantee is unchanged; migrations remain the schema authority |
| Zero paid calls | The only network egress in the Phase-4 code is the Stripe adapter's `fetch`, which is only reachable when `PAYMENT_PROVIDER=stripe` AND both credentials are present AND the intent/refund path is invoked. No credential is present in this repository or CI, so every automated run (unit, integration, browser, audit) makes ZERO external calls. `PW` proves the unconfigured adapter calls `fetch` zero times with an injected spy |
| Browser journeys | 13 journey groups now run (`phase4-commerce-payments` added). The Phase-4 group runs against a SECOND local server started with `PAYMENT_PROVIDER=deterministic-fake`, because with a provider configured the paid path is the only checkout path — the other journeys keep testing the shipped default (payments disabled) unchanged |
| Not committed | No dump, no secret, no PII, no child image, no raw provider payload, no signed URL. `.openclaw_test_out.txt` was never staged |
