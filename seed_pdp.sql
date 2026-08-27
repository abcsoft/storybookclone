-- Seed product-detail-page content for the sticker pack.
-- (Other products only render the default product page; admins can enable this.)

-- ============== girls-sticker-pack ==============
INSERT OR IGNORE INTO pdp_page (product_id, banner_text, banner_code, banner_badge, preorder_note)
SELECT id, 'Save 20% on 3+ items using code: RATRI20', 'RATRI20', 'SAVE 40%', '' FROM products WHERE slug='girls-sticker-pack';

INSERT OR IGNORE INTO pdp_gallery (product_id, image_url, alt, sort_order, active)
SELECT id, '/static/img/stickers/sg-1.webp', 'Peeling a personalised sticker from the sheet', 1, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_gallery (product_id, image_url, alt, sort_order, active)
SELECT id, '/static/img/stickers/sg-2.webp', 'Sticker sheet with unicorn and rainbow designs', 2, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_gallery (product_id, image_url, alt, sort_order, active)
SELECT id, '/static/img/stickers/sg-3.webp', 'Sticker sheet with mermaid-themed illustrations', 3, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_gallery (product_id, image_url, alt, sort_order, active)
SELECT id, '/static/img/stickers/sg-4.webp', 'Sticker sheet with wizard and superhero designs', 4, 1 FROM products WHERE slug='girls-sticker-pack';

INSERT OR IGNORE INTO pdp_accordions (product_id, title, body, sort_order, active)
SELECT id, 'How is the book personalized for my child?', 'Creating her personalised pack is quick: upload a clear front-facing photo, enter her name and age, then choose the sticker styles. Our artists use the photo to place her face across every sticker sheet — unicorns, mermaids, wizards, superheroes — so she is the hero of the pack.', 1, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_accordions (product_id, title, body, sort_order, active)
SELECT id, 'What if I need to make changes after personalizing?', 'No problem. After you place your order we send a preview link. You can request free revisions to the layout, style or photo placement before we send the pack to print. Our support team replies within one business day.', 2, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_accordions (product_id, title, body, sort_order, active)
SELECT id, 'Size & Quality', 'Each pack includes 6 glossy vinyl sheets (40+ stickers total), printed on premium self-adhesive vinyl. Sticker size: 1.5–3 inches. Water-resistant and scratch-free — built for kid hands and backpacks.', 3, 1 FROM products WHERE slug='girls-sticker-pack';

INSERT OR IGNORE INTO pdp_steps (product_id, step_no, title, body)
SELECT id, 1, 'Upload Child''s Photo', 'Pick a clear, front-facing photo showing her face. A bright, well-lit picture works best.' FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_steps (product_id, step_no, title, body)
SELECT id, 2, 'Choose Sticker Pack style', 'Pick her favourite style — unicorn, mermaid, wizard, superhero and more.' FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_steps (product_id, step_no, title, body)
SELECT id, 3, 'Preview & Add to Cart', 'Review each sheet, request tweaks, and checkout securely when she loves it.' FROM products WHERE slug='girls-sticker-pack';

INSERT OR IGNORE INTO pdp_photo_tips (product_id, kind, label, image_url, sort_order)
SELECT id, 'bad', 'Blurry photo',  '/static/img/tips/blurry.svg',  1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_photo_tips (product_id, kind, label, image_url, sort_order)
SELECT id, 'bad', 'Bad angle',    '/static/img/tips/angle.svg',   2 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_photo_tips (product_id, kind, label, image_url, sort_order)
SELECT id, 'bad', 'Harsh shadow', '/static/img/tips/shadow.svg', 3 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_photo_tips (product_id, kind, label, image_url, sort_order)
SELECT id, 'good', 'Clear front face',     '/static/img/tips/good-1.svg', 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_photo_tips (product_id, kind, label, image_url, sort_order)
SELECT id, 'good', 'Bright natural light', '/static/img/tips/good-2.svg', 2 FROM products WHERE slug='girls-sticker-pack';

INSERT OR IGNORE INTO pdp_magic (product_id, heading, left_image, left_caption, right_image, right_caption, body)
SELECT id,
  'See How a Simple Photo Becomes a Beautiful Story',
  '/static/img/magic/before.webp', 'Your real photo',
  '/static/img/magic/after.webp',  'Personalised illustrated version',
  'From a single photo, our artists craft her very own illustrated persona that appears on every sticker.'
FROM products WHERE slug='girls-sticker-pack';

INSERT OR IGNORE INTO pdp_trust (product_id, title, body, icon, sort_order)
SELECT id, 'Years of Experience in Personalized Books', 'A team of illustrators and storytellers dedicated to crafting personalised keepsakes one child at a time.', 'sparkle',   1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_trust (product_id, title, body, icon, sort_order)
SELECT id, 'Thousands of Happy Stories Families Worldwide', 'Over 100K families in 200+ countries have celebrated bedtime, birthdays and big days with WonderWraps.',    'globe',   2 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_trust (product_id, title, body, icon, sort_order)
SELECT id, 'Highest Personalization Standards', 'Multiple artistic checks, secure uploads, and obsessive attention to detail on every page and sticker.',          'shield', 3 FROM products WHERE slug='girls-sticker-pack';

