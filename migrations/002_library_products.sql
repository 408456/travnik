-- Travnik 0.2.0. The application applies the same migration automatically.
ALTER TABLE jobs ADD COLUMN folder_id TEXT;
CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL, name TEXT NOT NULL, original_name TEXT NOT NULL, stored_path TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, composition TEXT, indications TEXT, contraindications TEXT, image_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(entity_type UNINDEXED, entity_id UNINDEXED, title, content, tokenize='unicode61');
CREATE INDEX IF NOT EXISTS idx_jobs_folder ON jobs(folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at DESC);
INSERT OR IGNORE INTO folders(id, name, created_at) VALUES ('folder_lectures', 'Лекции', datetime('now')), ('folder_recipes', 'Рецепты', datetime('now')), ('folder_articles', 'Статьи', datetime('now'));
