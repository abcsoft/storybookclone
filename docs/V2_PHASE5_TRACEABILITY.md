# V2 Phase 5 Traceability — Customer Account, My Books, Approval and Support

Branch: `feat/customer-lifecycle-v2`
Baseline HEAD: `3ee3bcd69d0dbbbf655ca4b6b6561c9990c43807` (accepted Phase-4 tip)
Migrations added: `0028_customer_account_security.sql`,
`0029_customer_claims_revisions.sql`, `0030_email_outbox_templates.sql`,
`0031_support_tickets.sql`, `0032_customer_downloads_privacy.sql`
(forward-only; `0001`–`0027` byte-identical)

Every row below is a claim backed by a code path AND a test (or a browser
journey). A row with no proof does not appear here. "Limitation" states honestly
what the row does NOT cover.

Test file key: **AT** = `test/unit/phase5-account-auth.test.ts`,
**GC** = `test/unit/phase5-guest-claim.test.ts`,
**RA** = `test/unit/phase5-revision-approval.test.ts`,
**DL** = `test/unit/phase5-downloads.test.ts`,
**SU** = `test/unit/phase5-support.test.ts`,
**OV** = `test/unit/phase5-order-account-views.test.ts`,
**MB** = `test/unit/phase5-email-outbox.test.ts`,
**J** = the `phase5-customer-lifecycle` browser journey (`scripts/e2e-phase5.mjs`),
**I** = the `[phase5 upgrade]` scenario in `scripts/test-integration.mjs`,
**A** = `npm run audit:frontend -- phase5-customer`.

---

## CUS-01 — Register / login / logout / password reset / email verification

| | |
|---|---|
| Code | `migrations/0028_customer_account_security.sql` (`users.email_verified`/`email_verified_at`/`status`/`updated_at`, `email_tokens` with the single-use trigger, `account_security_events`), `src/account/profile.ts` (`issueEmailToken`, `consumeEmailToken` with an `expectedUserId` refusal that does NOT burn the token, `sendVerificationEmail`, `verifyEmail`), `src/index.tsx` (`POST /register` now queues the confirmation link and records a `registered` event; `GET /verify-email` consumes it), `src/password-reset.ts` (unchanged fail-closed gate, now delivering through the outbox), `src/mail/*` |
| Test proof | AT: registering leaves `email_verified = 0` in the database and `verified: false` in the API; the address becomes verified ONLY by consuming the mailed token; the token is single-use (replay refused); unknown/malformed/expired/foreign tokens refused; a resend retires the previous token; a token for an address that has since changed verifies nothing; the verification endpoint requires a session. MB: the reset email goes through the durable outbox as ONE row and is delivered exactly once. I: no pre-existing account is marked verified by the migration |
| Browser proof | J phase5.2: after registering, the profile page says "Not confirmed"; the link is read from the development console adapter's own output, opened in the browser, and the confirmation is asserted in the database. A: `/verify-email?token=…` in its invalid state at six viewports |
| Limitation | An account cannot be verified without the mailbox: there is no admin "mark verified" action and no dev-only HTTP echo of a token. In a deployment with no email provider configured, verification is therefore UNAVAILABLE and the UI says so — that is the honest state of this build, not a bug. A password reset still requires an adapter (the Phase-1 gate is unchanged). |

## CUS-02 — Session management and security notifications

| | |
|---|---|
| Code | `migrations/0028` (`sessions.public_id`/`user_agent`/`last_seen_at`/`ip_hash`/`created_ip_hash` + a backfill that gives every EXISTING session an addressable id), `src/account/sessions.ts` (`listSessions`, `revokeSession`, `revokeOtherSessions`, `deviceLabel`), `src/account/security.ts` (`recordSecurityEvent`, `notifyAccountSecurity`, `ipDigest`), `src/auth.ts` (`createSession` records the metadata; `currentSessionPublicId`), `src/account/routes.ts` (`GET/DELETE /api/v1/me/sessions`, `POST /api/v1/me/sessions/revoke-others`, `GET /api/v1/me/security-events`), `src/account/pages.ts` (`/account/security`) |
| Test proof | AT: the list shows the current session marked and never includes a token; revoking a session works; a FOREIGN session id is a 404 that revokes nothing and writes no security event on the victim's account; `revoke-others` keeps the caller signed in and records an event; a malformed id is a plain 404; the stored value is a DIGEST of the address, never the address. OV: password reset revokes every session and records `password_reset` |
| Browser proof | J phase5.5: `/account/security` renders "This session" and contains no credential-shaped value. A: `/account/security` at desktop + mobile, including the a11y pass |
| Limitation | `last_seen_at` is recorded at sign-in and refreshed when the account page is opened (one conditional UPDATE per account-page view), not on every request — it is labelled "last activity seen" for that reason. A session list is capped at 100 rows. There is no per-session re-authentication challenge (S-09 is Phase 6). |

