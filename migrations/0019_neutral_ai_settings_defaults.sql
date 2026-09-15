-- Migration 0019: neutralise the brand-derived `ai_settings` defaults (forward-only).
--
-- V2 Phase 1 correction, finding L-D. Migration 0003 seeds the single
-- `ai_settings` row with values built from the previous owner's brand:
--   api_provider = 'wonderwraps'
--   api_endpoint = 'https://api.wonderwraps.com/v1/generate-book'
--   model        = 'wonderwraps-v2'
-- The admin AI-settings page RENDERS those stored values, so the legacy brand
-- stayed visible in administration UI even after every template literal was
-- de-branded. 0003 is published and is never modified, so the correction is
-- applied forward here.
--
-- Only the UNTOUCHED seeded row is rewritten: the WHERE clause demands all
-- three legacy values at once, so an operator who has already configured a
-- provider keeps their configuration. No working endpoint is invented — the
-- replacement is the honest "configure me" state (`custom` + empty endpoint
-- and model), and the page already shows an explicit "not wired up yet" note.
--
-- Idempotent: after the first apply the WHERE clause matches nothing.

UPDATE ai_settings
SET api_provider = 'custom',
    api_endpoint = '',
    model = ''
WHERE id = 1
  AND api_provider = 'wonderwraps'
  AND api_endpoint = 'https://api.wonderwraps.com/v1/generate-book'
  AND model = 'wonderwraps-v2';
