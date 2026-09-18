# V2 admin panel — gap analysis against §10

Scope: the admin surface as it exists on `feat/storefront-visual-redesign`, compared
against **`STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md` §10 "Admin information
architecture"** (the tree at pack line 616) and **`docs/V2_PHASE6_TRACEABILITY.md`**
(ADM-01…ADM-21). Read-only survey, then a small, deliberately bounded completion.

The method: enumerate the §10 tree, map each node to its nav entry, route(s) and
permission from `src/admin-console/{nav,policy,routes,api}.ts` plus the legacy
`src/admin.ts` / `src/admin_routes.ts` surface, and classify each as **exists**,
**thin**, **missing** or **honest shell** (a screen that says a later phase owns
the capability rather than pretending).

## 1. Node-by-node

| §10 node | Nav entry → route | Permission | Status | Notes |
| --- | --- | --- | --- | --- |
| Dashboard | Dashboard → `/admin` | `dashboard.view` | exists | Ledger revenue + 20 operational counts (`ops.ts::dashboardModel`). |
| Orders — items and timeline | Orders → `/admin/orders`, `/admin/orders/:id` | `orders.read` | exists | Notes + validated status transitions + short-lived item-photo capability. |
| Orders — payments/refunds/disputes | Finance → `/admin/finance{,/payments,/refunds,/disputes,/events,/reconciliation}` | `finance.*` | **thin** | All five screens exist; **disputes have no operator action** and reconciliation is a read. A dispute action needs a provider adapter that does not exist yet. |
| Orders — production/shipment | PDF, print & fulfilment → `/admin/fulfilment` | `fulfilment.read` | honest shell | Phase 7 owns the print profile, renderer, preflight and provider adapter; `FULFILMENT_SCOPE` states this on the page. |
| Customers and prospects | Customers → `/admin/customers`; Prospects & consent → `/admin/prospects` | `customers.read`, `customers.consent` | exists / thin | Customers full (detail + role grant). Prospects read-only by design (ADM-05). |
| User books — inputs/faces | User books → `/admin/books` | `books.read` | **was missing → completed** | The list existed, its row link pointed at `/admin/books/:id` **which did not exist** (a dead link), and `books.manage` gated nothing. |
| User books — generations/previews | Previews & approvals, Generation ops | `previews.read`, `generation.read` | exists | Queues, retry/cancel, attempts, cost (never summed across currencies — ADM-10). |
| User books — revisions/approvals | (same queues) | `previews.read` | thin | Operator view is read-only; approving on a customer's behalf is deliberately not offered (an approval is the customer's own decision). |
| Catalog — products/variants/prices | Catalog, Products (classic) | `catalog.read`, `catalog.write` | exists | Two surfaces (new + legacy classic) both resolve. |
| Catalog — collections/age/theme/language | Collections | `catalog.write` | exists | CRUD + membership. |
| Catalog — media/related/reviews | Media, Reviews | `catalog.write`, `reviews.moderate` | exists / thin | Media registers a **path**, it does not upload bytes (ADM-06 limitation, stated on the page). Reviews: publish/reject only. |
| Story Studio — templates/versions | Story Studio | `studio.*` | exists | Draft→published with re-auth; published versions immutable by design. |
| Story Studio — scenes/placeholders | (template detail) | `studio.write` | exists | Scene editing limited to subject + layout JSON. |
| Story Studio — prompt/model configuration | (template detail), AI & provider settings | `studio.write`, `integrations.read` | thin | Prompt versions are editable **as versions**; the model/provider *credentials* are status-only by design (no "set a credential" control anywhere, ADM-17). |
| Generation operations | Generation ops | `generation.operate` | exists | Dispatch bounded to 10 jobs per call. |
| PDF and print | (fulfilment) | — | **missing capability** | No renderer exists in this build. Phase 7 (FUL-01…FUL-10). The screen says so instead of faking a queue. |
| Fulfilment and tracking | (fulfilment) | — | **missing capability** | No shipment/tracking columns exist in the schema. Phase 7. |
| Discounts and promotions | Discounts | `finance.discounts` | exists | Codes deactivate, never delete. |
| Support inbox | Support inbox | `support.*` | exists | Assignment CAS, SLA, priority, staff replies, internal notes. |
| CMS — homepage/navigation/footer | Homepage & CMS | `cms.write` | exists | Blocks, nav, announcements, settings. |
| CMS — PDP blocks | Products → PDP editor | `cms.write` | exists | 18 block actions. |
| CMS — blog/FAQ/legal pages | Pages, blog & legal | `cms.write` | exists | Pages + FAQs CRUD. |
| Localization | Localization | `localization.read/write` | thin | Completeness is **reported, not enforced**; full locale/SEO is Phase 8 (PLT-06…08). |
| Integrations and health | Integrations & health, AI & provider settings | `integrations.read/flags` | exists | Honest configured/not-configured report; **no live probe and no secret entry** (deliberate). |
| Privacy and retention | Privacy requests, Retention failures | `privacy.read/manage` | thin / honest shell | Intake + operator workflow + retention retry exist; automated export bundle and account erasure are Phase 8 (PLT-10). |
| Staff / roles / permissions | Staff & permissions | `staff.read/manage` | exists / thin | Grants are editable with re-auth; the **role→permission matrix is display-only** (ADM-02). |
| Audit log | Audit log | `audit.read` | exists | Append-only at the DB level, redacted on both write and read. |
| Exports (ADM-21) | Exports | `exports.read/create` | exists | Inline CSV, 5000-row cap, one permission per kind. |
| Events & webhooks (ADM-19) | Events & webhooks | `events.read` | exists | 12 redacted streams. |

