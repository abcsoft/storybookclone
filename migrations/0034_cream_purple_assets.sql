-- Migration 0034: Cream-Purple Frontend Asset Mapping
-- Scope: SF-01, SF-02, SF-04, SF-09.
--
-- Maps approved production assets from public/static/assets/ to known seeded
-- catalog products, collections, CMS blocks, and PDP gallery rows.
--
-- INVARIANTS:
-- 1. Updates ONLY known seeded rows where image paths match legacy /static/img/art/...
-- 2. Preserves all operator/admin-modified or uploaded paths (never overwrites).
-- 3. Idempotent: re-running produces zero unwanted mutations or duplicate rows.
-- 4. Safe for both existing databases and fresh installations.

-- 1. Seeded Products (Books)
UPDATE products
   SET image = '/static/assets/books/lantern.webp'
 WHERE slug = 'the-lantern-and-the-long-night'
   AND image = '/static/img/art/cover-the-lantern-and-the-long-night.svg';

UPDATE products
   SET image = '/static/assets/books/moon-garden.webp'
 WHERE slug = 'the-moon-garden'
   AND image = '/static/img/art/cover-the-moon-garden.svg';

UPDATE products
   SET image = '/static/assets/books/snowy-friend.webp'
 WHERE slug = 'the-snow-fox'
   AND image = '/static/img/art/cover-the-snow-fox.svg';

UPDATE products
   SET image = '/static/assets/books/quiet-dream.webp'
 WHERE slug = 'the-quiet-drum'
   AND image = '/static/img/art/cover-the-quiet-drum.svg';

UPDATE products
   SET image = '/static/assets/books/forest.webp'
 WHERE slug = 'the-forest-that-sang'
   AND image = '/static/img/art/cover-the-forest-that-sang.svg';

UPDATE products
   SET image = '/static/assets/books/sunbeam-sea.webp'
 WHERE slug = 'the-puddle-who-met-the-sea'
   AND image = '/static/img/art/cover-the-puddle-who-met-the-sea.svg';

UPDATE products
   SET image = '/static/assets/books/vet.webp'
 WHERE slug = 'the-kind-vet'
   AND image = '/static/img/art/cover-the-kind-vet.svg';

UPDATE products
   SET image = '/static/assets/books/firefighter.webp'
 WHERE slug = 'the-little-fire-crew'
   AND image = '/static/img/art/cover-the-little-fire-crew.svg';

UPDATE products
   SET image = '/static/assets/books/pilot.webp'
 WHERE slug = 'up-in-the-clouds'
   AND image = '/static/img/art/cover-up-in-the-clouds.svg';

UPDATE products
   SET image = '/static/assets/books/chef.webp'
 WHERE slug = 'the-brave-little-baker'
   AND image = '/static/img/art/cover-the-brave-little-baker.svg';

-- 2. Collections (Categories & Themes)
UPDATE collections
   SET hero_image = '/static/assets/categories/adventure.webp'
 WHERE slug = 'adventure-and-discovery'
   AND hero_image = '/static/img/art/cover-the-little-explorer.svg';

UPDATE collections
   SET hero_image = '/static/assets/categories/bedtime.webp'
 WHERE slug = 'bedtime-and-calm'
   AND hero_image = '/static/img/art/cover-the-lantern-and-the-long-night.svg';

UPDATE collections
   SET hero_image = '/static/assets/categories/animals.webp'
 WHERE slug = 'animals-and-nature'
   AND hero_image = '/static/img/art/cover-the-snow-fox.svg';

UPDATE collections
   SET hero_image = '/static/assets/categories/friendship.webp'
 WHERE slug = 'kindness-and-feelings'
   AND hero_image = '/static/img/art/cover-the-forest-that-sang.svg';

UPDATE collections
   SET hero_image = '/static/assets/extras/sticker-pack.webp'
 WHERE slug = 'all-stickers'
   AND hero_image = '/static/img/art/stickers-header.svg';

