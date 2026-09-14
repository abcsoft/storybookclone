-- Migration 0017: retract the unbacked PDP banner offer (forward-only).
--
-- Truthfulness recovery (V2 Phase 1, T-04/T-05/T-06). Migration 0002 seeded
-- every `pdp_page` row with a banner advertising "Save 20% on 3+ items using
-- code: RATRI20". No discount with that code has ever existed in `discounts`,
-- and 0002 is frozen (0001-0014 are never modified), so the stored default in
-- an already-migrated database has to be corrected forward.
--
-- This migration ONLY rewrites rows that still carry that exact unbacked
-- offer. It invents no replacement offer: it points the banner at the one
-- discount the application itself creates and auto-applies (EXTRA20, seeded
-- by bootstrapLocalDefaults), and clears the fabricated badge. Owner-authored
-- banner text stored by the PDP editor is left untouched.
--
-- Idempotent: re-applying it matches nothing the second time.

UPDATE pdp_page
SET banner_text = 'Order 2+ books and save 20% automatically',
    banner_code = 'EXTRA20'
WHERE banner_code = 'RATRI20'
  AND banner_text LIKE '%RATRI20%';

-- 'SAVE 40%' was a hard-coded badge with no product behind it.
UPDATE pdp_page
SET banner_badge = ''
WHERE banner_badge = 'SAVE 40%';
