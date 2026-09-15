-- V2 Phase 5 — durable email outbox, provider attempts and versioned templates
-- (PLT-05). Forward-only; 0001-0027 stay byte-identical.
--
-- WHY AN OUTBOX AND NOT A DIRECT SEND. A transaction that has already committed
-- ("your order is placed", "your email address changed") must not be undone
-- because an email provider was briefly unreachable, and an email must not be
-- sent twice because a Worker was restarted between "sent" and "recorded". So
-- the DECISION to send is a committed row, delivery is a separate, retryable
-- step, and `dedupe_key` is the single authority on "this is one logical mail".
--
-- WHAT THIS BUILD ACTUALLY DOES: no email provider is configured by default, so
-- delivery is DISABLED and every queued row is marked `suppressed` with a
-- truthful reason instead of pretending to have been sent. The adapter for a
-- real provider exists and is production-shaped (see src/mail/provider.ts), but
-- no credential exists in this repository and no real send is ever made.

-- ---------------------------------------------------------------------------
-- email_templates — versioned, locale-aware wording
-- ---------------------------------------------------------------------------
-- Versioned like prompt/consent versions elsewhere in this repository: changing
-- wording publishes a NEW row rather than editing the text a customer already
-- received a copy of. Exactly one published row per (key, locale).
CREATE TABLE IF NOT EXISTS email_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (key, version, locale)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_templates_one_published ON email_templates(key, locale) WHERE status = 'published';

-- The identity of a template version can never be edited (same rule as
-- consent_versions and prompt_versions).
CREATE TRIGGER IF NOT EXISTS trg_email_templates_identity_immutable
BEFORE UPDATE OF key, version, locale ON email_templates
BEGIN
  SELECT RAISE(ABORT, 'email template identity is immutable');
END;

