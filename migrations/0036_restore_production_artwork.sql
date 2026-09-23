-- Migration 0036: Restore Authoritative High-Resolution Product Artwork
-- Scope: SF-01, SF-02, Visual Fidelity Correction.
--
-- Restores the authoritative, coherent vector illustrations (public/static/img/art/)
-- for seeded catalogue products and collections that were temporarily pointed at
-- tiny reference crops in migration 0034.
--
-- INVARIANTS:
-- 1. Updates ONLY known rows where image paths match the 0034 reference thumbnails.
-- 2. Preserves all operator/admin-modified or uploaded paths (never overwrites).
-- 3. Idempotent: re-running produces zero unwanted mutations or duplicate rows.
-- 4. Safe for both existing databases and fresh installations.

-- 1. Ensure high-resolution SVG media assets are registered
INSERT OR IGNORE INTO media_assets (public_path, alt_text, width, height, mime_type, source) VALUES
  ('/static/img/art/cover-the-lantern-and-the-long-night.svg', 'Illustrated cover for The Lantern and the Long Night', 600, 600, 'image/svg+xml', 'generated'),
  ('/static/img/art/cover-the-moon-garden.svg', 'Illustrated cover for The Moon Garden', 600, 600, 'image/svg+xml', 'generated'),
  ('/static/img/art/cover-the-snow-fox.svg', 'Illustrated cover for The Snow Fox', 600, 600, 'image/svg+xml', 'generated'),
  ('/static/img/art/cover-the-quiet-drum.svg', 'Illustrated cover for The Quiet Drum', 600, 600, 'image/svg+xml', 'generated'),
  ('/static/img/art/cover-the-forest-that-sang.svg', 'Illustrated cover for The Forest That Sang', 600, 600, 'image/svg+xml', 'generated'),
  ('/static/img/art/cover-the-puddle-who-met-the-sea.svg', 'Illustrated cover for The Puddle Who Met the Sea', 600, 600, 'image/svg+xml', 'generated'),
  ('/static/img/art/cover-the-kind-vet.svg', 'Illustrated cover for The Kind Vet', 600, 600, 'image/svg+xml', 'generated'),
  ('/static/img/art/cover-the-little-fire-crew.svg', 'Illustrated cover for The Little Fire Crew', 600, 600, 'image/svg+xml', 'generated'),
  ('/static/img/art/cover-up-in-the-clouds.svg', 'Illustrated cover for Up in the Clouds', 600, 600, 'image/svg+xml', 'generated'),
  ('/static/img/art/cover-the-brave-little-baker.svg', 'Illustrated cover for The Brave Little Baker', 600, 600, 'image/svg+xml', 'generated'),
  ('/static/img/art/cover-the-little-explorer.svg', 'Illustrated forest with a kite in the sky', 600, 600, 'image/svg+xml', 'generated'),
  ('/static/img/art/stickers-header.svg', 'Illustrated sticker sheet with abstract shapes', 960, 540, 'image/svg+xml', 'generated'),
  ('/static/img/art/cover-meadow-sticker-sheet.svg', 'Illustrated sticker sheet with green shapes', 600, 600, 'image/svg+xml', 'generated');

-- 2. Restore Products to Authoritative Vector Covers
UPDATE products
   SET image = '/static/img/art/cover-the-lantern-and-the-long-night.svg'
 WHERE slug = 'the-lantern-and-the-long-night'
   AND image = '/static/assets/books/lantern.webp';

UPDATE products
   SET image = '/static/img/art/cover-the-moon-garden.svg'
 WHERE slug = 'the-moon-garden'
   AND image = '/static/assets/books/moon-garden.webp';

UPDATE products
   SET image = '/static/img/art/cover-the-snow-fox.svg'
 WHERE slug = 'the-snow-fox'
   AND image = '/static/assets/books/snowy-friend.webp';

UPDATE products
   SET image = '/static/img/art/cover-the-quiet-drum.svg'
 WHERE slug = 'the-quiet-drum'
   AND image = '/static/assets/books/quiet-dream.webp';

UPDATE products
   SET image = '/static/img/art/cover-the-forest-that-sang.svg'
 WHERE slug = 'the-forest-that-sang'
   AND image = '/static/assets/books/forest.webp';

UPDATE products
   SET image = '/static/img/art/cover-the-puddle-who-met-the-sea.svg'
 WHERE slug = 'the-puddle-who-met-the-sea'
   AND image = '/static/assets/books/sunbeam-sea.webp';

UPDATE products
   SET image = '/static/img/art/cover-the-kind-vet.svg'
 WHERE slug = 'the-kind-vet'
   AND image = '/static/assets/books/vet.webp';

UPDATE products
   SET image = '/static/img/art/cover-the-little-fire-crew.svg'
 WHERE slug = 'the-little-fire-crew'
   AND image = '/static/assets/books/firefighter.webp';

UPDATE products
   SET image = '/static/img/art/cover-up-in-the-clouds.svg'
 WHERE slug = 'up-in-the-clouds'
   AND image = '/static/assets/books/pilot.webp';

UPDATE products
   SET image = '/static/img/art/cover-the-brave-little-baker.svg'
 WHERE slug = 'the-brave-little-baker'
   AND image = '/static/assets/books/chef.webp';

-- 3. Restore Collections to Authoritative Vector Artwork
UPDATE collections
   SET hero_image = '/static/img/art/cover-the-little-explorer.svg'
 WHERE slug = 'adventure-and-discovery'
   AND hero_image = '/static/assets/categories/adventure.webp';

UPDATE collections
   SET hero_image = '/static/img/art/cover-the-lantern-and-the-long-night.svg'
 WHERE slug = 'bedtime-and-calm'
   AND hero_image = '/static/assets/categories/bedtime.webp';

UPDATE collections
   SET hero_image = '/static/img/art/cover-the-snow-fox.svg'
 WHERE slug = 'animals-and-nature'
   AND hero_image = '/static/assets/categories/animals.webp';

UPDATE collections
   SET hero_image = '/static/img/art/cover-the-forest-that-sang.svg'
 WHERE slug = 'kindness-and-feelings'
   AND hero_image = '/static/assets/categories/friendship.webp';

UPDATE collections
   SET hero_image = '/static/img/art/stickers-header.svg'
 WHERE slug = 'all-stickers'
   AND hero_image = '/static/assets/extras/sticker-pack.webp';

UPDATE collections
   SET hero_image = '/static/img/art/cover-meadow-sticker-sheet.svg'
 WHERE slug = 'sticker-packs'
   AND hero_image = '/static/assets/extras/sticker-pack.webp';

-- 4. Restore Product Media Cover Association for Lantern
UPDATE product_media
   SET media_id = (SELECT id FROM media_assets WHERE public_path = '/static/img/art/cover-the-lantern-and-the-long-night.svg')
 WHERE product_id = (SELECT id FROM products WHERE slug = 'the-lantern-and-the-long-night')
   AND role = 'cover'
   AND media_id = (SELECT id FROM media_assets WHERE public_path = '/static/assets/books/lantern.webp');