## 2. Cross-cutting rules from §10 (pack lines 652-662)

| Rule | Status |
| --- | --- |
| Positive + negative permission checks on every action | Satisfied. `policy.ts` is fail-closed and `phase6-rbac.test.ts` walks Hono's route table, so a route with no policy entry is a test failure. |
| Valid transitions, never a free-text status field | Satisfied by the order/support/privacy state machines. The new user-book action follows it (`cancelled`/`expired` only). |
| Paid revenue from captured/refunded ledgers | Satisfied (`financialSummary`). |
| Published template versions immutable | Satisfied (clone-to-edit). |
| Private photo/preview access short-lived + permission-checked | Satisfied: capability tokens with a 2-minute TTL; the legacy blanket admin bypasses were removed. |
| Reason on every high-risk action + re-auth for refunds/role changes/privacy deletion | Satisfied. The new user-book action requires a reason; it is deliberately **not** in the re-auth set, because the catalogue seeds `books.manage` with `high_risk = 0` (0033) and the panel's rule is that re-auth marks exactly the catalogue's high-risk set. |
| Pagination, search, filter, stable sort, empty/error states, export permission | Satisfied via `list.ts`. |
| No N+1 | Satisfied; the new detail screen is a fixed number of parallel queries. |
| Secrets shown only as configured / not-configured / last-tested | Satisfied. |

## 3. What this batch completed

1. **`GET /admin/books/:id` — the user-book detail screen** (`src/admin-console/books.ts`,
   `views.ts::adminBookDetailView`). It fixes a **dead link** in the existing list and
   implements the §10 "User Books" triad: inputs/faces (including which detected face
   is selected), every generation attempt, every preview version with its watermarked
   page count and approval state, and the recent domain-event timeline. Bounded,
   parallel reads; no N+1.
2. **`POST /admin/books/:id/state`** — the action the seeded `books.manage`
   permission was created for but which **gated nothing**. It moves a non-terminal
   book to `cancelled` or `expired` **through the domain state machine** (one CAS
   update + one append-only `user_book_events` row), requires a reason and checks
   the optimistic-concurrency version. It is **not** a re-auth action: the
   catalogue seeds `books.manage` with `high_risk = 0`, so the screen renders no
   password challenge (a field the guard would not check is not a control).
   Exactly one audit event on success; a refused action writes nothing.

Both routes have policy entries, and the refusal path renders a statement of the
rule that was broken rather than a raw database error.

## 4. What remains, and who owns it

| Gap | Owner |
| --- | --- |
| PDF/print renderer, print profile, preflight, print-provider adapter | **Phase 7** (FUL-01…FUL-10) |
| Shipment + tracking (no schema columns exist) | **Phase 7** — needs a forward-only migration |
| Automated privacy export bundle and account erasure | **Phase 8** (PLT-10) |
| Locale/SEO completeness enforcement | **Phase 8** (PLT-06…08) |
| Dispute operator actions, reconciliation resolution | needs the Phase-4 payment adapter to be operational |
| Editable role→permission matrix | **Phase 6 follow-up** (ADM-02 declares the matrix display-only) |
| Media **byte** upload (today it registers a path) | **Phase 6 follow-up** (ADM-06) |
| Operator approval on a customer's behalf | deliberately **not** planned (ADM-11) |
| PayPal | not planned until an adapter + webhook exist; the capability report keeps it hidden |

## 5. Deliberate non-changes

* No new admin permission was invented, and no seeded permission was removed.
* `previews.operate` and `fulfilment.operate` still gate nothing. That is unchanged
  here on purpose: the honest answer for both is a Phase-7 capability, and inventing
  a route just to make the permission non-empty would be a fake.
* The "Products (classic)" duplicate of "Catalog" was left in place; consolidating
  it is a refactor with no user-visible benefit in this batch.
