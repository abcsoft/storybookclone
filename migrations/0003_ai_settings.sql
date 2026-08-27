-- Migration 0003: AI & Book Generation API settings & PDF requests

CREATE TABLE IF NOT EXISTS ai_settings (
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

INSERT OR IGNORE INTO ai_settings (
  id, api_provider, api_endpoint, api_key, model, style_preset, prompt_template, face_swap_strength, hardcover_price, softcover_price, enable_ai_preview
) VALUES (
  1,
  'wonderwraps',
  'https://api.wonderwraps.com/v1/generate-book',
  '',
  'wonderwraps-v2',
  'fairytale-watercolour',
  'A magical children storybook illustration of {childName}, age {childAge}, exploring a fairytale castle in royal attire with gentle storybook lighting.',
  0.85,
  49.20,
  34.20,
  1
);

CREATE TABLE IF NOT EXISTS pdf_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  book_slug TEXT NOT NULL,
  child_name TEXT,
  child_age TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
