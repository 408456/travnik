-- Travnik 0.2.1. The server applies these changes automatically and safely.
ALTER TABLE products ADD COLUMN series TEXT;
ALTER TABLE products ADD COLUMN application TEXT;
CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id, sort_order, created_at);
INSERT OR IGNORE INTO product_images(id, product_id, image_path, sort_order, created_at)
SELECT 'legacy_' || id, id, image_path, 0, created_at
FROM products WHERE image_path IS NOT NULL AND image_path <> '';
