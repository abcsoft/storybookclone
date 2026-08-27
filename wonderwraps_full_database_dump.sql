BEGIN TRANSACTION;
CREATE TABLE _cf_METADATA (
        key INTEGER PRIMARY KEY,
        value BLOB
      );
INSERT INTO "_cf_METADATA" VALUES(2,691);
CREATE TABLE ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_provider TEXT NOT NULL DEFAULT 'wonderwraps',
  api_endpoint TEXT NOT NULL DEFAULT 'https://api.wonderwraps.com/v1/generate-book',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'wonderwraps-v2',
  style_preset TEXT NOT NULL DEFAULT 'fairytale-watercolour',
  prompt_template TEXT NOT NULL DEFAULT 'A magical children storybook illustration of {childName}, age {childAge}, exploring a fairytale castle in royal attire with gentle storybook lighting.',
  face_swap_strength REAL NOT NULL DEFAULT 0.85,
  hardcover_price REAL NOT NULL DEFAULT 49.20,
  softcover_price REAL NOT NULL DEFAULT 34.20,
  enable_ai_preview INTEGER NOT NULL DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "ai_settings" VALUES(1,'wonderwraps','https://api.wonderwraps.com/v1/generate-book','','wonderwraps-v2','fairytale-watercolour','A magical children storybook illustration of {childName}, age {childAge}, exploring a fairytale castle in royal attire with gentle storybook lighting.',0.85,49.2,34.2,1,'2026-08-27 21:55:46');
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT,
  message TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" VALUES(1,'0001_initial.sql','2026-08-27 21:33:08');
INSERT INTO "d1_migrations" VALUES(2,'0002_pdp_sections.sql','2026-08-27 21:33:08');
INSERT INTO "d1_migrations" VALUES(3,'0003_ai_settings.sql','2026-08-27 21:55:46');
CREATE TABLE discounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  percent REAL NOT NULL,
  min_books INTEGER DEFAULT 0,      
  applies_to TEXT DEFAULT 'books',  
  auto_apply INTEGER DEFAULT 0,     
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "discounts" VALUES(1,'EXTRA20',20.0,2,'books',1,1,'2026-08-27 21:33:20');
CREATE TABLE newsletter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'book',
  unit_price REAL NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  child_name TEXT DEFAULT '',
  child_age INTEGER,
  language TEXT DEFAULT 'English',
  dedication TEXT DEFAULT '',
  photo_key TEXT DEFAULT '', 
  preview_status TEXT NOT NULL DEFAULT 'pending', 
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL,
  shipping_method TEXT NOT NULL DEFAULT 'standard',
  shipping REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  discount_code TEXT,
  total REAL NOT NULL,
  
  status TEXT NOT NULL DEFAULT 'pending_preview',
  admin_notes TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE pdf_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  book_slug TEXT NOT NULL,
  child_name TEXT,
  child_age TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE pdp_accordions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);
INSERT INTO "pdp_accordions" VALUES(1,1,'New accordion','New accordion body generated from admin.',99,1);
CREATE TABLE pdp_faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);
CREATE TABLE pdp_gallery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  alt TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);
CREATE TABLE pdp_magic (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  heading TEXT DEFAULT 'See How a Simple Photo Becomes a Beautiful Story',
  left_image TEXT DEFAULT '',
  left_caption TEXT DEFAULT '',
  right_image TEXT DEFAULT '',
  right_caption TEXT DEFAULT '',
  body TEXT DEFAULT ''
);
CREATE TABLE pdp_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  image_url TEXT DEFAULT '',
  href TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0
);
CREATE TABLE pdp_page (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  banner_text TEXT DEFAULT 'Save 20% on 3+ items using code: RATRI20',
  banner_code TEXT DEFAULT 'RATRI20',
  banner_badge TEXT DEFAULT 'SAVE 40%',
  preorder_note TEXT DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "pdp_page" VALUES(1,'Save 30% on 3+ items using code: WONDER30','WONDER30','NEW 30% OFF','','2026-08-27 21:36:19');
CREATE TABLE pdp_photo_tips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            
  label TEXT NOT NULL,
  image_url TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0
);
CREATE TABLE pdp_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rating INTEGER DEFAULT 5,
  review TEXT NOT NULL,
  image_url TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);
