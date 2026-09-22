-- Forward migration to repair product_media roles for databases where 0034 was already applied.
-- In 0034, invalid roles ('spread', 'detail') were silently ignored by SQLite due to INSERT OR IGNORE.
-- This forward migration safely ensures that any already-migrated database receives the valid 'gallery'
-- roles while preserving any administrator-customized galleries.

UPDATE product_media
   SET media_id = (SELECT id FROM media_assets WHERE public_path = '/static/assets/books/lantern.webp')
 WHERE product_id = (SELECT id FROM products WHERE slug = 'the-lantern-and-the-long-night')
   AND role = 'cover'
   AND media_id = (SELECT id FROM media_assets WHERE public_path = '/static/img/art/cover-the-lantern-and-the-long-night.svg');

INSERT OR IGNORE INTO product_media (product_id, media_id, role, sort_order)
SELECT p.id, (SELECT id FROM media_assets WHERE public_path = '/static/assets/books/lantern.webp'), 'cover', 0
  FROM products p
 WHERE p.slug = 'the-lantern-and-the-long-night';

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