UPDATE collections
   SET hero_image = '/static/assets/extras/sticker-pack.webp'
 WHERE slug = 'sticker-packs'
   AND hero_image = '/static/img/art/cover-meadow-sticker-sheet.svg';

-- 3. CMS Blocks (Homepage)
UPDATE cms_blocks
   SET image_path = '/static/assets/hero/open-book-boy.webp',
       image_alt = 'Illustrated child and dog reading a magical glowing storybook'
 WHERE key = 'home.hero'
   AND image_path = '/static/img/art/hero.svg';

UPDATE cms_blocks
   SET image_path = '/static/assets/extras/sticker-pack.webp',
       image_alt = 'Personalised illustrated sticker sheet'
 WHERE key = 'home.stickers'
   AND image_path = '/static/img/art/stickers-header.svg';

UPDATE cms_blocks
   SET image_path = '/static/assets/features/open-book-girl.webp',
       image_alt = 'Child reading personalised storybook with magical glow'
 WHERE key = 'home.cta'
   AND image_path = '/static/img/art/cta-reading.svg';

-- 4. Media Assets Registration
INSERT OR IGNORE INTO media_assets (public_path, alt_text, width, height, mime_type, source) VALUES
  ('/static/assets/hero/open-book-boy.webp', 'Illustrated child and dog reading a magical glowing storybook', 399, 258, 'image/webp', 'generated'),
  ('/static/assets/features/open-book-girl.webp', 'Child reading personalised storybook with magical glow', 341, 206, 'image/webp', 'generated'),
  ('/static/assets/extras/sticker-pack.webp', 'Personalised illustrated sticker sheet', 600, 600, 'image/webp', 'generated'),
  ('/static/assets/categories/adventure.webp', 'Adventure and discovery books category banner', 600, 400, 'image/webp', 'generated'),
  ('/static/assets/categories/bedtime.webp', 'Bedtime and calm books category banner', 600, 400, 'image/webp', 'generated'),
  ('/static/assets/categories/animals.webp', 'Animals and nature books category banner', 600, 400, 'image/webp', 'generated'),
  ('/static/assets/categories/friendship.webp', 'Friendship and feelings books category banner', 600, 400, 'image/webp', 'generated'),
  ('/static/assets/books/lantern.webp', 'Cover illustration for The Lantern and the Long Night', 600, 600, 'image/webp', 'generated'),
  ('/static/assets/books/moon-garden.webp', 'Cover illustration for The Moon Garden', 600, 600, 'image/webp', 'generated'),
  ('/static/assets/books/snowy-friend.webp', 'Cover illustration for The Snow Fox', 600, 600, 'image/webp', 'generated'),
  ('/static/assets/books/quiet-dream.webp', 'Cover illustration for The Quiet Drum', 600, 600, 'image/webp', 'generated'),
  ('/static/assets/books/forest.webp', 'Cover illustration for The Forest That Sang', 600, 600, 'image/webp', 'generated'),
  ('/static/assets/books/sunbeam-sea.webp', 'Cover illustration for The Puddle Who Met the Sea', 600, 600, 'image/webp', 'generated'),
  ('/static/assets/books/vet.webp', 'Cover illustration for The Kind Vet', 600, 600, 'image/webp', 'generated'),
  ('/static/assets/books/firefighter.webp', 'Cover illustration for The Little Fire Crew', 600, 600, 'image/webp', 'generated'),
  ('/static/assets/books/pilot.webp', 'Cover illustration for Up in the Clouds', 600, 600, 'image/webp', 'generated'),
  ('/static/assets/books/chef.webp', 'Cover illustration for The Brave Little Baker', 600, 600, 'image/webp', 'generated'),
  ('/static/assets/product/lantern-cover.webp', 'Cover of The Lantern and the Long Night', 600, 600, 'image/webp', 'generated'),
  ('/static/assets/product/open-book-feature.webp', 'Open book spread from The Lantern and the Long Night', 600, 400, 'image/webp', 'generated'),
  ('/static/assets/product/gallery-01.webp', 'Inside page detail: glowing lantern in snow', 600, 400, 'image/webp', 'generated'),
  ('/static/assets/product/gallery-02.webp', 'Inside page detail: lantern across village path', 600, 400, 'image/webp', 'generated'),
  ('/static/assets/product/gallery-03.webp', 'Inside page detail: morning dawn over the mountain', 600, 400, 'image/webp', 'generated');