## CUS-03 — Profile, email change and address book

| | |
|---|---|
| Code | `src/account/profile.ts` (`getProfile`, `updateProfileName`, `requestEmailChange`, `confirmEmailChange`, `getNotificationPreferences`, `updateNotificationPreferences`), `src/account/routes.ts` (`GET/PATCH /api/v1/me`, `POST /api/v1/me/email`, `POST /api/v1/me/email/confirm`), `src/account/web.ts` (`/account/profile`, `/account/addresses` + their form handlers, reusing `validateAddress` from `src/commerce/checkout.ts`), `src/account/pages.ts` |
| Test proof | AT: PATCH affects only the caller's own name and rejects a blank one; an email change REQUIRES the current password (403 otherwise, and nothing is sent), sends the confirmation to the NEW address, leaves the OLD address in place until it is confirmed, verifies the new address on confirmation, and notifies the OLD address afterwards; a second account cannot consume the token; an address already in use is refused. J: the address book saves a real default address; the rename persists |
| Browser proof | J phase5.5 (`/account/profile` rename, `/account/addresses` create). A: `/account/profile` and `/account/addresses` at desktop + mobile |
| Limitation | The address book is create / make-default / delete. Editing an existing address is available through the API (`PATCH /api/v1/me/addresses/:id`, Phase 4) but has no dedicated form on the address page yet. An email change requires a working email provider to complete — with delivery disabled, the request is recorded and the page says the address has NOT changed. |

## CUS-04 — Verified guest draft/order claiming