INSERT OR IGNORE INTO pdp_reactions (product_id, name, rating, review, image_url, sort_order, active)
SELECT id, 'Sarah K.',       5, 'My 6-year-old absolutely loves her stickers. She peels them onto everything — perfectly personalised.', '/static/img/reviews/r-1.webp', 1, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_reactions (product_id, name, rating, review, image_url, sort_order, active)
SELECT id, 'Maria L.',      5, 'The face match is amazing. She gasped when she saw herself as a mermaid.',                            '/static/img/reviews/r-2.webp', 2, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_reactions (product_id, name, rating, review, image_url, sort_order, active)
SELECT id, 'Jessica P.',    5, 'Stickers are sturdy and beautifully printed. Perfect for our party bags too.',                         '/static/img/reviews/r-3.webp', 3, 1 FROM products WHERE slug='girls-sticker-pack';

INSERT OR IGNORE INTO pdp_media (product_id, name, image_url, href, sort_order)
SELECT id, 'NBC',                  '/static/img/media/nbc.svg',           '#', 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_media (product_id, name, image_url, href, sort_order)
SELECT id, 'ABC News',             '/static/img/media/abc.svg',           '#', 2 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_media (product_id, name, image_url, href, sort_order)
SELECT id, 'FOX News',             '/static/img/media/fox.svg',           '#', 3 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_media (product_id, name, image_url, href, sort_order)
SELECT id, 'AP',                   '/static/img/media/ap.svg',            '#', 4 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_media (product_id, name, image_url, href, sort_order)
SELECT id, 'Sports Illustrated',   '/static/img/media/si.svg',            '#', 5 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_media (product_id, name, image_url, href, sort_order)
SELECT id, 'International Business Times', '/static/img/media/ibt.svg',  '#', 6 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_media (product_id, name, image_url, href, sort_order)
SELECT id, 'Morning News',         '/static/img/media/morning.svg',      '#', 7 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_media (product_id, name, image_url, href, sort_order)
SELECT id, 'CBS',                  '/static/img/media/cbs.svg',           '#', 8 FROM products WHERE slug='girls-sticker-pack';

-- "You may also like" — pick 3 books of the same category by default
INSERT OR IGNORE INTO pdp_related (product_id, related_id, sort_order)
SELECT a.id, b.id, 1 FROM products a, products b
WHERE a.slug='girls-sticker-pack' AND b.slug='girl-explores-the-zoo';
INSERT OR IGNORE INTO pdp_related (product_id, related_id, sort_order)
SELECT a.id, b.id, 2 FROM products a, products b
WHERE a.slug='girls-sticker-pack' AND b.slug='princess-girl-the-one-we-all-needed';
INSERT OR IGNORE INTO pdp_related (product_id, related_id, sort_order)
SELECT a.id, b.id, 3 FROM products a, products b
WHERE a.slug='girls-sticker-pack' AND b.slug='happy-birthday-girl';

INSERT OR IGNORE INTO pdp_faqs (product_id, question, answer, sort_order, active)
SELECT id, 'How do I place an order?',
  'It''s easy! Choose the sticker pack you want personalised, upload a photo of your child (make sure it matches our recommendations), and enter their name and age. You''ll then get a preview of the pack. If you''re happy with it, just proceed to payment to complete your order.',
  1, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_faqs (product_id, question, answer, sort_order, active)
SELECT id, 'Do you ship to my location?',
  'Yes! We ship to over 200 countries and regions, so wherever you are, we''ll make sure your order reaches you.',
  2, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_faqs (product_id, question, answer, sort_order, active)
SELECT id, 'Can I get a refund for my order?',
  'You can receive a full refund if your book hasn''t been printed yet, or a partial refund if it has been printed but not yet shipped. Once printed and shipped, we''re unable to offer a refund. To request a refund contact us through our support page or by email at support@wonderwraps.com.',
  3, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_faqs (product_id, question, answer, sort_order, active)
SELECT id, 'How long does shipping take?',
  'Shipping times depend on the shipping method you choose at checkout. Standard shipping usually takes 10 to 30 business days, while express shipping typically arrives within 7 to 20 business days.',
  4, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_faqs (product_id, question, answer, sort_order, active)
SELECT id, 'Will I have to pay duties or sales tax?',
  'The prices listed on our website do not include any additional taxes, customs duties, or import fees. These charges may apply depending on your country''s regulations and are the responsibility of the recipient.',
  5, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_faqs (product_id, question, answer, sort_order, active)
SELECT id, 'What if I have issues with my order?',
  'After payment, you''ll review and approve your pack. If you''re not happy with it, you can request changes, and our dedicated support team will be happy to assist you.',
  6, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_faqs (product_id, question, answer, sort_order, active)
SELECT id, 'How can I reach customer support?',
  'Email us at support@wonderwraps.com or use the contact form on our support page. We typically reply within one business day.',
  7, 1 FROM products WHERE slug='girls-sticker-pack';
INSERT OR IGNORE INTO pdp_faqs (product_id, question, answer, sort_order, active)
SELECT id, 'What languages are your books available in?',
  'Our books are currently available in English, Spanish, Portuguese (Brazil), Arabic, French, Turkish, German, Italian, Dutch and Albanian.',
  8, 1 FROM products WHERE slug='girls-sticker-pack';