-- 5. PDP Gallery for The Lantern and the Long Night
-- Upgrade known legacy generated SVG gallery items (if and only if the gallery contains solely legacy SVGs)
DELETE FROM pdp_gallery
 WHERE product_id = (SELECT id FROM products WHERE slug = 'the-lantern-and-the-long-night')
   AND image_url IN ('/static/img/art/cover-the-lantern-and-the-long-night.svg', '/static/img/art/hero.svg')
   AND NOT EXISTS (
     SELECT 1 FROM pdp_gallery pg
      WHERE pg.product_id = (SELECT id FROM products WHERE slug = 'the-lantern-and-the-long-night')
        AND pg.image_url NOT IN ('/static/img/art/cover-the-lantern-and-the-long-night.svg', '/static/img/art/hero.svg')
   );

-- Install approved Lantern gallery ONLY when the gallery is currently empty (untouched seed or after legacy upgrade).
-- If an administrator has customized or deleted items, preserve their choices and never append.
INSERT INTO pdp_gallery (product_id, image_url, alt, sort_order, active)
SELECT p.id, v.image_url, v.alt, v.sort_order, 1
  FROM products p
  JOIN (
    SELECT '/static/assets/product/lantern-cover.webp' AS image_url, 'Cover of The Lantern and the Long Night' AS alt, 1 AS sort_order
    UNION ALL SELECT '/static/assets/product/open-book-feature.webp', 'Open book spread with glowing lantern', 2
    UNION ALL SELECT '/static/assets/product/gallery-01.webp', 'Inside page detail showing lantern light', 3
    UNION ALL SELECT '/static/assets/product/gallery-02.webp', 'Inside page detail showing the snowy path', 4
    UNION ALL SELECT '/static/assets/product/gallery-03.webp', 'Inside page detail showing sunrise over the hills', 5
  ) v
 WHERE p.slug = 'the-lantern-and-the-long-night'
   AND NOT EXISTS (
     SELECT 1 FROM pdp_gallery pg WHERE pg.product_id = p.id
   );

-- 6. Product Media associations
UPDATE product_media
   SET media_id = (SELECT id FROM media_assets WHERE public_path = '/static/assets/books/lantern.webp')
 WHERE product_id = (SELECT id FROM products WHERE slug = 'the-lantern-and-the-long-night')
   AND role = 'cover'
   AND media_id = (SELECT id FROM media_assets WHERE public_path = '/static/img/art/cover-the-lantern-and-the-long-night.svg');

INSERT OR IGNORE INTO product_media (product_id, media_id, role, sort_order)
SELECT p.id, (SELECT id FROM media_assets WHERE public_path = '/static/assets/books/lantern.webp'), 'cover', 0
  FROM products p
 WHERE p.slug = 'the-lantern-and-the-long-night';

-- Install approved gallery items ONLY if product_media has no existing gallery rows for this product,
-- ensuring administrator-customized gallery associations are never overwritten or appended to.
INSERT OR IGNORE INTO product_media (product_id, media_id, role, sort_order)
SELECT p.id, m.id, 'gallery', v.sort_order
  FROM products p
  JOIN (
    SELECT '/static/assets/product/open-book-feature.webp' AS public_path, 1 AS sort_order
    UNION ALL SELECT '/static/assets/product/gallery-01.webp', 2
    UNION ALL SELECT '/static/assets/product/gallery-02.webp', 3
    UNION ALL SELECT '/static/assets/product/gallery-03.webp', 4
  ) v
  JOIN media_assets m ON m.public_path = v.public_path
 WHERE p.slug = 'the-lantern-and-the-long-night'
   AND NOT EXISTS (
     SELECT 1 FROM product_media pm WHERE pm.product_id = p.id AND pm.role = 'gallery'
   );
