-- WonderWraps fullstack schema
-- Auth / users
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer', -- customer | admin
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, -- unix seconds
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Catalog (managed from the admin panel)
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  tagline TEXT DEFAULT '',
  description TEXT DEFAULT '',
  story TEXT DEFAULT '',
  price REAL NOT NULL,
  compare_at REAL,
  image TEXT DEFAULT '',
  gender TEXT NOT NULL DEFAULT 'unisex', -- girl | boy | unisex
  category TEXT NOT NULL DEFAULT 'book', -- book | sticker
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

-- Discount codes (EXTRA20 etc.)
CREATE TABLE IF NOT EXISTS discounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  percent REAL NOT NULL,
  min_books INTEGER DEFAULT 0,      -- minimum number of book items required
  applies_to TEXT DEFAULT 'books',  -- books | all
  auto_apply INTEGER DEFAULT 0,     -- apply automatically when eligible
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Orders + personalised items
CREATE TABLE IF NOT EXISTS orders (
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
  -- pipeline: pending_preview -> preview_sent -> approved -> printing -> shipped -> delivered (| cancelled)
  status TEXT NOT NULL DEFAULT 'pending_preview',
  admin_notes TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
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
  photo_key TEXT DEFAULT '', -- R2 object key or data: URL fallback
  preview_status TEXT NOT NULL DEFAULT 'pending', -- pending | preview_ready | changes_requested | approved
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Support inbox
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT,
  message TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS newsletter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category, active);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