-- ---------------------------------------------------------------------------
-- email_outbox — the durable decision to send ONE logical mail
-- ---------------------------------------------------------------------------
-- `dedupe_key` is UNIQUE and is the ONLY authority on logical identity: a retry
-- updates this row (attempt_count+1, a new email_attempts row) and never
-- inserts a second one, so a retried send can never deliver two copies.
CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  dedupe_key TEXT NOT NULL UNIQUE,
  template_key TEXT NOT NULL,
  template_version INTEGER,
  to_email TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT,
  variables_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(variables_json)),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  provider TEXT,
  provider_message_id TEXT,
  -- Truthful reason a row will never be delivered (e.g.
  -- 'no_provider_configured'), never a credential.
  suppressed_reason TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  correlation_id TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME
);
-- The retry sweep's access path: due, still-deliverable rows.
CREATE INDEX IF NOT EXISTS idx_email_outbox_due ON email_outbox(status, available_at) WHERE status IN ('queued', 'sending');
CREATE INDEX IF NOT EXISTS idx_email_outbox_user ON email_outbox(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_outbox_template ON email_outbox(template_key, id DESC);

-- A retry may change delivery state ONLY. Recipient, subject, body and template
-- are frozen at enqueue time: no failure path may quietly send different
-- content under the same logical id.
CREATE TRIGGER IF NOT EXISTS trg_email_outbox_content_immutable
BEFORE UPDATE OF dedupe_key, template_key, to_email, subject, body_text, body_html ON email_outbox
BEGIN
  SELECT RAISE(ABORT, 'queued email content is immutable');
END;

-- Terminal states are terminal. Without this, an 'sent' row could be re-queued
-- and delivered a second time — the exact duplication dedupe_key exists to
-- prevent.
CREATE TRIGGER IF NOT EXISTS trg_email_outbox_sent_terminal
BEFORE UPDATE ON email_outbox
WHEN OLD.status = 'sent' AND NEW.status IN ('queued', 'sending')
BEGIN
  SELECT RAISE(ABORT, 'a sent email cannot be re-queued');
END;

-- ---------------------------------------------------------------------------
-- email_attempts — one row per real delivery attempt
-- ---------------------------------------------------------------------------
-- UNIQUE(outbox_id, attempt_no) is what makes a crashed/duplicated worker safe:
-- the loser of a race on the same attempt number fails the INSERT instead of
-- recording (and performing) a second delivery.
CREATE TABLE IF NOT EXISTS email_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER NOT NULL REFERENCES email_outbox(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed', 'suppressed')),
  provider TEXT,
  provider_message_id TEXT,
  error_code TEXT,
  error_message TEXT,
  latency_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (outbox_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_email_attempts_outbox ON email_attempts(outbox_id, id);

CREATE TRIGGER IF NOT EXISTS trg_email_attempts_no_update
BEFORE UPDATE ON email_attempts
BEGIN
  SELECT RAISE(ABORT, 'email delivery attempts are append-only');
END;

-- ---------------------------------------------------------------------------
-- Seeded published templates
-- ---------------------------------------------------------------------------
-- INSERT OR IGNORE keeps this repeatable. A template may be missing (an
-- operator retired it); src/mail/templates.ts then falls back to the in-code
-- default for that key and records which one was used, so a missing row can
-- never turn into a silent empty email.

-- 1. Verify the account email (CUS-01)
INSERT OR IGNORE INTO email_templates (key, version, locale, subject, body_text, body_html, status) VALUES
  ('verify_email', 1, 'en', 'Confirm your {{brandName}} email address',
   'Hello {{name}},

Please confirm this email address for your {{brandName}} account:

{{actionUrl}}

This link expires in {{expiresMinutes}} minutes and can only be used once. If you did not create an account, you can ignore this email.',
   '<p>Hello {{name}},</p><p>Please confirm this email address for your {{brandName}} account:</p><p><a href="{{actionUrl}}">Confirm my email address</a></p><p>This link expires in {{expiresMinutes}} minutes and can only be used once. If you did not create an account, you can ignore this email.</p>',
   'published'),
-- 2. Confirm a change of email address (CUS-01/CUS-03)
  ('change_email', 1, 'en', 'Confirm your new {{brandName}} email address',
   'Hello {{name}},

Confirm {{newEmail}} as the new email address for your {{brandName}} account:

{{actionUrl}}

Until you confirm, your account keeps using {{currentEmail}}. This link expires in {{expiresMinutes}} minutes and can only be used once.',
   '<p>Hello {{name}},</p><p>Confirm <strong>{{newEmail}}</strong> as the new email address for your {{brandName}} account:</p><p><a href="{{actionUrl}}">Confirm the new address</a></p><p>Until you confirm, your account keeps using {{currentEmail}}. This link expires in {{expiresMinutes}} minutes and can only be used once.</p>',
   'published'),
-- 3. Password reset (CUS-01) — the wording src/password-reset.ts has always sent
  ('password_reset', 1, 'en', 'Reset your {{brandName}} password',
   'Reset your password: {{actionUrl}}
This link expires in {{expiresMinutes}} minutes and can only be used once. If you didn''t request this, you can ignore this email.',
   NULL,
   'published'),
-- 4. Security notification (CUS-02)
  ('security_alert', 1, 'en', '{{brandName}} account security notice: {{eventTitle}}',
   'Hello {{name}},

{{eventSummary}}

When: {{occurredAt}} (UTC)
{{contextLine}}

If this was not you, change your password immediately and sign out of all sessions from your account page. This message is sent for every account-safety event and cannot be turned off.',
   '<p>Hello {{name}},</p><p>{{eventSummary}}</p><p>When: {{occurredAt}} (UTC)<br>{{contextLine}}</p><p>If this was not you, change your password immediately and sign out of all sessions from your account page. This message is sent for every account-safety event and cannot be turned off.</p>',
   'published'),
-- 5. Order confirmation (CUS-05/CUS-10)
  ('order_confirmation', 1, 'en', 'Order {{orderNumber}} received',
   'Hello {{name}},

We have recorded order {{orderNumber}} for {{itemCount}} item(s), total {{orderTotal}}.

{{paymentLine}}

You can see the full order, its receipt and its progress at any time:
{{orderUrl}}
{{claimLine}}',
   NULL,
   'published'),
-- 6. Payment captured (COM-08/CUS-10)
  ('order_paid', 1, 'en', 'Payment received for order {{orderNumber}}',
   'Hello {{name}},

Payment of {{amountPaid}} for order {{orderNumber}} has been received and recorded.

Order and receipt: {{orderUrl}}',
   NULL,
   'published'),
-- 7. Preview ready (GEN-09/CUS-07)
  ('generation_ready', 1, 'en', 'Your preview for {{bookTitle}} is ready',
   'Hello {{name}},

The preview for "{{bookTitle}}" (version {{previewVersion}}) is ready to look at:

{{previewUrl}}

You can approve this exact version, or ask for a change. Approving is what releases the book for production.',
   NULL,
   'published'),
-- 8. Revision request acknowledged (CUS-08)
  ('revision_ack', 1, 'en', 'We have your change request for {{bookTitle}}',
   'Hello {{name}},

We have recorded your change request for "{{bookTitle}}" (version {{previewVersion}}):

Reason: {{reasonLabel}}
{{notesLine}}

{{replacementPhotoLine}}

Any previous approval for this book has been invalidated, because the book has changed since it was approved. We will email you again when a new preview is ready.',
   NULL,
   'published'),
-- 9. Download entitlement (CUS-11)
  ('download_ready', 1, 'en', 'Your download for order {{orderNumber}} is ready',
   'Hello {{name}},

Your entitled download for "{{itemTitle}}" is available:

{{downloadUrl}}

Sign in to your account to download it. Downloads are time-limited and each one is recorded against your order — there is no permanent public link.',
   NULL,
   'published'),
-- 10. Guest order claimed (CUS-04)
  ('guest_claim', 1, 'en', 'Confirm the order you want to add to your account',
   'Hello,

Someone asked to add the order(s) placed with this email address to their {{brandName}} account. Confirm that request here:

{{actionUrl}}

This link expires in {{expiresMinutes}} minutes and can only be used once. The order is only moved after this confirmation — knowing an email address by itself can never claim an order. If this was not you, ignore this email and nothing happens.',
   NULL,
   'published'),
-- 11. Privacy request received (CUS-14)
  ('privacy_request', 1, 'en', 'We have received your {{requestKind}} request',
   'Hello {{name}},

We have recorded your data {{requestKind}} request (reference {{reference}}) on {{receivedAt}} (UTC).

{{expectationLine}}

This message confirms receipt only. It is not a claim that the request has already been actioned.',
   NULL,
   'published'),
-- 12. Support reply / receipt (CUS-12)
  ('support_reply', 1, 'en', 'Reply on your support ticket {{ticketNumber}}',
   'Hello {{name}},

There is a new message on support ticket {{ticketNumber}}: "{{subject}}".

{{replyLine}}

Read and reply: {{ticketUrl}}',
   NULL,
   'published');