CREATE TABLE pdp_related (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  related_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY (product_id, related_id)
);
INSERT INTO "pdp_related" VALUES(1,3,0);
INSERT INTO "pdp_related" VALUES(1,5,1);
INSERT INTO "pdp_related" VALUES(1,11,2);
CREATE TABLE pdp_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  step_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE pdp_trust (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  icon TEXT DEFAULT 'sparkle',
  sort_order INTEGER DEFAULT 0
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  tagline TEXT DEFAULT '',
  description TEXT DEFAULT '',
  story TEXT DEFAULT '',
  price REAL NOT NULL,
  compare_at REAL,
  image TEXT DEFAULT '',
  gender TEXT NOT NULL DEFAULT 'unisex', 
  category TEXT NOT NULL DEFAULT 'book', 
  ages TEXT DEFAULT '',
  age_min INTEGER DEFAULT 2,
  age_max INTEGER DEFAULT 10,
  pages INTEGER DEFAULT 32,
  reviews INTEGER DEFAULT 0,
  rating REAL DEFAULT 4.8,
  bestseller INTEGER DEFAULT 0,
  new_release INTEGER DEFAULT 0,
  career INTEGER DEFAULT 0,
  traits_json TEXT DEFAULT '[]',
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "products" VALUES(1,'girls-sticker-pack','Girl''s Sticker Pack','Personalized sticker packs for your little girl','Stickers that celebrate your child’s big dreams — unicorns, rainbows, and her own illustrated face on every sheet.','A treasure box of 40+ custom stickers starring your little girl. From unicorns to rainbows, every sheet is illustrated just for her.',14.99,29.99,'/static/img/stickers-girl.webp','girl','sticker','2–10',2,10,6,1842,4.9,1,0,0,'["40+ custom stickers","Her face on every sheet","Premium vinyl"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(2,'boys-sticker-pack','Boy''s Sticker Pack','Personalized sticker packs for your little boy','Rockets, dinosaurs, soccer stars — and your boy as the hero of every sticker.','A high-energy pack of 40+ custom stickers starring your little boy. Rockets, dinos, race cars, and superheroes — all with his face.',14.99,29.99,'/static/img/stickers-boy.webp','boy','sticker','2–10',2,10,6,1604,4.8,1,0,0,'["40+ custom stickers","His face on every sheet","Premium vinyl"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(3,'the-portugals-new-legend','The Portugal’s New Legend','For champions with red and green at heart','Months of sweat and practice in the wind and rain have led to this single moment, the Grand Final for A Seleção das Quinas.','Months of sweat and practice in the wind and rain have led to this single moment, the Grand Final for A Seleção das Quinas. Today, with the red and green on their back and the heart of a champion, history is waiting to be made. The whistle is about to blow. Força Portugal! Give them the moment they’ve always dreamed of.',44.99,NULL,'/static/img/cover-portugal.webp','boy','book','6–12',6,12,32,2924,4.9,1,1,0,'["Teaches resilience & courage","Upload your favorite photo","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(4,'princess-girl-the-one-we-all-needed','Princess Girl, the One We All Needed','A magical journey of kindness and courage','When kindness calls, even the smallest acts can change everything.','When kindness calls, even the smallest acts can change everything. In this enchanting personalized tale, a Princess follows a glowing guide through gardens, lakes, and stormy skies, helping new friends discover their true strength. Along the way, she learns that bravery and compassion are the brightest magic of all.',34.99,NULL,'/static/img/cover-princess.webp','girl','book','4–10',4,10,32,2565,4.9,1,1,0,'["Inspires empathy, courage, and self-belief","32 beautifully illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(5,'happy-birthday-girl','Happy Birthday Girl','The perfect birthday gift for your little girl','A sparkling birthday adventure where she is the guest of honour — cake, confetti, and a wish that comes true.','Today is the most magical day of the year. In this joyful tale, your little girl is the star of her own birthday celebration, complete with friends, cake, and a wish that lights up the sky.',34.99,NULL,'/static/img/cover-birthday-girl.webp','girl','book','2–8',2,8,32,1180,4.8,0,0,0,'["Perfect birthday keepsake","Name on every page","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(6,'happy-birthday-boy','Happy Birthday Boy','The perfect birthday gift for your little boy','Balloons, cake, and a hero’s birthday quest — starring your little boy.','The candles are lit and the adventure begins. Your little boy is the birthday hero, racing through a day of surprises, friends, and a wish that comes true.',34.99,NULL,'/static/img/cover-birthday-boy.webp','boy','book','2–8',2,8,32,980,4.8,0,0,0,'["Perfect birthday keepsake","Name on every page","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(7,'super-boy-and-the-dragon','Super Boy and the Dragon','Kindness turns a scary dragon into a true friend','A cape, a roar, and a surprising friendship that proves the bravest heroes lead with kindness.','When a lonely dragon frightens the village, Super Boy doesn’t fight — he listens. Together they discover that the bravest magic of all is kindness.',34.99,NULL,'/static/img/cover-dragon.webp','boy','book','4–10',4,10,32,1432,4.9,0,1,0,'["Teaches kindness & courage","32 illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(8,'the-boy-and-the-cosmic-journey','The Boy and the Cosmic Journey','Discovering courage in an adventure to the stars','A bedtime voyage through planets, constellations, and the biggest dream of all.','One night a lost star winks at your little boy. He climbs aboard a silver rocket and sails the cosmos, learning that curiosity and courage can light the darkest sky.',34.99,NULL,'/static/img/cover-cosmic.webp','boy','book','4–10',4,10,32,1210,4.8,0,1,0,'["Sparks curiosity","32 illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(9,'princess-and-the-glowing-flower','Princess and the Glowing Flower','A luminous quest through an enchanted forest','A princess follows a petal of light to restore wonder to a fading woodland.','Deep in an enchanted forest, a single flower still glows. Your little princess follows its light, helping woodland friends and discovering that hope is something you can carry.',34.99,NULL,'/static/img/cover-flower.webp','girl','book','4–10',4,10,32,990,4.8,0,0,0,'["Inspires hope & wonder","32 illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(10,'girl-counts-with-the-forest-friends','Girl Counts with the Forest Friends','A gentle counting adventure among woodland animals','Rabbits, birds, and foxes help her count from one to ten on a sun-dappled trail.','On a walk through the woods, your little girl meets forest friends who need her help counting. One rabbit, two birds, three foxes — every number is a new friend.',34.99,NULL,'/static/img/cover-forest.webp','girl','book','2–6',2,6,28,760,4.7,0,0,0,'["Early learning","Counting 1–10","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(11,'boy-the-dinos-need-you','Boy, the Dinos Need You','A prehistoric rescue powered by a brave little heart','Friendly dinosaurs need a clever helper — and your boy is just the hero.','When the dinosaurs lose their favourite valley, your little boy leads a prehistoric rescue. Along the way he learns that even the smallest helper can change everything.',34.99,NULL,'/static/img/cover-dinos.webp','boy','book','2–6',2,6,28,842,4.8,0,0,0,'["Dino adventure","Teaches helping others","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(12,'the-girl-and-the-christmas-express','The Girl and the Christmas Express','A snowy ride to the North Pole — starring her','A glittering steam train, falling snow, and a Christmas wish that needs a conductor.','On Christmas Eve a golden train stops at her window. Your little girl becomes the conductor of the Christmas Express, delivering wonder to every snowy village along the way.',34.99,NULL,'/static/img/cover-christmas.webp','girl','book','3–8',3,8,32,1104,4.9,0,0,0,'["Holiday keepsake","32 illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(13,'the-boy-and-the-christmas-express','The Boy and the Christmas Express','All aboard a snowy Christmas adventure','Your little boy takes the whistle of a magical holiday train.','A crimson locomotive puffs to his door on Christmas Eve. Your little boy is invited to drive the Christmas Express and discover that giving is the greatest gift.',34.99,NULL,'/static/img/cover-christmas.webp','boy','book','3–8',3,8,32,1011,4.8,0,0,0,'["Holiday keepsake","32 illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(14,'boy-explores-the-zoo','Boy Explores the Zoo','Wild zoo adventure: meet & learn with animals','Giraffes, lions, and penguins — a day at the zoo with your boy as the explorer.','A golden ticket, a map, and a day of wonder. Your little boy meets the animals of the zoo and learns that every creature has a story — including him.',34.99,NULL,'/static/img/cover-zoo.webp','boy','book','3–8',3,8,32,688,4.7,0,0,0,'["Animal learning","32 illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(15,'girl-explores-the-zoo','Girl Explores the Zoo','Wild zoo adventure: meet & learn with animals','A curious girl spends a magical day meeting the animals of the zoo.','With a sketchbook and a brave heart, your little girl explores the zoo, making friends from the savannah to the arctic exhibit.',34.99,NULL,'/static/img/cover-zoo.webp','girl','book','3–8',3,8,32,654,4.7,0,0,0,'["Animal learning","32 illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(16,'girl-saves-the-arctic-kingdom','Girl Saves the Arctic Kingdom','An icy adventure powered by care and courage','Polar bears, penguins, and a melting kingdom that needs a kind-hearted hero.','Far to the north, the Arctic Kingdom is losing its glow. Your little girl sets out across the ice, helping polar friends and proving that care can warm even the coldest world.',34.99,NULL,'/static/img/cover-arctic.webp','girl','book','4–10',4,10,32,577,4.8,0,0,0,'["Care & courage","32 illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(17,'vroom-vroom-the-boy-wins-the-race','Vroom Vroom, The Boy Wins the Race','A high-speed tale of practice, patience, and victory','Helmets on — your little boy is the champion of the grand prix.','Practice, patience, and a roaring engine. Your little boy lines up at the starting grid and learns that winning is about never giving up — and cheering for friends too.',34.99,NULL,'/static/img/cover-race.webp','boy','book','3–8',3,8,32,720,4.8,0,0,0,'["Sportsmanship","32 illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(18,'boys-smile','Boy''s Smile','Discover how a smile can light up every day','A gentle story about the superpower hiding in a little boy’s grin.','One bright smile can change a rainy morning, a shy friend, and a whole town. Your little boy discovers that kindness starts with the smallest, sunniest thing he owns.',34.99,NULL,'/static/img/cover-smile.webp','boy','book','2–6',2,6,28,540,4.9,0,0,0,'["Kindness & joy","28 illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(19,'princess-weve-been-waiting-for-you','Princess! We''ve Been Waiting for You','A fairytale welcome written just for her','The kingdom has been waiting — and she is the princess they needed all along.','Bells ring across the kingdom. Your little girl is the princess they’ve been waiting for, and every page is a celebration of who she already is.',34.99,NULL,'/static/img/cover-princess.webp','girl','book','4–10',4,10,32,1330,4.9,1,0,0,'["Fairytale magic","32 illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(20,'boy-explores-the-world-of-jobs','Boy Explores the World of Jobs','Open their eyes to the many possibilities waiting for them','Firefighter, doctor, pilot, chef — a career adventure starring your little boy.','A wonderful, engaging book that opens kids’ eyes to the many possibilities waiting for them. Your little boy tries on the hats of heroes, helpers, and dreamers — and imagines who he might become.',34.99,NULL,'/static/img/cover-firefighter.webp','boy','book','4–10',4,10,32,890,4.8,0,0,1,'["Career inspiration","32 illustrated pages","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(21,'little-firefighter','Little Firefighter','A career adventure for brave hearts','Helmet on, hose ready — your child is the hero of the firehouse.','The alarm rings and your child races to the truck. In this hyper-personalised career adventure they learn teamwork, bravery, and how helpers keep a town safe.',34.99,NULL,'/static/img/cover-firefighter.webp','unisex','book','4–10',4,10,32,612,4.8,0,0,1,'["Career adventure","Bravery & teamwork","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(22,'little-police-officer','Little Police Officer','A career adventure for helpers and protectors','Badge shining, your child keeps the neighbourhood kind and safe.','With a badge and a kind heart, your child spends a day as a police officer — helping neighbours, finding lost pets, and learning that real heroes listen first.',34.99,NULL,'/static/img/cover-police.webp','unisex','book','4–10',4,10,32,501,4.7,0,0,1,'["Career adventure","Kindness & helping","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(23,'little-pilot','Little Pilot','A career adventure above the clouds','Wheels up — your child takes the controls of a sunrise flight.','From the runway to the clouds, your child is the captain. They learn that big dreams take practice, checklists, and a sky full of courage.',34.99,NULL,'/static/img/cover-pilot.webp','unisex','book','4–10',4,10,32,448,4.8,0,0,1,'["Career adventure","Dreams & focus","Preview before ordering"]',1,'2026-08-27 21:33:20');
INSERT INTO "products" VALUES(24,'little-doctor','Little Doctor','A career adventure of care and healing','Stethoscope on — your child is the kindest doctor in town.','In a colourful children’s clinic, your child listens, helps, and heals. A gentle career story about empathy, science, and looking after others.',34.99,NULL,'/static/img/cover-doctor.webp','unisex','book','4–10',4,10,32,533,4.8,0,0,1,'["Career adventure","Empathy & care","Preview before ordering"]',1,'2026-08-27 21:33:20');
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, 
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "sessions" VALUES('762378a6f8cea2d928b89f4c2932792d2816160822ef1d7c9838c499544be1f6',1,1790458537,'2026-08-27 21:35:37');
INSERT INTO "sessions" VALUES('1d11a31d418714342b038ce3b76a7f71ebe80f3741ab49276bbebff7bd2d27d0',1,1790458661,'2026-08-27 21:37:41');
INSERT INTO "sessions" VALUES('fc9d9507461a199c532eaafa8c0a6cc6dabe8b38939ad759c5ff3838264c0249',1,1790458719,'2026-08-27 21:38:39');
INSERT INTO "sessions" VALUES('2a3a61ac6c3b9866adb3ec8970e97bb7287b7f25ae3a1e6f9d30f64692b1333c',1,1790460533,'2026-08-27 22:08:53');
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer', 
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "users" VALUES(1,'WonderWraps Admin','admin@wonderwraps.com','pbkdf2$42b461e5b4c39d7302ae1b7e64211bea$30c38a66bcb1125c936aa4da528195c8d5c3a27ca36e6ab32a1b086be4c4019b','admin','2026-08-27 21:34:21');
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_orders_email ON orders(email);
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_products_slug ON products(slug);
CREATE INDEX idx_products_category ON products(category, active);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_pdp_gallery_product ON pdp_gallery(product_id, sort_order);
CREATE INDEX idx_pdp_accordions_product ON pdp_accordions(product_id, sort_order);
CREATE INDEX idx_pdp_steps_product ON pdp_steps(product_id, step_no);
CREATE INDEX idx_pdp_photo_tips_product ON pdp_photo_tips(product_id, kind, sort_order);
CREATE INDEX idx_pdp_faqs_product ON pdp_faqs(product_id, sort_order);
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('d1_migrations',3);
INSERT INTO "sqlite_sequence" VALUES('pdp_gallery',0);
INSERT INTO "sqlite_sequence" VALUES('pdp_accordions',1);
INSERT INTO "sqlite_sequence" VALUES('pdp_steps',0);
INSERT INTO "sqlite_sequence" VALUES('pdp_photo_tips',0);
INSERT INTO "sqlite_sequence" VALUES('pdp_trust',0);
INSERT INTO "sqlite_sequence" VALUES('pdp_reactions',0);
INSERT INTO "sqlite_sequence" VALUES('pdp_media',0);
INSERT INTO "sqlite_sequence" VALUES('pdp_faqs',0);
INSERT INTO "sqlite_sequence" VALUES('discounts',8);
INSERT INTO "sqlite_sequence" VALUES('products',24);
INSERT INTO "sqlite_sequence" VALUES('users',1);
COMMIT;