| | |
|---|---|
| Code | `migrations/0029_customer_claims_revisions.sql` (`guest_claims` with `verified_via` CHECK-constrained to exactly `('email_token','guest_capability')` and `UNIQUE(resource_type, resource_ref)`), `src/account/claims.ts` (`eligibleGuestOrdersForEmail`, `claimOrder`, `claimOrderWithCapability`, `requestGuestClaim`, `confirmGuestClaim`, `requireVerifiedAccountEmail`), `src/account/routes.ts` (`/api/v1/me/claims…`), `src/account/web.ts` (`/account/claims`, `/account/confirm-claim`, `/account/claim-order`), `src/index.tsx` (`/order-success` offers "Add this order to my account" when the visitor is signed in AND holds the order's own token) |
| Test proof | GC: typing an address claims NOTHING (order still `user_id IS NULL`, no claim row); a made-up token claims nothing; the request response is IDENTICAL whether or not the address has an order; confirming the mailbox moves the order AND the prospect-owned book (`user_id` set, `prospect_id` NULL) and records `verified_via='email_token'`; the capability path needs no email and records `verified_via='guest_capability'`; an expired token, a token belonging to another account, a tampered/wrong-order capability token and an unverified account are all refused; a second account cannot claim an already-claimed order (and gets a generic 404 with the capability token, so it cannot even confirm the order exists); an order that belongs to an account is never claimable by email; every route requires a session. I: the DB refuses a second claim of the same order and refuses to edit a claim |
| Browser proof | J phase5.3: the guest's email is typed into the claim form and the order does NOT move (asserted in the database and by an empty My Books list); the link mailed to the guest address is then opened and the order + book move, with `verified_via = 'email_token'` asserted in the database. J phase5.4: the claimed order renders with its timeline, payments and receipt, and the book appears in My Books |
| Limitation | Claiming is by EMAIL for orders. A guest's unsaved DRAFT is claimable only through the order it was built into (a prospect has no address to prove control of), which is exactly what the order-claim transfers. A claim is permanent: there is no self-service "unclaim" (an operator action would be needed). Entitlements are provisioned at claim time, so a guest who paid but never claims has no download until they do. |

## CUS-05 — My Books and order dashboard

| | |
|---|---|
| Code | `src/account/orders.ts` (`listCustomerOrders`, `getCustomerOrder`, `formatMinor`, `paymentStatusLabel`), `src/account/library.ts` (`listMyBooks`, `toMyBookSummary`), `src/index.tsx` (`GET /api/v1/my/orders` extended ADDITIVELY — every pre-Phase-5 field keeps its place), `src/account/web.ts` (`GET /my/books` is now the BOOKS library; `/my/orders` redirects to `/my-books`), `public/static/my-books.js`, `src/pages.ts` |
| Test proof | OV: the list carries the ledger-derived `payment_status_label`, minor-unit totals and labels while keeping `id`/`total`/`item_count`/`created_at`; a second customer sees none of it and gets a 401 when anonymous; `/api/v1/my/books` reports each book's state, revision, preview count, approval, change-request count and retention deadline. RA: a stranger's book list is empty |
| Browser proof | J phase5.4 and phase5.9 (the second customer's list is empty). A: `/my-books` and `/my/books` at desktop + mobile |
| Limitation | `/my-books` (orders) is still a client-rendered shell fed by `/api/v1/my/orders` — the pre-existing structure the other journeys assert on — while the account pages are server-rendered. Both are covered by the audit, but only the account pages work with JavaScript disabled. |

## CUS-06 — Book/order detail and timeline

| | |
|---|---|
| Code | `src/account/orders.ts` (`orderTimeline` reading `order_state_events` itself, `timelineLabel`, `nextStatesFor`, the production/shipment derivation), `src/index.tsx` (`GET /api/v1/my/orders/:id` extended with `timeline`/`payments`/`refunds`/`addresses`/`production`/`summary`/`downloads`/`receiptUrl`), `public/static/my-books.js` (`timelineHtml`, `paymentsHtml`, `refundsHtml`, `addressesHtml`) |
| Test proof | OV: a fresh order's timeline is EMPTY (nothing is inferred from the current status); a transition to the same status writes no event; a real transition adds exactly one entry with its actor and a human label; after `shipped` the production flags change and a production entry is marked; `order_state_events` is append-only at the database level; payments/refunds/addresses reflect only what is recorded, and no tracking/carrier field is fabricated. I: `order_state_events` immutability is asserted at the schema level |
| Browser proof | J phase5.4: the detail page renders "Paid", "Order timeline", "Payments" and the receipt link from real rows. A: `/my-books` at desktop + mobile |
| Limitation | The timeline renders the last 200 events, newest first. Shipment/tracking data does not exist until Phase 7, so the shipment line says a shipment was recorded and names no carrier — it does not invent one. |

## CUS-07 — Preview viewer and version history

| | |
|---|---|
| Code | `src/account/library.ts` (`getMyBookDetail` → `versions` with `isCurrentRevision`/`approved`/`approvalInvalidated`/`canApprove` and their watermarked page assets, the book event log, the approval decision log, the consent/retention block), `src/account/web.ts` (`GET /my/previews/:userBookId`), `src/account/pages.ts` (`myPreviewPage`), `src/generation/routes.ts` (`/previews/:key` entitlement, unchanged) |
| Test proof | RA: the history exposes every published version with its real pages, each page an OPAQUE app route (`/previews/…`) with no storage key, no signed URL and no `token=`; only the current revision's ready preview is approvable; the payload contains no `object_key`/`originals/`; the retention deadline and consent version are reported (PER-09); the version history is unchanged after a revision except for the new version. I/OV: preview assets are watermarked and read back through the entitlement route |
| Browser proof | J phase5.7: the preview page lists version 1, offers "Approve version 1 exactly", and after the revision still lists the old version's pages. A: `/my/books` at desktop + mobile |
| Limitation | The reader at `/my/books/:slug` still renders the legacy placeholder spread alongside the real generation panel — that is the pre-existing Phase-2/3 reader, unchanged. The version history lives on `/my/previews/:userBookId`. Pages are shown at the resolution they were generated; there is no zoom or download of an individual page (only the entitled archive). |

## CUS-08 — Revision request with structured reason, notes, replacement photo and policy limits

| | |
|---|---|
| Code | `migrations/0029` (`revision_requests.reason_code`/`replacement_upload_key`/`policy_json`/`structured_reason` + the append-only `revision_request_resolutions`), `src/account/library.ts` (`REVISION_REASON_CODES`, `revisionPolicy`, `requestStructuredRevision`), `src/account/routes.ts` (`POST /api/v1/my/books/:id/revisions`), `src/account/web.ts` (the multipart form, which stores the photo through the SAME two-phase upload lifecycle), `src/account/pages.ts` |
| Test proof | RA: a missing/unknown reason code and out-of-policy notes are refused with field-level errors and record nothing; the structured reason, verbatim notes and the policy in force are persisted; an `in_progress` resolution row exists; the per-revision and per-book limits are enforced from the append-only request log with an actionable message; a replacement photo CREATES A NEW IMMUTABLE INPUT REVISION (the previous revision row is byte-for-byte unchanged), advances `current_revision`, invalidates the active approval (an appended `invalidated` row), records `approval_invalidated`, and leaves the old version's pages in place; a request WITHOUT a replacement photo creates no revision and invalidates nothing; an expired book is refused |
| Browser proof | J phase5.7: selecting a reason, writing notes and attaching a replacement photo produces the customer-visible outcome "your replacement photo became a new version … the approval you had given no longer applies", and the database shows `approved,invalidated` with the revision advanced by one |
| Limitation | A replacement photo necessarily restarts face analysis (the pre-existing Phase-2 rule: analysis is per-upload), so the book returns to the analysis path and a new preview must be generated. Only ONE replacement photo per request. The policy limits are configurable per deployment (`REVISION_MAX_PER_REVISION`/`REVISION_MAX_PER_BOOK`) and defaults are 3 and 8. |

## CUS-09 — Exact-version approval

| | |
|---|---|
| Code | `src/account/library.ts` (`approvalEligibility`, `approveExactVersion` — the `user_books` CAS runs FIRST and both the approvals INSERT and the event INSERT are guarded by `changes() = 1` in the SAME batch), `src/account/routes.ts` (`POST /api/v1/my/books/:id/approvals`), `src/account/web.ts` (`POST /my/books/:id/approve`) |
| Test proof | RA: an approval records the EXACT `preview_version_id` and its `input_revision` with `decided_by_type='user'`; approving again is idempotent (no second decision row, no second event); an unknown version is 404; a version from another book is 404; a superseded version is 409 `stale_preview`; a book with nothing to approve is 409; a book whose order was cancelled or whose payment failed is 409 `order_not_eligible` and writes no approval; TWO CONCURRENT approvals of the same version leave exactly ONE decision row and `state='approved'`; the approvals table is append-only at the database level. GC/RA: an approval tied to a book is denied to a second user |
| Browser proof | J phase5.7: the approve button releases exactly one decision row for that version. A: the preview page renders at desktop + mobile |
| Limitation | Approval is per BOOK (which is the unit that becomes a printed item); an order with several items is approved item by item. There is no partial-page approval. An approval cannot be withdrawn by the customer — it is invalidated by changing the book, which is the canonical contract. |

## CUS-10 — Receipt, refunds, production and shipment status

| | |
|---|---|
| Code | `src/account/orders.ts` (`getCustomerOrder` → `payments`, `refunds`, `addresses`, `production`; `formatMinor`), `src/account/pages.ts` (`receiptPage`, `orderTimelineList`), `src/account/routes.ts` (`GET /api/v1/my/orders/:id/receipt`), `src/account/web.ts` (`GET /my/orders/:id/receipt`), `public/static/my-books.js` |
| Test proof | OV: the receipt renders for its owner and is a 404 for a stranger (both the page and the JSON); the JSON totals equal the order's ledger columns and satisfy the total identity; the page states "It is not a tax invoice" and never claims to be one; the payment row reflects `captured` with the real captured amount; refunds are empty rather than invented. DL: a refund in full revokes the entitlement and a partial refund does not |
| Browser proof | J phase5.4: the receipt link resolves to the receipt page for its owner and states what it is not. A: `/my-books` (logged-out) and the customer surfaces at desktop + mobile |
| Limitation | The receipt is a rendering of the payment records, not a fiscal document — it says so on the page. There is no PDF receipt. Shipping/tracking detail arrives with Phase 7; today the shipment line only reports that a shipment was recorded. |

## CUS-11 — Entitlement-checked, expiring downloads

| | |
|---|---|
| Code | `migrations/0032_customer_downloads_privacy.sql` (`download_entitlements` with `UNIQUE(order_item_id, kind)`, an immutable identity and a monotonic counter; `download_tokens` hashed at rest with a single-use trigger; `download_events`), `src/account/downloads.ts` (`provisionEntitlementsForOrder`, `revokeEntitlementsForOrder`, `describeEntitlement`, `resolveArtifactSource`, `buildEntitlementArtifact`, `mintDownloadToken`, `redeemDownloadToken`, `r2AssetReader`), `src/archive/zip.ts`, `src/account/hooks.ts` (provisioning on capture, revocation on refund), `src/account/routes.ts` (`GET /api/v1/my/downloads`, `POST …/token`, `GET /api/v1/downloads/:token`), `src/account/web.ts` (`/my/downloads`, `POST /my/downloads/:id` → 303) |
| Test proof | DL: entitlement only after money is captured, idempotently, one per item; a guest order is skipped until claimed; a full refund revokes and a partial refund does not; the LIST response contains no token/url/signature; the minted URL is a relative short-lived single-use capability and only its SHA-256 is stored; the delivered file is a REAL, reproducible ZIP whose bytes contain the actual watermarked preview page bytes; a used token is 410, an expired token is 410, an unknown token is 404; a new mint retires the previous token; the download limit and an expired entitlement are refused with a stated reason; an unavailable artifact is refused rather than faked (including `print_pdf`, which has no producer in this phase); the account page's HTML contains no token; a foreign account cannot see, mint or redeem (a fabricated token row for a foreign entitlement is 404 and recorded as `denied_foreign`). I: the cap, monotonic counter and token reuse are enforced by the database |
| Browser proof | J phase5.8: the downloads page contains no token; clicking Download produces a real `order-<n>-preview-r<n>.zip` whose bytes start with `PK`; the delivery is recorded; the link cannot be replayed and minting again retires the previous one. A: `/my/downloads` at desktop + mobile |
| Limitation | The artifact is an archive of the WATEROUSED preview pages — the only artifact this phase can honestly produce. A print-ready PDF has no producer until Phase 7, so a `print_pdf` entitlement is refused with that reason instead of a fabricated file. The token route requires no session by design (the token IS the capability: hashed, single-use, two minutes, bound to the entitlement's owner); the redirect that hands it to the browser puts it in the URL bar once, which is why it is single-use and `no-store`/`no-referrer`. |

## CUS-12 — Support tickets, messages and attachments

| | |
|---|---|
| Code | `migrations/0031_support_tickets.sql` (`support_tickets` with the status-flow trigger, append-only `support_ticket_events`/`support_messages`, `support_attachments` with a content-type allowlist and a size CHECK), `src/account/attachments.ts` (magic-byte validation, markup refusal, server-generated keys), `src/account/support.ts` (`createTicket`, `listMyTickets`, `getMyTicket` with `is_internal = 0` enforced, `addCustomerMessage`, `setTicketStatus`, `transitionTicket`, `loadOwnedAttachment`), `src/account/routes.ts`, `src/account/web.ts`, `src/account/pages.ts` |
| Test proof | SU: a ticket is created with its first message and a `created` event; validation refuses a blank subject, an unknown category and a short body and writes nothing; an optional order reference must be the caller's OWN order; a reply moves the ticket to `waiting_staff`, a reply on a closed ticket is 409, and close/reopen work with every change recorded; a customer cannot set an operator-only state and the database trigger refuses an illegal transition; an internal note is invisible in the thread and in the list; a stranger cannot list, read, reply to, change or download from another customer's ticket; a real JPEG attachment is stored under the private `support/` prefix and served with `attachment` disposition + `nosniff` + a sandboxed CSP; HTML-as-text/plain, a type that does not match the bytes, an SVG, an oversize file, a truncated image, binary-as-text and a mislabelled PDF are all refused with nothing written; the display filename is sanitised and the storage key never derives from it. I: the status machine and the attachment allowlist/size are enforced by the database |
| Browser proof | J phase5.6: a ticket with a real photo attachment is created, the attachment is listed and stored privately, a reply moves the status, and close then reopen both take effect. A: `/account/support` at desktop + mobile |
| Limitation | The customer side is complete; assignment, SLAs and the operator inbox are Phase 6 (the columns and indexes exist, and no Phase-5 path can set them). Only the four allowlisted attachment types are accepted, and an attachment must satisfy the SAME photo policy as an upload (800–4000px). `sla_due_at` is set to 24 hours as a recorded first-response target; Phase 6 owns the real policy. |

## CUS-13 — Notification preferences

| | |
|---|---|
| Code | `migrations/0028` (`notification_preferences` with `CHECK (security_alerts = 1)`), `src/account/profile.ts` (`getNotificationPreferences`, `updateNotificationPreferences`, `mayEmail`), `src/account/routes.ts` (`GET/PATCH /api/v1/me/notifications`), `src/account/web.ts`, `src/account/pages.ts` |
| Test proof | AT: the defaults are order/generation/support ON, marketing OFF and security ON; an update persists per account and does not leak to another; the account-safety preference CANNOT be switched off (the API reports it locked and the database rejects `security_alerts = 0` with a CHECK). I: the same CHECK is asserted at the schema level. OV: the platform capability report states the deployment's real delivery mode |
| Browser proof | J phase5.5: toggling marketing on and order updates off persists in the database while security alerts remain on. A: `/account/notifications` at desktop + mobile |
| Limitation | Preferences are honoured by the order/payment, revision, support and security emails this phase sends. Marketing email has no sender in this build (a `product_news` preference is recorded but nothing consumes it yet) — the page says the preference is about occasional news rather than claiming a newsletter exists. |

## CUS-14 — Data export / deletion request intake

| | |
|---|---|
| Code | `migrations/0032` (`privacy_requests` with a partial unique index enforcing ONE open request per (user, kind), append-only `privacy_request_events`), `src/account/privacy.ts` (`createPrivacyRequest`, `listPrivacyRequests`, `cancelPrivacyRequest`, `privacyExpectation`), `src/account/routes.ts` (`GET /api/v1/privacy/requests`, `POST /api/v1/privacy/export`, `POST /api/v1/privacy/delete`, `POST /api/v1/privacy/requests/:id/cancel`), `src/account/web.ts`, `src/account/pages.ts` |
| Test proof | OV: intake records the request with a reference, a status and the DEADLINE the customer was told (asserted against `PRIVACY_DUE_DAYS`); the wording states the export is not produced automatically and that nothing has been deleted; a second request of the same kind returns the SAME open request rather than creating another; the acknowledgement is queued through the outbox; the intake is auditable; cancel works and says nothing was changed; a second customer cannot see or cancel it; every route requires a session. I: the one-open-request-per-kind index and the immutable kind are enforced by the database |
| Browser proof | J phase5.5: a data-export request is submitted and the page states honestly that it is not automatic yet. A: `/account/privacy` at desktop + mobile |
| Limitation | INTAKE ONLY, as the phase description allows: there is no automatic export bundle and no automatic deletion. `due_at` records the 30-day deadline the customer is told; fulfilling the request is a human action until PLT-10/S-11 (Phase 8) builds it. A deletion request never blocks or alters any other behaviour, and `legal_hold` exists so an operator can record why something must be retained. |

## GEN-09 — Customer generation progress / failure / recovery UI

| | |
|---|---|
| Code | `src/account/library.ts` (`requestGenerationForOwnedBook` delegating to the REAL generation service so the durable job is created and dispatched — queuing state alone would be a button that lies; `toMyBookSummary` → `canGenerate`/`blockedReason`), `src/account/pages.ts` (`myPreviewPage`: "Generation progress" with `role="status"`/`aria-live`, the generate/generate-again action, the real per-version scene counts), `src/account/web.ts` (`POST /my/books/:id/generate`), `src/generation/routes.ts` (the unchanged `GET /api/v1/user-books/:id/generation` progress contract) |
| Test proof | RA: re-requesting generation for a book whose current revision already has a job is IDEMPOTENT (200, `jobCreated: false`, no second job, no second preview); a stranger gets 404; the owner's flow generates a real preview through the same service the reader uses. OV: `/api/v1/my/books` reports `canGenerate` and a `blockedReason` derived from persisted state |
| Browser proof | J phase5.7: the customer presses Generate, the preview appears, and its version is approvable |
| Limitation | Progress is server-rendered state plus the existing Phase-3 JSON progress endpoint; there is no push/websocket, so the page must be reloaded (the confirmation says so). The generation cost display is the Phase-3 admin view's; customers see scene progress, not internal cost. |

## GEN-11 — Revision invalidates approval; stale jobs cannot overwrite

| | |
|---|---|
| Code | `src/personalization/user-books.ts` (the new revision + the appended `invalidated` approval row + the version bump are ONE batch; `noteRevisionAfterPreview`), `src/personalization/approvals.ts` (`getActiveApproval`, `buildInvalidateActiveApprovalStmt`), `src/personalization/state-machine.ts` (`buildPreviewReadyStatements`'s revision-scoped CAS — unchanged from Phase 3), `src/account/library.ts` (`requestStructuredRevision` uses `patchPersonalization`, so a replacement photo takes the SAME path) |
| Test proof | RA: appending a revision leaves the previous `personalization_inputs` row byte-for-byte identical; the approval log reads `approved,invalidated`; `getActiveApproval` becomes null and the old version reports `approvalInvalidated: true`, `approved: false`; an approval of a superseded version is refused `stale_preview` even when the approvals row for it still exists (the idempotency short-circuit is conditioned on the version still being CURRENT). Phase-3's stale-job tests remain green unchanged |
| Browser proof | J phase5.7: the customer-visible outcome names the invalidation, and the old version's pages remain in the history |
| Limitation | The approval is invalidated by the EDIT, not by the revision request itself — asking for a change without changing the book leaves the approval active (asserted). This is deliberate: the approval covers a version, and nothing about that version changed yet. |

## PER-08 — Safe edit / resume across refresh, login and cart

| | |
|---|---|
| Code | `src/account/library.ts` (`listMyBooks`/`getMyBookDetail` are owned by the ACCOUNT, not the session), `src/account/web.ts` (`GET /my/books`), `src/account/claims.ts` (the claim is what makes a GUEST book resumable under an account — `user_books.user_id` moves and `prospect_id` is cleared), `src/commerce/cart.ts`/`mergeGuestCartOnLogin` (unchanged), `src/index.tsx` (`/my/books/:slug?userBookId=` resumes from the stored revision) |
| Test proof | OV: the same book with the same revision is returned after a refresh and after a BRAND-NEW login session (the book belongs to the account, not the session); the reader page renders the STORED child name and the book id, and a stranger's render does not contain the book id; a draft survives a reload with its concurrency version intact. GC: the personalised book moves to the account on a verified claim |
| Browser proof | J phase5.3b–5.4: the guest's personalised book is available to the account after the claim, and phase5.9 shows a second account cannot reach it |
| Limitation | The optimistic-concurrency `version` is exposed and enforced on edits; a concurrent edit is reported as a conflict rather than merged. A prospect-owned book that is never claimed expires with the prospect (the pre-existing Phase-2 retention rule, unchanged). |

## PER-09 — Consent version and retention deadline honoured

| | |
|---|---|
| Code | `migrations/0028`–`0032` add no new consent concept: the Phase-3 `consent_versions` + `user_books.consent_version`/`consent_at`/`retention_deadline` are surfaced, not replaced. `src/account/library.ts` (`toMyBookSummary` exposes the deadline and the expiry verdict; `requestStructuredRevision`/`approvalEligibility`/`requestGenerationForOwnedBook` all REFUSE past the deadline), `src/account/pages.ts` (the deadline and consent version are rendered on the preview page) |
| Test proof | RA: the detail reports the retention deadline and the consent version the customer agreed to, and the deadline is in the future; a revision request on an expired book is 409 `book_expired`; the retention deadline is enforced on approval (eligibility) and on generation. (Phase-3's retention tests for the sweep itself remain green.) |
| Browser proof | J phase5.7: the preview page renders the retention information for the claimed book. A: `/my/books` and the customer surfaces at desktop + mobile |
| Limitation | There is still no scheduled retention cron (S-11/PLT-10, Phase 8): the deadline is ENFORCED on every customer action and displayed, but nothing sweeps expired data automatically yet. The consent wording is still the Phase-3 draft pending owner/counsel review (S-14). |

## PLT-05 — Email provider, durable outbox, attempts and templates

| | |
|---|---|
| Code | `migrations/0030_email_outbox_templates.sql` (`email_templates` versioned with one published row per (key, locale); `email_outbox` with a UNIQUE `dedupe_key`, immutable content and a terminal `sent`; `email_attempts` with `UNIQUE(outbox_id, attempt_no)`; 12 seeded published templates), `src/mail/templates.ts` (rendering that FAILS on a missing variable or an unknown key; HTML escaping), `src/mail/provider.ts` (`resolveMailProvider`, `mailProviderStatus`, `HttpEmailAdapter` with an idempotency key and a timeout), `src/mail/outbox.ts` (`enqueueEmail`, `deliverOutboxRow`, `drainEmailOutbox` with leases and backoff, `sendEmailNow`, `outboxCounts`), `src/email.ts` (the unchanged Phase-1 adapter interface, extended with `html`/`idempotencyKey`/an optional name), `src/password-reset.ts` (delivering through the outbox), `src/account/hooks.ts` (order/payment emails), `src/index.tsx` (`GET /api/v1/platform/capabilities`) |
| Test proof | MB: a published template exists for every key the app can enqueue; an unknown key and a missing variable FAIL loudly; substituted values are HTML-escaped in the HTML body; the same `dedupe_key` is ONE row (reported `deduped`); a RETRY after a failure keeps one row, appends one attempt per try and delivers EXACTLY ONE message at the adapter; a terminal failure stops retrying and records the error; the backoff is bounded and deterministic; the database refuses to re-queue a sent mail and refuses to change its content; two workers racing the same attempt number record it once; with NO provider configured the message is queued, recorded `suppressed` with a truthful reason, and nothing is sent (and `fetch` is never called); an incomplete `http` configuration is a truthful misconfiguration rather than a weaker fallback; the console adapter is refused outside explicit development; a test override still wins; the HTTP adapter sends one authenticated request, forwards the idempotency key, reads the message id back and reports a rejection by STATUS only (never echoing the body); the password-reset path writes ONE outbox row and delivers once. I: dedupe uniqueness, content immutability and sent-is-terminal are enforced by the database; the seeded templates are 12 and re-applying the migration does not duplicate them |
| Browser proof | J phase5.0: `/api/v1/platform/capabilities` reports `deliversRealMail: false` with the reason, and no credential-shaped value. J phase5.2: the verification link is read from the DEVELOPMENT CONSOLE adapter's own stdout — the exact place a local developer reads it, with no dev-only HTTP surface |
| Limitation | **NO REAL EMAIL IS SENT, AND NONE WAS SENT WHILE BUILDING THIS.** No provider credential exists in this repository or in CI, `EMAIL_PROVIDER` is unset by default, and a real send would be `EXTERNAL CREDENTIAL REQUIRED`. With delivery disabled every queued message is recorded as `suppressed` rather than pretended to have been sent. The HTTP adapter is production-shaped but has only ever been exercised against an injected fetch stub. A `suppressed` row is not retried later (documented, deliberate: retrying forever against an adapter that cannot deliver is noise), so enabling a provider does not retroactively send suppressed mail. |
