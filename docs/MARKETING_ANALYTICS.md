# Consent-aware marketing analytics

A single, vendor-neutral, **consent-gated** tracking layer for the storefront.
It covers four integrations behind one typed API:

| Adapter | Vendor library | Consent category |
|---|---|---|
| `meta` | Meta Pixel (`fbevents.js`) | Marketing |
| `tiktok` | TikTok Pixel (`events.js`) | Marketing |
| `ga4` | Google Analytics 4 (`gtag.js`) | Analytics |
| `googleAds` | Google Ads (`gtag.js`) | Marketing |

Nothing in the storefront, cart, checkout or account flow depends on tracking:
if every adapter is disabled, misconfigured, blocked by an extension, or the
`analytics.js` bundle fails to load, the store works exactly as before.

> **Purchase tracking is currently DISABLED in production** — see
> [Purchase safety gate](#purchase-safety-gate). Everything else is live and
> gated on consent.

---

## 1. Architecture and event flow

```
                      ┌─────────────────────────────────────────────┐
 storefront / cart /  │  internal event contract (src/marketing/     │
 checkout / pdp  ───► │  events.ts): MarketingEventName + allowlist   │
 (public/static/*.js) │  + FORBIDDEN_KEY guard                        │
                      └───────────────┬─────────────────────────────┘
                                      │  track(name, payload)  / trackOnce(...)
                                      ▼
                      ┌─────────────────────────────────────────────┐
                      │  public/static/analytics.js                  │
                      │  • reads the inline bootstrap (public ids)    │
                      │  • reads the ww_consent cookie                 │
                      │  • Consent Mode v2 default (all denied)        │
                      │  • loads a vendor library ONLY after consent   │
                      └───────────────┬─────────────────────────────┘
                                      │  the ONLY code that touches a
                                      ▼  vendor global
        ┌──────────────┬──────────────┬───────────────┬───────────────┐
        │  Meta (fbq)  │ TikTok (ttq) │ GA4 (gtag)    │ Google Ads     │
        └──────────────┴──────────────┴───────────────┴───────────────┘
```

Server side, `src/marketing/*` owns **configuration and policy only** — it never
makes an outbound request and never loads a vendor library:

- `config.ts` — resolves which adapters are configured (strictly validated id
  shapes), the master switch, the public-route allowlist, and builds the
  server→browser bootstrap (`#ww-marketing-config`).
- `consent.ts` — the versioned first-party consent model, shared reference for
  the browser and the server.
- `csp.ts` — builds the CSP, adding **only** the exact vendor hosts a configured
  adapter needs.
- `events.ts` — the internal event vocabulary, the vendor mapping, the payload
  allowlist and the forbidden-key guard.
- `purchase.ts` — the Purchase safety gate (fail-closed).
- `index.ts` — the single public surface; product code and the admin
  diagnostics screen import from here and never from an adapter.

Config is re-resolved per request from the Worker environment. The browser
bundle is handed **only public vendor ids** (they appear in any site's page
source anyway); no secret, token or key is ever placed in HTML.

Event flow guarantees:

- Events fire **only after the real action succeeds** (a successful cart
  mutation, a successful quote/session, a completed registration) — never on a
  click and never optimistically.
- `trackOnce()` (with a persisted, local, opaque dedupe key) prevents a
  duplicate one-time event on reload or double-submit.
- Page View is de-duplicated per distinct SPA navigation (`pushState` /
  `replaceState` / `popstate` are wrapped), so a client-side navigation does not
  emit a second PageView.
- Every browser operation is wrapped so a vendor failure can never break the
  page.

---

## 2. Environment bindings

All bindings resolve from the Worker environment. **Absence means off.** Set
these as plain variables in `wrangler.jsonc` (`[vars]`) or, for local dev, in
`.dev.vars` (see `.dev.vars.example`). None of them is a secret.

| Binding | Meaning | Validation |
|---|---|---|
| `MARKETING_TRACKING_ENABLED` | Master switch. Unset/`0`/`false`/`no`/`off` ⇒ everything off. | truthy words only |
| `META_PIXEL_ID` | Meta Pixel id. | 15–16 digits |
| `TIKTOK_PIXEL_ID` | TikTok Pixel id. | 20 uppercase alphanumerics |
| `GA4_MEASUREMENT_ID` | GA4 measurement id. | `G-XXXXXXXX` |
| `GOOGLE_ADS_ID` | Google Ads id. | `AW-123456789` |
| `GOOGLE_ADS_PURCHASE_LABEL` | Google Ads conversion label (Purchase only). | `[A-Za-z0-9_-]{1,64}` |
| `MARKETING_ALLOW_AUTOMATION` | Dev-only escape hatch for the automated browser journey. Ignored unless `ENVIRONMENT=development`. | — |
| `MARKETING_PURCHASE_TRACKING` | Verified-payment-phase switch for Purchase. Inert on its own (see §6). | — |

**Fail closed on bad config.** An id that does not match its allowlisted shape
disables **that one adapter** and produces a clear, non-secret diagnostic on the
admin screen (`/admin/marketing`). A missing id is simply "not configured" — no
broken script tag is ever emitted, and the other adapters are unaffected.

There is deliberately **no free-text "custom script" field anywhere**: an
administrator can never inject raw JavaScript.

---

## 3. Consent behaviour

- **Categories:** `Necessary` (always on, not stored, not a choice),
  `Analytics` (controls GA4), `Marketing` (controls Meta + TikTok + Google Ads).
- **Default: denied.** Every non-essential category is off until the visitor
  chooses.
- **UI:** an accessible panel rendered **in the document flow** (never a fixed
  overlay, so it can never cover a control or trap a keyboard user) with three
  actions: **Accept all**, **Reject non-essential**, **Save preferences**. It is
  server-rendered in its correct initial state, so there is no flash and it
  works without JavaScript. When a decision already exists the panel is hidden;
  a **Cookie preferences** button in the footer reopens it. The first control in
  the panel receives focus on reopen; everything is a native checkbox/button, so
  it is keyboard-, screen-reader- and mobile-friendly.
- **Storage:** one first-party cookie (`ww_consent`) whose value records **only**
  a schema version, the two categories, and the decision timestamp — no
  identifier, no fingerprint, no vendor data. The decision expires after 180
  days (and a version bump invalidates it), forcing a re-ask.
- **Zero vendor requests before consent.** No vendor library is loaded and no
  request is made to a vendor origin until the matching category is granted.
- **Google Consent Mode v2 (basic mode).** The four signals
  (`analytics_storage`, `ad_storage`, `ad_user_data`, `ad_personalization`) are
  pushed as **denied** before anything loads, and updated immediately on save.
  Because the vendor library itself is not loaded pre-consent, basic mode holds
  — there are no pre-consent consent-mode pings.
- **Withdrawal stops future events** and clears the vendor cookies that can be
  cleared (`_fbp`, `_fbc`, `_gcl_au`, `_ga`, `_gid`, `_tt_enable_cookie`,
  `_ttp`, `ttclid`) and calls `fbq('consent','revoke')`.
- **No render blocking.** The bundle is a deferred ES module; consent UI wiring
  happens on `DOMContentLoaded`.

`src/marketing/consent.ts` is the reference implementation; the browser bundle
re-implements only the trivial read/write and shares the same shape/version, so
the server (tests, diagnostics) and the browser always agree.

---

## 4. Event → vendor mapping

Internal names are the only vocabulary product code knows. The mapping lives in
`src/marketing/events.ts` (`EVENT_MAP`) and is mirrored by the browser bundle.

| Internal event | Meta | TikTok | GA4 | Consent needed | Fired when |
|---|---|---|---|---|---|
| `page_view` | `PageView` | `PageView` | `page_view` | Analytics | each distinct navigation |
| `view_product` | `ViewContent` | `ViewContent` | `view_item` | Analytics | a product page renders |
| `search` | `Search` | `Search` | `search` | Analytics | a catalogue search happens |
| `add_to_cart` | `AddToCart` | `AddToCart` | `add_to_cart` | Marketing | the cart mutation succeeded |
| `begin_checkout` | `InitiateCheckout` | `InitiateCheckout` | `begin_checkout` | Marketing | a server quote/session exists |
| `registration` | `CompleteRegistration` | `CompleteRegistration` | `sign_up` | Marketing | the account was created |
| `customize_product` | `CustomizeProduct` (custom) | `CustomizeProduct` | `custom` | Marketing | personalization was added |
| `purchase` | `Purchase` | `Purchase` | `purchase` | Marketing | **only** via the Purchase gate (§6) |

An event is delivered to exactly the adapters whose consent category the
visitor granted. `search` terms are sanitized by `safeSearchTerm()` and, in
practice, the term is **omitted** — only the fact that a search happened is
sent. Money is carried internally as **integer minor units** and converted to
major units **exactly once, at the adapter boundary** (`toMajorUnits`).

---

## 5. Privacy exclusions

**Never tracked (routes).** Tracking is refused by default on a fail-closed
allowlist basis; every non-public route is excluded:

- `/admin*` and `/api*`
- `/my*`, `/account*` (account/library surfaces)
- `/order-success`, `/reset-password`, `/verify-email` (token-landing routes)
- `/photos/*` and private download/reader routes
- authenticated automated browser-test sessions (the browser bundle stays inert
  when `navigator.webdriver` is set, unless the dev-only automation hatch arms
  it)

**Never sent to a vendor (payload).** A blanket allowlist plus a forbidden-key
guard: any payload carrying one of the keys below is **refused outright**, and a
regression test (`test/unit/marketing-events.test.ts`) fails if any of them is
ever present in a built payload:

`name, childName, age, childAge, email, phone, address, photo, photoUrl,
photoKey, uploadKey, faceId, faceCount, boundingBox, analysis, dedication,
userBookId, orderId, paymentId, session, sessionId, token, csrf, csrfToken`

In particular: child name/age, photo/URL/upload key/signed URL, face data,
dedication/personalization text, email/phone/address, customer/user/prospect
id, session/CSRF token, guest capability token, internal
order/payment/userBook id, private reader/PDF URL, raw search text, and any
user-generated custom field.

**Allowed:** public slug/SKU, public category, safe variant code, quantity, ISO
currency, integer-derived money (converted once at the adapter boundary), a
randomized event id, and a coarse non-sensitive page type.

**Attribution** auto-detects `fbclid, ttclid, gclid, gbraid, wbraid, utm_*`
**only when marketing consent already exists**, stores the minimal set with a
30-day expiry in a first-party cookie (`ww_attr`), is **never logged**, and
**never affects price, ownership, checkout or payment**.

---

## 6. Purchase safety gate

A Purchase event is money-affecting advertising signal, so it is the most
tightly gated part of this feature. `src/marketing/purchase.ts` refuses to emit
it unless **all** of the following hold:

1. A payment provider is configured **and** the order reached a state set
   **exclusively** by a provider-authenticated (signature-verified) transition.
2. `value` / `currency` / items come from **trusted D1 order data**, never from
   the browser.
3. A separate **opaque marketing transaction id** is used (never the internal
   order id), backed by a durable exactly-once record.

A Purchase is **never** emitted from order creation, a success-URL parameter, a
browser-supplied "paid" value, or a `test-manual` / `pending` / `failed` /
`cancelled` / `abandoned` / `unpaid` order. The browser can never supply
value/currency/status.

**Status of this baseline: DISABLED (fail-closed).** The verified baseline ships
with payments disabled (`PAYMENT_PROVIDER` unset ⇒ the fail-closed provider);
the only offline provider (`deterministic-fake`) is gated to
`ENVIRONMENT=development`; and although a signature-verified capture path exists
(`handleVerifiedWebhook` in `src/commerce/payments/service.ts`) it is reachable
only when a real, fully configured provider is deployed — and the durable
exactly-once marketing record does not exist yet. The adapter, gate and tests
**do** exist, so wiring Purchase in the verified-payment phase is a small,
well-bounded change. The browser bundle additionally hard-codes
`PURCHASE_GATE_OPEN = false`, so even a misconfiguration cannot emit Purchase
pre-verification.

---

## 7. Local testing

```
npm run typecheck     # tsc --noEmit — must be 0 errors
npm test              # vitest — includes the 6 marketing unit files
npm run secrets:scan  # tracked + untracked, must be clean
```

The marketing unit files are:

- `test/unit/marketing-config.test.ts` — master switch, per-adapter validation,
  masking, route allowlist, bootstrap, automation hatch.
- `test/unit/marketing-consent.test.ts` — defaults denied, versioning/expiry,
  Consent Mode v2 signals.
- `test/unit/marketing-csp.test.ts` — baseline CSP unchanged with no marketing;
  only exact configured hosts added.
- `test/unit/marketing-events.test.ts` — the vendor mapping, the allowlist, the
  **forbidden-key regression**, money conversion, search sanitization, and the
  "only the adapter layer touches a vendor global" check.
- `test/unit/marketing-http.test.ts` — bootstrap only on allowed routes; CSP
  reflects configured adapters; the admin diagnostics screen is admin-only and
  never leaks a whole id.
- `test/unit/marketing-purchase-gate.test.ts` — the gate is fail-closed in every
  baseline configuration and a browser can never make it fire.

To exercise the layer locally, copy `.dev.vars.example` → `.dev.vars`, set
`MARKETING_TRACKING_ENABLED=1` and a **clearly fake** id per adapter (they must
still match the validated shapes — see the file's examples), and run the dev
server. Open DevTools → Network and confirm **no vendor request** is made before
you press *Accept all* (or tick Marketing and Save).

---

## 8. Production setup (all four integrations)

Set the master switch and each id as plain (non-secret) variables in
`wrangler.jsonc` → `[vars]`, or via the Cloudflare dashboard
(*Settings → Environment variables*) for the Pages project. Add only the
integrations you actually use.

```jsonc
// wrangler.jsonc  (illustrative — use your real ids)
{
  "vars": {
    "MARKETING_TRACKING_ENABLED": "1",
    "META_PIXEL_ID": "<your-meta-pixel-id>",
    "TIKTOK_PIXEL_ID": "<your-tiktok-pixel-id>",
    "GA4_MEASUREMENT_ID": "G-<your-ga4-id>",
    "GOOGLE_ADS_ID": "AW-<your-ads-id>",
    "GOOGLE_ADS_PURCHASE_LABEL": "<your-conversion-label>"
  }
}
```

Where to find each id:

- **Meta** — Events Manager → Data sources → your Pixel → Settings → *Pixel ID*.
- **TikTok** — Ads Manager → Assets → Events → Web Events → your Pixel →
  *Pixel ID*.
- **GA4** — Admin → Data streams → your web stream → *Measurement ID* (`G-…`).
- **Google Ads** — Tools → Conversions → your conversion action → *Tag setup* →
  the `AW-…` id and the conversion *label*.

CSP: no manual step is needed. `src/marketing/csp.ts` adds **only the exact
official hosts** required by the configured adapters (never a wildcard, never a
scheme-only source). With no marketing configured the CSP is byte-for-byte the
baseline the application always shipped.

---

## 9. Verifying with the official vendor tools

After deploying (and after pressing **Accept all** in the banner):

- **Meta** — *Meta Events Manager → Test Events* (or the **Meta Pixel Helper**
  browser extension): confirm `PageView`, `ViewContent`, `AddToCart`,
  `InitiateCheckout`, `CompleteRegistration`. Confirm **no** event arrives
  before consent.
- **TikTok** — *TikTok Events Manager → Test Events* (or the **TikTok Pixel
  Helper** extension): confirm the matching events and the 20-char pixel id.
- **GA4** — *GA4 → Admin → DebugView* (add `?debug_mode=1` or use the **GA
  Debugger** extension): confirm `page_view`, `view_item`, `add_to_cart`,
  `begin_checkout`, `sign_up`. Confirm Consent Mode shows all four signals
  `denied` before consent and `granted` after.
- **Google Ads** — *Google Ads → Goals → Conversions → Diagnostics* plus
  **Tag Assistant** for the `AW-…` tag. Purchase conversions stay silent until
  the Purchase gate is enabled (§6).

A diagnostic screen is available to admins at **`/admin/marketing`**
(permission `integrations.read`): it shows global enabled/disabled, each
adapter's configured/not state (ids **masked**), the consent model version,
whether Purchase is active or safely blocked (with the reason), and the
validation diagnostics. It exposes no secret and cannot inject a script.

---

## 10. Disabling every integration immediately

Fastest → slowest:

1. **Global kill switch** — unset `MARKETING_TRACKING_ENABLED` (or set it to
   `0`) and redeploy the Pages project. The master switch is checked per
   request: with it off, **no bootstrap is emitted, no vendor host is added to
   the CSP, and the browser bundle stays inert** — the page makes zero vendor
   requests.
2. **One integration** — remove that adapter's id (e.g. `TIKTOK_PIXEL_ID`) and
   redeploy. That adapter stops; the others continue. An id that fails
   validation disables just that adapter too.
3. **Purchase** — it is already disabled; nothing to do. Do not set
   `MARKETING_PURCHASE_TRACKING` until the verified-payment phase lands.

Because every event is consent-gated and the master switch is re-read per
request, disabling does not require a client cache purge; a returning visitor's
stored consent cookie is inert while tracking is off.

---

## 11. Known limitations

- **Purchase tracking is disabled** by design (see §6). Enabling it requires the
  verified-payment phase: a provider-authenticated capture plus a durable
  exactly-once marketing record keyed by an opaque marketing transaction id.
- **CSP still allows `'unsafe-inline'` scripts/styles** (a pre-existing Phase 8
  item); this feature adds only exact vendor hosts and does not widen the
  inline allowance.
- **Google Consent Mode v2 is basic mode** — the vendor library is not loaded
  pre-consent, so there are no pre-consent consent-mode pings. Advanced mode
  (loading `gtag.js` denied-first to model conversions) is intentionally not
  used.
- **Cookie clearing on withdrawal is best-effort**: a cookie set on a
  different path/domain by the vendor may survive; vendor-side revocation
  (`fbq('consent','revoke')`) is issued where supported.
- **Attribution** is first-party, minimal and expiring; it is not joined to any
  account or order and never affects pricing or ownership.
- The **Playwright vendor-interception e2e test** for this feature is tracked
  separately (browser journeys) and is not part of the unit gate.
