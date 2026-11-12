import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP_DIR, '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');
const WORK_DIR = path.join(DATA_DIR, 'work');
const TRANSCRIPT_DIR = path.join(DATA_DIR, 'transcripts');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const JAR_DIR = path.join(ROOT, 'примеры папиных баночек');

for (const dir of [DATA_DIR, UPLOAD_DIR, DOWNLOAD_DIR, WORK_DIR, TRANSCRIPT_DIR, LOG_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

class Logger {
  constructor(logDir) {
    this.appPath = path.join(logDir, 'app.log');
    this.errorPath = path.join(logDir, 'error.log');
    this.maxBytes = 5 * 1024 * 1024;
    this.keepBytes = 2 * 1024 * 1024;
  }

  rotate(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= this.maxBytes) return;
      const handle = fs.openSync(filePath, 'r');
      const size = Math.min(this.keepBytes, stat.size);
      const tail = Buffer.alloc(size);
      fs.readSync(handle, tail, 0, size, stat.size - size);
      fs.closeSync(handle);
      fs.writeFileSync(filePath, tail);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Log rotation failed:', error);
    }
  }

  write(level, message, context = {}, error = null) {
    const entry = {
      time: new Date().toISOString(),
      level,
      message,
      context,
      ...(error ? { error: { name: error.name, message: error.message, code: error.code, stack: error.stack } } : {})
    };
    const line = `${JSON.stringify(entry)}\n`;
    try {
      this.rotate(this.appPath);
      fs.appendFileSync(this.appPath, line, 'utf8');
      if (level === 'error' || level === 'fatal') {
        this.rotate(this.errorPath);
        fs.appendFileSync(this.errorPath, line, 'utf8');
      }
    } catch (writeError) {
      console.error('Logger failed:', writeError, entry);
    }
  }

  info(message, context = {}) { this.write('info', message, context); }
  warn(message, context = {}, error = null) { this.write('warn', message, context, error); }
  error(message, context = {}, error = null) { this.write('error', message, context, error); }
  fatal(message, context = {}, error = null) { this.write('fatal', message, context, error); }
}

const logger = new Logger(LOG_DIR);

const defaults = { port: 3741, model: 'small-q5_1', language: 'ru', maxUploadGb: 20, keepPreparedAudio: false };
let config = defaults;
const configPath = path.join(ROOT, 'config.json');
if (fs.existsSync(configPath)) {
  try { config = { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; }
  catch (error) {
    logger.error('Не удалось прочитать config.json', { configPath }, error);
    console.warn(`Не удалось прочитать config.json: ${error.message}`);
  }
}

const db = new DatabaseSync(path.join(DATA_DIR, 'travnik.sqlite'), { timeout: 5000 });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_url TEXT,
    source_path TEXT,
    source_hash TEXT,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    duration_seconds REAL,
    output_dir TEXT,
    error_code TEXT,
    error_message TEXT,
    warning_message TEXT,
    folder_id TEXT,
    log TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    composition TEXT,
    indications TEXT,
    contraindications TEXT,
    image_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS product_images (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    image_path TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_hash ON jobs(source_hash);
  CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
  CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id, sort_order, created_at);
`);
let ftsEnabled = true;
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    entity_type UNINDEXED,
    entity_id UNINDEXED,
    title,
    content,
    tokenize='unicode61'
  )`);
} catch (error) {
  ftsEnabled = false;
  logger.error('FTS5 недоступен, полнотекстовый поиск ограничен', {}, error);
}
const jobColumns = db.prepare(`PRAGMA table_info(jobs)`).all().map(column => column.name);
if (!jobColumns.includes('warning_message')) db.exec(`ALTER TABLE jobs ADD COLUMN warning_message TEXT`);
if (!jobColumns.includes('folder_id')) db.exec(`ALTER TABLE jobs ADD COLUMN folder_id TEXT`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_folder ON jobs(folder_id)`);
const productColumns = db.prepare(`PRAGMA table_info(products)`).all().map(column => column.name);
if (!productColumns.includes('series')) db.exec(`ALTER TABLE products ADD COLUMN series TEXT`);
if (!productColumns.includes('application')) db.exec(`ALTER TABLE products ADD COLUMN application TEXT`);
db.exec(`INSERT OR IGNORE INTO product_images(id, product_id, image_path, sort_order, created_at)
         SELECT 'legacy_' || id, id, image_path, 0, created_at FROM products
         WHERE image_path IS NOT NULL AND image_path <> ''`);
const defaultFolders = [
  ['folder_lectures', 'Лекции'],
  ['folder_recipes', 'Рецепты'],
  ['folder_articles', 'Статьи']
];
for (const [id, name] of defaultFolders) {
  db.prepare(`INSERT OR IGNORE INTO folders(id, name, created_at) VALUES(?,?,?)`).run(id, name, new Date().toISOString());
}
db.exec(`UPDATE jobs SET status='queued', stage='Восстановлено после перезапуска', progress=0
         WHERE status='processing'`);
logger.info('База данных открыта, миграции применены', { database: path.join(DATA_DIR, 'travnik.sqlite') });

function now() { return new Date().toISOString(); }
function makeId(prefix = '') { return prefix + crypto.randomUUID().replaceAll('-', '').slice(0, 16); }
function cleanName(value) {
  const base = path.basename(String(value || 'файл'));
  return base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180) || 'файл';
}
function isInside(target, root) {
  if (!target) return false;
  const relative = path.relative(root, path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
  res.end(payload);
}
function text(res, status, body, type = 'text/plain; charset=utf-8') {
  const payload = Buffer.from(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': payload.length });
  res.end(payload);
}

const DEEPSEEK_PROMPT_TEMPLATE = `Ты — внимательный научный редактор русскоязычных лекций врача-фитотерапевта. Подготовь из автоматической расшифровки подробный, точный и удобный конспект. Это редакторская работа, а не персональная медицинская консультация.

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА
1. Сохраняй смысл и позицию автора лекции. Не добавляй лечебных обещаний, диагнозов и рекомендаций от себя.
2. Исправляй только очевидные ошибки распознавания, пунктуацию, повторы и слова-паразиты. Если исправление термина неочевидно — не угадывай.
3. Любые сомнительные названия растений, латинские термины, фамилии, цифры, дозировки, пропорции, длительность курса и противопоказания помечай как «нужно сверить с записью».
4. Чётко разделяй: а) что сказано в лекции; б) что найдено во внешних источниках. Не выдавай внешнее дополнение за слова лектора.
5. Если проверяешь термин в интернете, используй надёжные первичные или официальные источники, давай прямые ссылки и не выдумывай источники.
6. Не скрывай противоречия. Покажи разные утверждения рядом и отметь, что именно требует проверки.
7. Сохраняй русские и латинские названия. Для растения по возможности указывай русское название и латинское написание, но только если уверен.
8. Не удаляй важные оговорки о рисках, взаимодействиях, ограничениях и противопоказаниях.

СТРУКТУРА РЕЗУЛЬТАТА
1. Название лекции.
2. Краткое резюме — 5–10 предложений.
3. Основные темы и ключевые тезисы.
4. Подробный конспект с понятными заголовками и списками.
5. Таблица «Растения и вещества»: название; часть растения; состав/действующие вещества; упомянутое действие; форма и способ применения; дозировка; ограничения; степень уверенности.
6. Таблица «Рецептуры и способы приготовления», если они есть: ингредиенты; пропорции; последовательность; режим применения; источник фрагмента; что проверить.
7. Показания, противопоказания, побочные эффекты и взаимодействия — строго по тексту лекции.
8. Все числа, дозировки, проценты, температуры и сроки отдельным списком.
9. Раздел «Нужно сверить с записью»: сомнительные слова и предполагаемый вариант без категоричного исправления.
10. Раздел «Внешняя проверка терминов» со ссылками — только если она действительно выполнялась.
11. Ключевые слова для поиска по библиотеке.

ТРЕБОВАНИЯ К ОФОРМЛЕНИЮ
- Пиши по-русски, ясно и без лишней воды.
- Используй Markdown-заголовки, маркированные списки и компактные таблицы.
- Не сокращай важный медицинский контекст ради краткости.
- В начале добавь предупреждение: «Материал создан по автоматической расшифровке и требует сверки со звуком, особенно в терминах и дозировках».

Название лекции: {{LECTURE_TITLE}}

Автоматическая расшифровка:
---
{{TRANSCRIPT}}
---`;

function deepSeekPrompt(title, transcript, truncated = false) {
  const suffix = truncated ? '\n\nВНИМАНИЕ: расшифровка обрезана из-за большого объёма. Обработай доступную часть и явно укажи это в результате.' : '';
  return DEEPSEEK_PROMPT_TEMPLATE
    .replace('{{LECTURE_TITLE}}', title || 'Без названия')
    .replace('{{TRANSCRIPT}}', `${transcript}${suffix}`);
}
async function readJson(req, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw friendly('REQUEST_TOO_LARGE', 'Запрос слишком большой.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw friendly('BAD_JSON', 'Не удалось прочитать данные запроса.'); }
}
function friendly(code, message, details = '') {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}
function existingCommand(name) {
  const result = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean)?.trim() : null;
}

function diskInfo() {
  try {
    const stats = fs.statfsSync(DATA_DIR);
    return {
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize)
    };
  } catch (error) {
    logger.warn('Не удалось определить свободное место', { dataDir: DATA_DIR }, error);
    return { freeBytes: null, totalBytes: null };
  }
}

function mimeFromName(name) {
  const extension = path.extname(name).toLowerCase();
  return ({
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'
  })[extension] || 'application/octet-stream';
}

const localFfmpeg = path.join(ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe');
const localFfprobe = path.join(ROOT, 'tools', 'ffmpeg', 'ffprobe.exe');
const tools = {
  ffmpeg: fs.existsSync(localFfmpeg) ? localFfmpeg : existingCommand('ffmpeg.exe'),
  ffprobe: fs.existsSync(localFfprobe) ? localFfprobe : existingCommand('ffprobe.exe'),
  ytDlp: fs.existsSync(path.join(ROOT, 'tools', 'yt-dlp.exe')) ? path.join(ROOT, 'tools', 'yt-dlp.exe') : existingCommand('yt-dlp.exe'),
  whisper: fs.existsSync(path.join(ROOT, 'tools', 'whisper', 'whisper-cli.exe')) ? path.join(ROOT, 'tools', 'whisper', 'whisper-cli.exe') : existingCommand('whisper-cli.exe'),
  model: path.join(ROOT, 'models', `ggml-${config.model}.bin`),
  tar: existingCommand('tar.exe'),
  pdfToText: existingCommand('pdftotext.exe')
};

function health() {
  const disk = diskInfo();
  return {
    ok: Boolean(tools.ffmpeg && tools.ffprobe && tools.whisper && fs.existsSync(tools.model)),
    components: {
      ffmpeg: Boolean(tools.ffmpeg),
      whisper: Boolean(tools.whisper),
      model: fs.existsSync(tools.model),
      urlDownloads: Boolean(tools.ytDlp),
      fullTextSearch: ftsEnabled,
      pdfTextExtraction: Boolean(tools.pdfToText)
    },
    disk,
    safeMode: { enabled: true, whisperThreads: Math.max(1, Math.min(3, os.cpus().length - 1)) },
    localOnly: true,
    version: '0.2.1'
  };
}

function appendLog(id, message) {
  const line = `[${new Date().toLocaleTimeString('ru-RU')}] ${message}\n`;
  db.prepare(`UPDATE jobs SET log = substr(log || ?, -50000), updated_at=? WHERE id=?`).run(line, now(), id);
}
function updateJob(id, fields) {
  const allowed = ['source_name', 'source_path', 'source_hash', 'status', 'stage', 'progress', 'duration_seconds', 'output_dir', 'error_code', 'error_message', 'warning_message', 'folder_id'];
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
  if (!entries.length) return;
  const set = entries.map(([key]) => `${key}=?`).join(', ');
  db.prepare(`UPDATE jobs SET ${set}, updated_at=? WHERE id=?`).run(...entries.map(([, value]) => value), now(), id);
}
function publicJob(row) {
  if (!row) return null;
  const outputReady = row.status === 'done';
  const downloadOptions = [
    { ext: 'txt', label: 'TXT', file: 'transcript.txt' },
    { ext: 'srt', label: 'SRT', file: 'transcript.srt' },
    { ext: 'md', label: 'MD', file: 'transcript.md' },
    { ext: 'json', label: 'JSON', file: 'transcript.json' },
    { ext: 'rtf', label: 'WORD', file: 'transcript.rtf' },
    { ext: 'raw', label: 'ОРИГИНАЛ', file: 'transcript_raw.txt' },
    { ext: 'report', label: 'ПРОВЕРКА', file: 'report.md' }
  ];
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    kind: row.kind,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    folderId: row.folder_id,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    durationSeconds: row.duration_seconds,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    warningMessage: row.warning_message,
    log: row.log,
    downloads: outputReady ? downloadOptions
      .filter(item => row.output_dir && fs.existsSync(path.join(row.output_dir, item.file)))
      .map(({ file, ...item }) => ({ ...item, url: `/api/jobs/${row.id}/download/${item.ext}` })) : []
  };
}

function publicFolder(row) {
  return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
}

function publicDocument(row) {
  return row ? {
    id: row.id, folderId: row.folder_id, name: row.name, originalName: row.original_name,
    mimeType: row.mime_type, size: row.size, createdAt: row.created_at, updatedAt: row.updated_at,
    previewUrl: `/api/documents/${row.id}/content`, downloadUrl: `/api/documents/${row.id}/download`
  } : null;
}

function publicProduct(row) {
  const images = row ? db.prepare(`SELECT id, image_path FROM product_images WHERE product_id=? ORDER BY sort_order, created_at`).all(row.id)
    .filter(image => fs.existsSync(image.image_path))
    .map(image => ({ id: image.id, url: `/api/products/${row.id}/images/${image.id}` })) : [];
  return row ? {
    id: row.id, name: row.name, series: row.series || '', description: row.description || '', composition: row.composition || '',
    indications: row.indications || '', contraindications: row.contraindications || '',
    application: row.application || '', images, imageUrl: images[0]?.url || null,
    createdAt: row.created_at, updatedAt: row.updated_at
  } : null;
}

function resolveFolderId(value, fallback = null) {
  const id = value ? String(value) : fallback;
  if (!id) return null;
  return db.prepare(`SELECT id FROM folders WHERE id=?`).get(id)?.id || fallback;
}

function indexSearchEntry(entityType, entityId, title, content = '') {
  if (!ftsEnabled) return;
  try {
    db.prepare(`DELETE FROM search_index WHERE entity_type=? AND entity_id=?`).run(entityType, entityId);
    db.prepare(`INSERT INTO search_index(entity_type, entity_id, title, content) VALUES(?,?,?,?)`)
      .run(entityType, entityId, String(title || ''), String(content || '').slice(0, 2_000_000));
  } catch (error) {
    logger.error('Не удалось обновить поисковый индекс', { entityType, entityId }, error);
  }
}

function removeSearchEntry(entityType, entityId) {
  if (!ftsEnabled) return;
  try { db.prepare(`DELETE FROM search_index WHERE entity_type=? AND entity_id=?`).run(entityType, entityId); }
  catch (error) { logger.warn('Не удалось удалить запись из поискового индекса', { entityType, entityId }, error); }
}

function runUtility(command, args, maxBytes = 5_000_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    const chunks = [];
    let size = 0;
    let stderr = '';
    child.stdout.on('data', chunk => {
      if (size < maxBytes) {
        const remaining = maxBytes - size;
        chunks.push(chunk.subarray(0, remaining));
        size += Math.min(chunk.length, remaining);
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-10_000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(stderr || `Utility exited with ${code}`)));
  });
}

function decodeXmlText(xml) {
  return xml
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractDocumentText(filePath, mimeType) {
  try {
    if (mimeType.startsWith('text/')) return (await fsp.readFile(filePath, 'utf8')).slice(0, 2_000_000);
    if (mimeType.includes('wordprocessingml') && tools.tar) {
      const xml = await runUtility(tools.tar, ['-xOf', filePath, 'word/document.xml']);
      return decodeXmlText(xml).slice(0, 2_000_000);
    }
    if (mimeType === 'application/pdf' && tools.pdfToText) {
      return (await runUtility(tools.pdfToText, ['-layout', filePath, '-'])).slice(0, 2_000_000);
    }
  } catch (error) {
    logger.warn('Не удалось извлечь текст документа', { filePath, mimeType }, error);
  }
  return '';
}

function searchAll(query) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return [];
  if (!ftsEnabled) {
    const like = `%${q}%`;
    return [
      ...db.prepare(`SELECT 'job' AS entity_type, id AS entity_id, source_name AS title, '' AS preview FROM jobs WHERE source_name LIKE ? LIMIT 30`).all(like),
      ...db.prepare(`SELECT 'document' AS entity_type, id AS entity_id, name AS title, '' AS preview FROM documents WHERE name LIKE ? LIMIT 30`).all(like),
      ...db.prepare(`SELECT 'product' AS entity_type, id AS entity_id, name AS title, description AS preview FROM products WHERE name LIKE ? OR description LIKE ? LIMIT 30`).all(like, like)
    ];
  }
  const tokens = q.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 12) || [];
  if (!tokens.length) return [];
  const expression = tokens.map(token => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
  return db.prepare(`SELECT entity_type, entity_id, title, snippet(search_index, 3, '', '', ' … ', 28) AS preview, bm25(search_index) AS rank
                     FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT 60`).all(expression);
}

function validateUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw friendly('BAD_URL', 'Проверьте ссылку: адрес не распознан.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw friendly('BAD_URL', 'Поддерживаются только ссылки http и https.');
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    throw friendly('UNSAFE_URL', 'Локальные сетевые адреса нельзя загружать через форму.');
  }
  return parsed.toString();
}

async function upload(req, res) {
  const maxBytes = Math.floor(config.maxUploadGb * 1024 ** 3);
  const reserveBytes = 2 * 1024 ** 3;
  const announced = Number(req.headers['content-length'] || 0);
  if (announced > maxBytes) return json(res, 413, { error: `Файл больше лимита ${config.maxUploadGb} ГБ.` });
  const initialDisk = diskInfo();
  if (initialDisk.freeBytes !== null && initialDisk.freeBytes - announced < reserveBytes) {
    logger.warn('Загрузка отклонена: мало места', { announced, freeBytes: initialDisk.freeBytes });
    return json(res, 507, { error: 'На диске мало места. Освободите место так, чтобы после загрузки осталось не менее 2 ГБ.' });
  }
  let originalName = 'лекция';
  try { originalName = cleanName(decodeURIComponent(String(req.headers['x-file-name'] || 'лекция'))); } catch {}
  const id = makeId('up_');
  const extension = path.extname(originalName).slice(0, 16);
  const storedPath = path.join(UPLOAD_DIR, `${id}${extension}`);
  const output = fs.createWriteStream(storedPath, { flags: 'wx' });
  const hash = crypto.createHash('sha256');
  let size = 0;
  let nextDiskCheck = 64 * 1024 * 1024;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw friendly('FILE_TOO_LARGE', `Файл больше лимита ${config.maxUploadGb} ГБ.`);
      if (size >= nextDiskCheck) {
        const currentDisk = diskInfo();
        if (currentDisk.freeBytes !== null && currentDisk.freeBytes < reserveBytes) {
          throw friendly('NO_SPACE', 'На диске осталось меньше 2 ГБ. Загрузка остановлена, неполный файл удалён.');
        }
        nextDiskCheck += 64 * 1024 * 1024;
      }
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
    if (size === 0) throw friendly('EMPTY_FILE', 'Выбран пустой файл.');
    const sha256 = hash.digest('hex');
    db.prepare(`INSERT INTO uploads(id, original_name, stored_path, sha256, size, created_at) VALUES(?,?,?,?,?,?)`)
      .run(id, originalName, storedPath, sha256, size, now());
    const duplicate = db.prepare(`SELECT id FROM jobs WHERE source_hash=? AND status='done' ORDER BY created_at DESC LIMIT 1`).get(sha256);
    logger.info('Файл загружен', { uploadId: id, originalName, size, sha256 });
    json(res, 201, { id, originalName, size, duplicateJobId: duplicate?.id || null });
  } catch (error) {
    output.destroy();
    await fsp.rm(storedPath, { force: true }).catch(() => {});
    logger.error('Ошибка загрузки файла', { uploadId: id, originalName, receivedBytes: size }, error);
    const status = error.code === 'FILE_TOO_LARGE' ? 413 : error.code === 'NO_SPACE' ? 507 : 400;
    json(res, status, { error: error.message });
  }
}

let workerRunning = false;
let activeChild = null;
let activeJobId = null;
const canceledJobs = new Set();
function kickWorker() { setTimeout(processQueue, 30).unref(); }

async function createJob(req, res) {
  const body = await readJson(req);
  const kind = body.kind === 'url' ? 'url' : 'file';
  let sourceName;
  let sourceUrl = null;
  let sourcePath = null;
  let sourceHash = null;
  const folderId = resolveFolderId(body.folderId, 'folder_lectures');
  if (kind === 'file') {
    const uploadRow = db.prepare(`SELECT * FROM uploads WHERE id=?`).get(String(body.uploadId || ''));
    if (!uploadRow || !fs.existsSync(uploadRow.stored_path)) throw friendly('UPLOAD_NOT_FOUND', 'Загруженный файл не найден. Выберите его ещё раз.');
    const duplicate = db.prepare(`SELECT * FROM jobs WHERE source_hash=? AND status='done' ORDER BY created_at DESC LIMIT 1`).get(uploadRow.sha256);
    if (duplicate) {
      await fsp.rm(uploadRow.stored_path, { force: true }).catch(error => logger.warn('Не удалось удалить дубликат загрузки', { uploadId: uploadRow.id }, error));
      db.prepare(`DELETE FROM uploads WHERE id=?`).run(uploadRow.id);
      return json(res, 200, { job: publicJob(duplicate), duplicate: true });
    }
    sourceName = uploadRow.original_name;
    sourcePath = uploadRow.stored_path;
    sourceHash = uploadRow.sha256;
  } else {
    sourceUrl = validateUrl(String(body.url || '').trim());
    sourceName = new URL(sourceUrl).hostname;
  }
  const id = makeId('job_');
  const stamp = now();
  db.prepare(`INSERT INTO jobs(id, created_at, updated_at, kind, source_name, source_url, source_path, source_hash, status, stage, progress, folder_id)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, stamp, stamp, kind, sourceName, sourceUrl, sourcePath, sourceHash, 'queued', 'В очереди', 0, folderId);
  appendLog(id, 'Задание добавлено в очередь.');
  logger.info('Создано задание транскрибации', { jobId: id, kind, sourceName, folderId });
  kickWorker();
  json(res, 201, { job: publicJob(db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id)), duplicate: false });
}

function runProcess(command, args, { cwd = ROOT, jobId, onData } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    activeChild = child;
    let stdout = '';
    let stderr = '';
    const consume = (chunk, target) => {
      const value = chunk.toString('utf8');
      if (target === 'out') stdout = (stdout + value).slice(-100_000);
      else stderr = (stderr + value).slice(-100_000);
      onData?.(value);
    };
    child.stdout.on('data', chunk => consume(chunk, 'out'));
    child.stderr.on('data', chunk => consume(chunk, 'err'));
    child.on('error', error => reject(error));
    child.on('close', code => {
      activeChild = null;
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(`Команда завершилась с кодом ${code}`);
        error.exitCode = code;
        error.stdout = stdout;
        error.stderr = stderr;
        if (jobId) appendLog(jobId, (stderr || stdout || error.message).trim().slice(-4000));
        logger.error('Внешний процесс завершился с ошибкой', { jobId, command: path.basename(command), exitCode: code }, error);
        reject(error);
      }
    });
  });
}

async function withRetries(jobId, label, attempts, action) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      appendLog(jobId, `${label}: попытка ${attempt} из ${attempts}.`);
      return await action(attempt);
    } catch (error) {
      lastError = error;
      appendLog(jobId, `${label}: попытка ${attempt} не удалась — ${error.message}`);
      logger.warn('Попытка операции не удалась', { jobId, label, attempt, attempts }, error);
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

async function downloadFromUrl(job) {
  if (!tools.ytDlp) throw friendly('YTDLP_MISSING', 'Модуль загрузки ссылок не установлен. Запустите install.cmd.');
  const targetDir = path.join(DOWNLOAD_DIR, job.id);
  await fsp.mkdir(targetDir, { recursive: true });
  updateJob(job.id, { stage: 'Загружаю запись по ссылке', progress: 5 });
  const outputTemplate = path.join(targetDir, 'source.%(ext)s');
  await withRetries(job.id, 'Загрузка ссылки', 3, () => runProcess(tools.ytDlp, [
    '--no-playlist', '--no-part', '--retries', '5', '--fragment-retries', '5',
    '--retry-sleep', 'exp=1:20', '--socket-timeout', '30',
    '--restrict-filenames', '--windows-filenames', '-f', 'bestaudio/best',
    '--output', outputTemplate, job.source_url
  ], { jobId: job.id, onData: value => {
    const match = value.match(/\[download\]\s+([\d.]+)%/);
    if (match) updateJob(job.id, { progress: Math.min(18, 5 + Math.round(Number(match[1]) * 0.13)) });
  }}));
  const files = (await fsp.readdir(targetDir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && !entry.name.endsWith('.part'))
    .map(entry => path.join(targetDir, entry.name));
  if (!files.length) throw friendly('DOWNLOAD_EMPTY', 'Сайт не вернул медиафайл. Возможно, ссылка закрытая или требует входа.');
  const sizes = await Promise.all(files.map(async file => ({ file, size: (await fsp.stat(file)).size })));
  sizes.sort((a, b) => b.size - a.size);
  const sourcePath = sizes[0].file;
  updateJob(job.id, { source_path: sourcePath, source_name: cleanName(path.basename(sourcePath)) });
  return sourcePath;
}

async function inspectMedia(jobId, sourcePath) {
  if (!tools.ffprobe) throw friendly('FFMPEG_MISSING', 'FFmpeg не установлен. Запустите install.cmd.');
  const { stdout } = await runProcess(tools.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', sourcePath], { jobId });
  let info;
  try { info = JSON.parse(stdout); } catch { throw friendly('MEDIA_BROKEN', 'Не удалось прочитать сведения о файле.'); }
  if (!info.streams?.some(stream => stream.codec_type === 'audio')) {
    throw friendly('NO_AUDIO', 'В этом файле не найдена звуковая дорожка.');
  }
  const duration = Number(info.format?.duration || info.streams.find(stream => stream.codec_type === 'audio')?.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) throw friendly('NO_DURATION', 'Не удалось определить длительность записи. Файл может быть повреждён.');
  return { info, duration };
}

function ensureDiskSpace(duration) {
  if (!fs.statfsSync) return;
  const stats = fs.statfsSync(DATA_DIR);
  const free = Number(stats.bavail) * Number(stats.bsize);
  const needed = duration * 32_000 * 1.25 + 200_000_000;
  if (free < needed) throw friendly('NO_SPACE', `Недостаточно свободного места. Освободите не менее ${Math.ceil(needed / 1024 ** 3)} ГБ.`);
}

function rtfEscape(value) {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === '\\' || char === '{' || char === '}') out += `\\${char}`;
    else if (char === '\n') out += '\\par\n';
    else if (code > 127) out += `\\u${code > 32767 ? code - 65536 : code}?`;
    else out += char;
  }
  return out;
}

function extractUncertainWords(whisperJson) {
  const uncertain = [];
  for (const segment of whisperJson?.transcription || []) {
    let current = null;
    const flush = () => {
      if (!current) return;
      const word = current.parts.join('').trim().replace(/^[.,!?;:—–-]+|[.,!?;:—–-]+$/g, '');
      const confidence = current.probabilities.reduce((sum, value) => sum + value, 0) / Math.max(1, current.probabilities.length);
      if (/[\p{L}\p{N}]/u.test(word) && confidence < 0.52) {
        uncertain.push({ word, at: current.at, confidence: Math.round(confidence * 100) / 100 });
      }
      current = null;
    };
    for (const token of segment.tokens || []) {
      if (!token.text || token.text.startsWith('[_')) continue;
      if (/^\s/u.test(token.text)) flush();
      if (!current) current = { parts: [], probabilities: [], at: token.timestamps?.from || segment.timestamps?.from };
      current.parts.push(token.text);
      if (Number.isFinite(token.p)) current.probabilities.push(token.p);
    }
    flush();
  }
  return uncertain.slice(0, 100);
}

function makeReadableText(segments, fallback) {
  if (!segments?.length) return fallback.trim();
  const paragraphs = [];
  let current = [];
  let length = 0;
  for (const segment of segments) {
    const value = String(segment.text || '').trim();
    if (!value) continue;
    current.push(value);
    length += value.length;
    if (current.length >= 3 || length >= 900) {
      paragraphs.push(current.join(' '));
      current = [];
      length = 0;
    }
  }
  if (current.length) paragraphs.push(current.join(' '));
  return paragraphs.join('\n\n');
}

async function writeDerivedFiles(job, rawText, outputDir) {
  const title = path.parse(job.source_name).name;
  const warning = 'Автоматическая расшифровка. Проверьте названия растений, латинские термины, фамилии и дозировки по исходной записи.';
  const jsonPath = path.join(outputDir, 'transcript.json');
  let whisperJson = null;
  try { whisperJson = JSON.parse(await fsp.readFile(jsonPath, 'utf8')); } catch {}
  const segments = whisperJson?.transcription || [];
  const uncertain = extractUncertainWords(whisperJson);
  const readableText = makeReadableText(segments, rawText);
  await fsp.writeFile(path.join(outputDir, 'transcript_raw.txt'), rawText, 'utf8');
  await fsp.writeFile(path.join(outputDir, 'transcript.txt'), `${readableText}\n`, 'utf8');
  const timedText = segments.length
    ? segments.map(segment => `**[${String(segment.timestamps?.from || '').replace(',', '.').slice(0, 8)}]** ${String(segment.text || '').trim()}`).join('\n\n')
    : readableText;
  const markdown = `# ${title}\n\n> ${warning}\n\n${timedText}\n`;
  await fsp.writeFile(path.join(outputDir, 'transcript.md'), markdown, 'utf8');
  const rtf = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\fs24\\b ${rtfEscape(title)}\\b0\\par\\par ${rtfEscape(warning)}\\par\\par ${rtfEscape(readableText)}}`;
  await fsp.writeFile(path.join(outputDir, 'transcript.rtf'), rtf, 'ascii');
  const report = {
    title, source: job.source_name, createdAt: now(), engine: 'whisper.cpp', model: config.model,
    language: config.language, warning, uncertainFragments: uncertain
  };
  await fsp.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  const reportMd = `# Проверка расшифровки\n\n${warning}\n\n## Фрагменты с низкой уверенностью\n\n${uncertain.length ? uncertain.map(item => `- **${item.at}** — «${item.word}» (${Math.round(item.confidence * 100)}%)`).join('\n') : 'Автоматическая проверка не обнаружила явно сомнительных слов. Это не гарантирует отсутствие ошибок.'}\n`;
  await fsp.writeFile(path.join(outputDir, 'report.md'), reportMd, 'utf8');
  return uncertain;
}

async function processOne(job) {
  if (!tools.ffmpeg || !tools.ffprobe) throw friendly('FFMPEG_MISSING', 'FFmpeg не найден. Запустите install.cmd.');
  if (!tools.whisper || !fs.existsSync(tools.model)) throw friendly('WHISPER_MISSING', 'Движок или модель распознавания не установлены. Запустите install.cmd.');
  updateJob(job.id, { status: 'processing', stage: 'Проверяю источник', progress: 2, error_code: null, error_message: null });
  appendLog(job.id, 'Начата обработка.');
  logger.info('Начата транскрибация', { jobId: job.id, sourceName: job.source_name, kind: job.kind });
  let sourcePath = job.source_path;
  if (job.kind === 'url') sourcePath = await downloadFromUrl(job);
  if (!sourcePath || !fs.existsSync(sourcePath)) throw friendly('SOURCE_MISSING', 'Исходный файл не найден. Добавьте лекцию заново.');

  updateJob(job.id, { stage: 'Проверяю аудио', progress: 20 });
  const { duration } = await inspectMedia(job.id, sourcePath);
  ensureDiskSpace(duration);
  updateJob(job.id, { duration_seconds: duration });

  const jobWork = path.join(WORK_DIR, job.id);
  const outputDir = path.join(TRANSCRIPT_DIR, job.id);
  await fsp.mkdir(jobWork, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });
  const wavPath = path.join(jobWork, 'audio.wav');
  updateJob(job.id, { stage: 'Готовлю звук', progress: 24 });
  await withRetries(job.id, 'Подготовка аудио', 2, () => runProcess(tools.ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', sourcePath,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath
  ], { jobId: job.id }));

  updateJob(job.id, { stage: 'Распознаю речь', progress: 30 });
  const outputBase = path.join(outputDir, 'transcript');
  const threads = Math.max(1, Math.min(3, os.cpus().length - 1));
  let latestProgress = 30;
  await withRetries(job.id, 'Распознавание', 2, attempt => {
    const args = ['-m', tools.model, '-f', wavPath, '-l', config.language, '-t', String(threads),
      '-otxt', '-osrt', '-ojf', '-of', outputBase,
      '--prompt', 'Фитотерапия, лекарственные растения, ботаника, фармакогнозия, латинские названия растений.'];
    if (attempt > 1) args.push('-bs', '3');
    return runProcess(tools.whisper, args, { jobId: job.id, onData: value => {
      for (const match of value.matchAll(/(?:progress\s*=\s*|\b)(\d{1,3})%/gi)) {
        const percent = Math.max(0, Math.min(100, Number(match[1])));
        const mapped = 30 + Math.round(percent * 0.64);
        if (mapped >= latestProgress + 2) {
          latestProgress = mapped;
          updateJob(job.id, { progress: mapped });
        }
      }
    }});
  });

  const txtPath = `${outputBase}.txt`;
  if (!fs.existsSync(txtPath)) throw friendly('NO_TRANSCRIPT', 'Движок завершил работу, но текст не был создан.');
  const transcriptText = await fsp.readFile(txtPath, 'utf8');
  if (!transcriptText.trim()) throw friendly('EMPTY_TRANSCRIPT', 'В записи не удалось обнаружить разборчивую речь.');
  updateJob(job.id, { stage: 'Сохраняю результаты', progress: 96 });
  const uncertain = await writeDerivedFiles(job, transcriptText, outputDir);
  indexSearchEntry('job', job.id, job.source_name, transcriptText);
  updateJob(job.id, {
    status: 'done', stage: 'Готово', progress: 100, output_dir: outputDir,
    warning_message: uncertain.length ? `Найдено сомнительных слов: ${uncertain.length}. Откройте файл «Проверка».` : 'Специальные термины всё равно рекомендуется сверить с записью.'
  });
  appendLog(job.id, 'Расшифровка успешно завершена.');
  logger.info('Транскрибация завершена', { jobId: job.id, durationSeconds: duration, uncertainWords: uncertain.length, threads });

  if (job.kind === 'url') {
    await fsp.rm(path.join(DOWNLOAD_DIR, job.id), { recursive: true, force: true })
      .catch(error => logger.warn('Не удалось удалить загруженный источник URL', { jobId: job.id }, error));
  } else if (sourcePath.startsWith(UPLOAD_DIR + path.sep)) {
    await fsp.rm(sourcePath, { force: true })
      .catch(error => logger.warn('Не удалось удалить временную копию исходного файла', { jobId: job.id, sourcePath }, error));
    db.prepare(`DELETE FROM uploads WHERE stored_path=?`).run(sourcePath);
  }
  updateJob(job.id, { source_path: null });
}

function classifyError(error) {
  if (error.code && error.code !== 'ENOENT') return { code: error.code, message: error.message };
  const details = `${error.stderr || ''}\n${error.message || ''}`.toLowerCase();
  if (details.includes('unsupported url')) return { code: 'UNSUPPORTED_URL', message: 'Этот сайт или тип ссылки пока не поддерживается.' };
  if (details.includes('private video') || details.includes('sign in') || details.includes('login')) return { code: 'AUTH_REQUIRED', message: 'Запись закрыта или требует входа на сайт.' };
  if (details.includes('disk') && details.includes('space')) return { code: 'NO_SPACE', message: 'На диске закончилось свободное место.' };
  if (details.includes('invalid data') || details.includes('could not find codec')) return { code: 'MEDIA_BROKEN', message: 'Файл повреждён или его формат не поддерживается.' };
  return { code: 'PROCESSING_FAILED', message: 'Обработка не завершилась. Откройте технические подробности и попробуйте ещё раз.' };
}

async function processQueue() {
  if (workerRunning) return;
  const job = db.prepare(`SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1`).get();
  if (!job) return;
  workerRunning = true;
  activeJobId = job.id;
  try { await processOne(job); }
  catch (error) {
    if (canceledJobs.has(job.id)) {
      updateJob(job.id, { status: 'canceled', stage: 'Остановлено', error_code: null, error_message: null });
      appendLog(job.id, 'Задание остановлено пользователем.');
      logger.info('Задание остановлено пользователем', { jobId: job.id });
      if (job.kind === 'url') {
        await fsp.rm(path.join(DOWNLOAD_DIR, job.id), { recursive: true, force: true })
          .catch(error => logger.warn('Не удалось очистить загрузку отменённой ссылки', { jobId: job.id }, error));
      } else if (job.source_path?.startsWith(UPLOAD_DIR + path.sep)) {
        await fsp.rm(job.source_path, { force: true })
          .catch(error => logger.warn('Не удалось удалить источник отменённого задания', { jobId: job.id }, error));
        db.prepare(`DELETE FROM uploads WHERE stored_path=?`).run(job.source_path);
        updateJob(job.id, { source_path: null });
      }
    } else {
      const problem = classifyError(error);
      updateJob(job.id, { status: 'failed', stage: 'Нужна помощь', error_code: problem.code, error_message: problem.message });
      appendLog(job.id, `${problem.message}\n${String(error.stderr || error.stack || '').slice(-5000)}`);
      logger.error('Транскрибация завершилась ошибкой', { jobId: job.id, problem }, error);
      console.error(error);
    }
  } finally {
    if (!config.keepPreparedAudio) {
      await fsp.rm(path.join(WORK_DIR, job.id), { recursive: true, force: true })
        .catch(error => logger.error('Не удалось очистить рабочую папку', { jobId: job.id }, error));
    }
    canceledJobs.delete(job.id);
    activeJobId = null;
    workerRunning = false;
    kickWorker();
  }
}

async function createFolder(req, res) {
  const body = await readJson(req);
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name) throw friendly('BAD_FOLDER_NAME', 'Введите название папки.');
  const id = makeId('folder_');
  try {
    db.prepare(`INSERT INTO folders(id, name, created_at) VALUES(?,?,?)`).run(id, name, now());
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) throw friendly('FOLDER_EXISTS', 'Папка с таким названием уже существует.');
    throw error;
  }
  logger.info('Создана папка', { folderId: id, name });
  json(res, 201, { folder: publicFolder(db.prepare(`SELECT * FROM folders WHERE id=?`).get(id)) });
}

async function createDocument(req, res) {
  const body = await readJson(req);
  const uploadRow = db.prepare(`SELECT * FROM uploads WHERE id=?`).get(String(body.uploadId || ''));
  if (!uploadRow || !fs.existsSync(uploadRow.stored_path)) throw friendly('UPLOAD_NOT_FOUND', 'Загруженный файл не найден. Выберите его ещё раз.');
  const extension = path.extname(uploadRow.original_name).toLowerCase();
  if (!['.pdf', '.docx', '.doc', '.txt', '.md'].includes(extension)) {
    throw friendly('DOCUMENT_TYPE', 'В библиотеку можно добавить PDF, DOCX, DOC, TXT или MD.');
  }
  const id = makeId('doc_');
  const stamp = now();
  const folderId = resolveFolderId(body.folderId, null);
  const name = String(body.name || path.parse(uploadRow.original_name).name).trim().slice(0, 180) || uploadRow.original_name;
  db.prepare(`INSERT INTO documents(id, folder_id, name, original_name, stored_path, mime_type, size, created_at, updated_at)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id, folderId, name, uploadRow.original_name, uploadRow.stored_path, mimeFromName(uploadRow.original_name), uploadRow.size, stamp, stamp);
  db.prepare(`DELETE FROM uploads WHERE id=?`).run(uploadRow.id);
  const extractedText = await extractDocumentText(uploadRow.stored_path, mimeFromName(uploadRow.original_name));
  indexSearchEntry('document', id, name, extractedText);
  logger.info('Документ добавлен в библиотеку', { documentId: id, folderId, name, size: uploadRow.size });
  json(res, 201, { document: publicDocument(db.prepare(`SELECT * FROM documents WHERE id=?`).get(id)) });
}

async function updateDocument(id, req, res) {
  const row = db.prepare(`SELECT * FROM documents WHERE id=?`).get(id);
  if (!row) return json(res, 404, { error: 'Документ не найден.' });
  const body = await readJson(req);
  const folderId = body.folderId === null ? null : resolveFolderId(body.folderId, row.folder_id);
  const name = body.name === undefined ? row.name : String(body.name).trim().slice(0, 180) || row.name;
  db.prepare(`UPDATE documents SET folder_id=?, name=?, updated_at=? WHERE id=?`).run(folderId, name, now(), id);
  if (ftsEnabled) db.prepare(`UPDATE search_index SET title=? WHERE entity_type='document' AND entity_id=?`).run(name, id);
  logger.info('Документ обновлён', { documentId: id, folderId, name });
  json(res, 200, { document: publicDocument(db.prepare(`SELECT * FROM documents WHERE id=?`).get(id)) });
}

async function deleteDocument(id, res) {
  const row = db.prepare(`SELECT * FROM documents WHERE id=?`).get(id);
  if (!row) return json(res, 404, { error: 'Документ не найден.' });
  db.prepare(`DELETE FROM documents WHERE id=?`).run(id);
  removeSearchEntry('document', id);
  await fsp.rm(row.stored_path, { force: true }).catch(error => logger.error('Не удалось удалить файл документа', { documentId: id, storedPath: row.stored_path }, error));
  logger.info('Документ удалён', { documentId: id, name: row.name });
  json(res, 200, { ok: true });
}

async function deleteJob(id, res) {
  const row = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id);
  if (!row) return json(res, 404, { error: 'Лекция не найдена.' });
  if (row.status === 'processing' || activeJobId === id) {
    return json(res, 409, { error: 'Сначала остановите текущую расшифровку, затем удалите её.' });
  }
  const cleanup = async (target, root, label) => {
    if (!isInside(target, root)) return;
    await fsp.rm(target, { recursive: true, force: true }).catch(error => logger.warn('Не удалось удалить данные лекции', { jobId: id, label, target }, error));
  };
  await cleanup(row.source_path, UPLOAD_DIR, 'загруженный источник');
  await cleanup(row.source_path, DOWNLOAD_DIR, 'загруженный источник по ссылке');
  await cleanup(row.output_dir, TRANSCRIPT_DIR, 'результат');
  await cleanup(path.join(WORK_DIR, id), WORK_DIR, 'рабочая папка');
  await cleanup(path.join(DOWNLOAD_DIR, id), DOWNLOAD_DIR, 'папка загрузки');
  if (row.source_path) db.prepare(`DELETE FROM uploads WHERE stored_path=?`).run(row.source_path);
  removeSearchEntry('job', id);
  db.prepare(`DELETE FROM jobs WHERE id=?`).run(id);
  logger.info('Лекция удалена из истории', { jobId: id, name: row.source_name, status: row.status });
  json(res, 200, { ok: true });
}

function productFields(body, fallback = {}) {
  const optional = key => body[key] === undefined ? (fallback[key] || '') : String(body[key] || '').trim().slice(0, 20_000);
  return {
    name: String(body.name ?? fallback.name ?? '').trim().slice(0, 180),
    series: optional('series').slice(0, 100),
    description: optional('description'),
    composition: optional('composition'),
    indications: optional('indications'),
    contraindications: optional('contraindications'),
    application: optional('application')
  };
}

async function consumeProductImage(uploadId) {
  if (!uploadId) return null;
  const uploadRow = db.prepare(`SELECT * FROM uploads WHERE id=?`).get(String(uploadId));
  if (!uploadRow || !fs.existsSync(uploadRow.stored_path)) throw friendly('UPLOAD_NOT_FOUND', 'Фотография не найдена. Выберите её ещё раз.');
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(uploadRow.original_name).toLowerCase())) {
    throw friendly('IMAGE_TYPE', 'Поддерживаются фотографии JPG, PNG и WEBP.');
  }
  db.prepare(`DELETE FROM uploads WHERE id=?`).run(uploadRow.id);
  return uploadRow.stored_path;
}

async function consumeProductImages(uploadIds) {
  const paths = [];
  for (const uploadId of [...new Set((uploadIds || []).map(String))].slice(0, 12)) {
    paths.push(await consumeProductImage(uploadId));
  }
  return paths;
}

function addProductImages(productId, imagePaths) {
  const current = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS value FROM product_images WHERE product_id=?`).get(productId).value;
  const insert = db.prepare(`INSERT INTO product_images(id, product_id, image_path, sort_order, created_at) VALUES(?,?,?,?,?)`);
  imagePaths.forEach((imagePath, index) => insert.run(makeId('image_'), productId, imagePath, current + index + 1, now()));
}

async function createProduct(req, res) {
  const body = await readJson(req);
  const fields = productFields(body);
  if (!fields.name) throw friendly('PRODUCT_NAME', 'Введите название заготовки.');
  const imagePaths = await consumeProductImages(body.imageUploadIds || (body.imageUploadId ? [body.imageUploadId] : []));
  const id = makeId('product_');
  const stamp = now();
  db.prepare(`INSERT INTO products(id, name, series, description, composition, indications, contraindications, application, image_path, created_at, updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, fields.name, fields.series, fields.description, fields.composition, fields.indications, fields.contraindications, fields.application, null, stamp, stamp);
  addProductImages(id, imagePaths);
  indexSearchEntry('product', id, fields.name, [fields.series, fields.description, fields.composition, fields.indications, fields.contraindications, fields.application].join('\n'));
  logger.info('Создана заготовка', { productId: id, name: fields.name, imageCount: imagePaths.length });
  json(res, 201, { product: publicProduct(db.prepare(`SELECT * FROM products WHERE id=?`).get(id)) });
}

async function updateProduct(id, req, res) {
  const row = db.prepare(`SELECT * FROM products WHERE id=?`).get(id);
  if (!row) return json(res, 404, { error: 'Заготовка не найдена.' });
  const body = await readJson(req);
  const fields = productFields(body, row);
  if (!fields.name) throw friendly('PRODUCT_NAME', 'Введите название заготовки.');
  const imagePaths = await consumeProductImages(body.imageUploadIds || (body.imageUploadId ? [body.imageUploadId] : []));
  const removeImageIds = [...new Set((body.removeImageIds || []).map(String))].slice(0, 50);
  for (const imageId of removeImageIds) {
    const image = db.prepare(`SELECT * FROM product_images WHERE id=? AND product_id=?`).get(imageId, id);
    if (!image) continue;
    db.prepare(`DELETE FROM product_images WHERE id=?`).run(imageId);
    await fsp.rm(image.image_path, { force: true }).catch(error => logger.warn('Не удалось удалить фото', { productId: id, imageId }, error));
  }
  addProductImages(id, imagePaths);
  db.prepare(`UPDATE products SET name=?, series=?, description=?, composition=?, indications=?, contraindications=?, application=?, image_path=NULL, updated_at=? WHERE id=?`)
    .run(fields.name, fields.series, fields.description, fields.composition, fields.indications, fields.contraindications, fields.application, now(), id);
  indexSearchEntry('product', id, fields.name, [fields.series, fields.description, fields.composition, fields.indications, fields.contraindications, fields.application].join('\n'));
  logger.info('Заготовка обновлена', { productId: id, name: fields.name });
  json(res, 200, { product: publicProduct(db.prepare(`SELECT * FROM products WHERE id=?`).get(id)) });
}

async function deleteProduct(id, res) {
  const row = db.prepare(`SELECT * FROM products WHERE id=?`).get(id);
  if (!row) return json(res, 404, { error: 'Заготовка не найдена.' });
  const images = db.prepare(`SELECT * FROM product_images WHERE product_id=?`).all(id);
  db.prepare(`DELETE FROM products WHERE id=?`).run(id);
  removeSearchEntry('product', id);
  for (const image of images) {
    await fsp.rm(image.image_path, { force: true }).catch(error => logger.error('Не удалось удалить фото заготовки', { productId: id, imageId: image.id }, error));
  }
  logger.info('Заготовка удалена', { productId: id, name: row.name });
  json(res, 200, { ok: true });
}

async function lastLogLines(filePath, count = 100) {
  try {
    const stat = await fsp.stat(filePath);
    const readBytes = Math.min(stat.size, 256 * 1024);
    const handle = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, stat.size - readBytes);
    await handle.close();
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-count);
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn('Не удалось прочитать лог', { filePath }, error);
    return [];
  }
}

async function diagnostics() {
  const [appLog, errorLog] = await Promise.all([lastLogLines(logger.appPath), lastLogLines(logger.errorPath)]);
  return {
    health: health(),
    system: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, memoryBytes: os.totalmem() },
    counts: {
      jobs: db.prepare(`SELECT COUNT(*) AS count FROM jobs`).get().count,
      documents: db.prepare(`SELECT COUNT(*) AS count FROM documents`).get().count,
      products: db.prepare(`SELECT COUNT(*) AS count FROM products`).get().count
    },
    logPaths: { app: logger.appPath, errors: logger.errorPath },
    logs: { app: appLog, errors: errorLog }
  };
}

async function rebuildMissingSearchIndex() {
  if (!ftsEnabled) return;
  const hasEntry = db.prepare(`SELECT 1 AS found FROM search_index WHERE entity_type=? AND entity_id=? LIMIT 1`);
  for (const job of db.prepare(`SELECT id, source_name, output_dir FROM jobs WHERE status='done'`).all()) {
    if (hasEntry.get('job', job.id)) continue;
    try {
      const content = await fsp.readFile(path.join(job.output_dir, 'transcript.txt'), 'utf8');
      indexSearchEntry('job', job.id, job.source_name, content);
    } catch (error) { logger.warn('Не удалось индексировать старую транскрипцию', { jobId: job.id }, error); }
  }
  for (const document of db.prepare(`SELECT * FROM documents`).all()) {
    if (hasEntry.get('document', document.id)) continue;
    const content = await extractDocumentText(document.stored_path, document.mime_type);
    indexSearchEntry('document', document.id, document.name, content);
  }
  for (const product of db.prepare(`SELECT * FROM products`).all()) {
    if (hasEntry.get('product', product.id)) continue;
    indexSearchEntry('product', product.id, product.name, [product.series, product.description, product.composition, product.indications, product.contraindications, product.application].join('\n'));
  }
  logger.info('Поисковый индекс проверен');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};
async function serveFile(res, base, relative, downloadName = null, disposition = 'attachment') {
  const resolvedBase = path.resolve(base);
  const target = path.resolve(base, relative);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) return text(res, 403, 'Запрещено');
  let stat;
  try { stat = await fsp.stat(target); } catch { return text(res, 404, 'Не найдено'); }
  if (!stat.isFile()) return text(res, 404, 'Не найдено');
  const headers = { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size };
  if (downloadName) headers['Content-Disposition'] = `${disposition}; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  res.writeHead(200, headers);
  fs.createReadStream(target).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, health());
    if (req.method === 'GET' && url.pathname === '/api/diagnostics') return json(res, 200, await diagnostics());
    if (req.method === 'GET' && url.pathname === '/api/deepseek-template') {
      const prompt = deepSeekPrompt('[укажите название лекции]', '[вставьте сюда текст расшифровки]');
      if (url.searchParams.get('download') === '1') {
        const payload = Buffer.from(prompt, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': payload.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('Промпт для конспекта DeepSeek.txt')}`
        });
        return res.end(payload);
      }
      return json(res, 200, { prompt });
    }
    if (req.method === 'GET' && url.pathname === '/api/search') return json(res, 200, { results: searchAll(url.searchParams.get('q')) });
    if (req.method === 'POST' && url.pathname === '/api/upload') return upload(req, res);
    if (req.method === 'POST' && url.pathname === '/api/jobs') return createJob(req, res);
    if (url.pathname === '/api/folders') {
      if (req.method === 'GET') return json(res, 200, { folders: db.prepare(`SELECT * FROM folders ORDER BY name COLLATE NOCASE`).all().map(publicFolder) });
      if (req.method === 'POST') return createFolder(req, res);
    }
    if (url.pathname === '/api/documents') {
      if (req.method === 'GET') {
        const rows = db.prepare(`SELECT * FROM documents ORDER BY updated_at DESC`).all();
        return json(res, 200, { documents: rows.map(publicDocument) });
      }
      if (req.method === 'POST') return createDocument(req, res);
    }
    const documentContentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/(content|download)$/);
    if (req.method === 'GET' && documentContentMatch) {
      const row = db.prepare(`SELECT * FROM documents WHERE id=?`).get(documentContentMatch[1]);
      if (!row || !fs.existsSync(row.stored_path)) return json(res, 404, { error: 'Файл документа не найден.' });
      const relative = path.relative(UPLOAD_DIR, row.stored_path);
      const disposition = documentContentMatch[2] === 'content' && (row.mime_type.startsWith('application/pdf') || row.mime_type.startsWith('text/')) ? 'inline' : 'attachment';
      return serveFile(res, UPLOAD_DIR, relative, row.original_name, disposition);
    }
    const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
    if (documentMatch) {
      if (req.method === 'PATCH') return updateDocument(documentMatch[1], req, res);
      if (req.method === 'DELETE') return deleteDocument(documentMatch[1], res);
    }
    if (url.pathname === '/api/products') {
      if (req.method === 'GET') return json(res, 200, { products: db.prepare(`SELECT * FROM products ORDER BY updated_at DESC`).all().map(publicProduct) });
      if (req.method === 'POST') return createProduct(req, res);
    }
    const productGalleryImageMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/images\/([^/]+)$/);
    if (req.method === 'GET' && productGalleryImageMatch) {
      const image = db.prepare(`SELECT * FROM product_images WHERE product_id=? AND id=?`).get(productGalleryImageMatch[1], productGalleryImageMatch[2]);
      if (!image || !fs.existsSync(image.image_path)) return text(res, 404, 'Фотография не найдена.');
      return serveFile(res, UPLOAD_DIR, path.relative(UPLOAD_DIR, image.image_path), path.basename(image.image_path), 'inline');
    }
    const productImageMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/image$/);
    if (req.method === 'GET' && productImageMatch) {
      const row = db.prepare(`SELECT * FROM products WHERE id=?`).get(productImageMatch[1]);
      if (!row?.image_path || !fs.existsSync(row.image_path)) return text(res, 404, 'Фотография не найдена.');
      return serveFile(res, UPLOAD_DIR, path.relative(UPLOAD_DIR, row.image_path), path.basename(row.image_path), 'inline');
    }
    const productMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
    if (productMatch) {
      if (req.method === 'PUT') return updateProduct(productMatch[1], req, res);
      if (req.method === 'DELETE') return deleteProduct(productMatch[1], res);
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const q = String(url.searchParams.get('q') || '').trim();
      const rows = q
        ? db.prepare(`SELECT * FROM jobs WHERE source_name LIKE ? ORDER BY created_at DESC LIMIT 100`).all(`%${q}%`)
        : db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100`).all();
      return json(res, 200, { jobs: rows.map(publicJob), activeJobId: workerRunning ? db.prepare(`SELECT id FROM jobs WHERE status='processing' LIMIT 1`).get()?.id : null });
    }
    const deepSeekMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/deepseek-prompt$/);
    if (req.method === 'GET' && deepSeekMatch) {
      const row = db.prepare(`SELECT * FROM jobs WHERE id=? AND status='done'`).get(deepSeekMatch[1]);
      if (!row?.output_dir) return json(res, 404, { error: 'Готовая расшифровка не найдена.' });
      const transcript = await fsp.readFile(path.join(row.output_dir, 'transcript.txt'), 'utf8');
      const maxChars = 400_000;
      const excerpt = transcript.slice(0, maxChars);
      const truncated = transcript.length > maxChars;
      const prompt = deepSeekPrompt(row.source_name, excerpt, truncated);
      return json(res, 200, { prompt, truncated, characters: prompt.length });
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const row = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(jobMatch[1]);
      return row ? json(res, 200, { job: publicJob(row) }) : json(res, 404, { error: 'Задание не найдено.' });
    }
    if (req.method === 'PATCH' && jobMatch) {
      const row = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(jobMatch[1]);
      if (!row) return json(res, 404, { error: 'Задание не найдено.' });
      const body = await readJson(req);
      const folderId = body.folderId === null ? null : resolveFolderId(body.folderId, row.folder_id);
      updateJob(row.id, { folder_id: folderId });
      logger.info('Транскрипция перемещена в папку', { jobId: row.id, folderId });
      return json(res, 200, { job: publicJob(db.prepare(`SELECT * FROM jobs WHERE id=?`).get(row.id)) });
    }
    if (req.method === 'DELETE' && jobMatch) return deleteJob(jobMatch[1], res);
    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const row = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(cancelMatch[1]);
      if (!row) return json(res, 404, { error: 'Задание не найдено.' });
      if (row.status === 'queued') {
        updateJob(row.id, { status: 'canceled', stage: 'Остановлено', progress: row.progress });
        if (row.source_path?.startsWith(UPLOAD_DIR + path.sep)) {
          await fsp.rm(row.source_path, { force: true }).catch(error => logger.warn('Не удалось удалить источник задания из очереди', { jobId: row.id }, error));
          db.prepare(`DELETE FROM uploads WHERE stored_path=?`).run(row.source_path);
          updateJob(row.id, { source_path: null });
        }
        logger.info('Задание удалено из очереди', { jobId: row.id });
      } else if (row.status === 'processing' && activeJobId === row.id) {
        canceledJobs.add(row.id);
        activeChild?.kill();
        updateJob(row.id, { stage: 'Останавливаю…' });
      }
      return json(res, 200, { job: publicJob(db.prepare(`SELECT * FROM jobs WHERE id=?`).get(row.id)) });
    }
    const retryMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
    if (req.method === 'POST' && retryMatch) {
      const row = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(retryMatch[1]);
      if (!row) return json(res, 404, { error: 'Задание не найдено.' });
      updateJob(row.id, { status: 'queued', stage: 'Повтор в очереди', progress: 0, error_code: null, error_message: null });
      appendLog(row.id, 'Пользователь запросил повторную попытку.');
      kickWorker();
      return json(res, 200, { job: publicJob(db.prepare(`SELECT * FROM jobs WHERE id=?`).get(row.id)) });
    }
    const downloadMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/download\/(txt|srt|md|json|rtf|raw|report)$/);
    if (req.method === 'GET' && downloadMatch) {
      const row = db.prepare(`SELECT * FROM jobs WHERE id=? AND status='done'`).get(downloadMatch[1]);
      if (!row) return json(res, 404, { error: 'Готовый результат не найден.' });
      const ext = downloadMatch[2];
      const mapping = {
        txt: ['transcript.txt', 'txt'], srt: ['transcript.srt', 'srt'], md: ['transcript.md', 'md'],
        json: ['transcript.json', 'json'], rtf: ['transcript.rtf', 'rtf'], raw: ['transcript_raw.txt', 'txt'], report: ['report.md', 'md']
      };
      const [fileName, downloadExt] = mapping[ext];
      const suffix = ext === 'raw' ? '_оригинал' : ext === 'report' ? '_проверка' : '';
      return serveFile(res, row.output_dir, fileName, `${path.parse(row.source_name).name}${suffix}.${downloadExt}`);
    }
    if (req.method === 'GET' && url.pathname === '/api/jars') {
      let images = [];
      if (fs.existsSync(JAR_DIR)) images = (await fsp.readdir(JAR_DIR)).filter(name => /\.(jpe?g|png|webp)$/i.test(name)).slice(0, 8);
      return json(res, 200, { images: images.map(name => ({ name, url: `/jar-images/${encodeURIComponent(name)}` })) });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/jar-images/')) {
      return serveFile(res, JAR_DIR, decodeURIComponent(url.pathname.slice('/jar-images/'.length)));
    }
    if (req.method === 'GET') {
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      return serveFile(res, PUBLIC_DIR, relative);
    }
    json(res, 404, { error: 'Не найдено.' });
  } catch (error) {
    logger.error('Ошибка HTTP-запроса', { method: req.method, pathname: url.pathname, code: error.code }, error);
    console.error(error);
    const clientErrors = ['BAD_URL', 'UNSAFE_URL', 'BAD_JSON', 'UPLOAD_NOT_FOUND', 'BAD_FOLDER_NAME', 'FOLDER_EXISTS', 'DOCUMENT_TYPE', 'PRODUCT_NAME', 'IMAGE_TYPE'];
    json(res, clientErrors.includes(error.code) ? 400 : error.code === 'NO_SPACE' ? 507 : 500, { error: error.message || 'Внутренняя ошибка.' });
  }
}

if (process.argv.includes('--doctor')) {
  const status = health();
  console.log(JSON.stringify(status, null, 2));
  db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
  db.close();
  process.exit(status.ok ? 0 : 1);
}

const server = http.createServer(route);
server.listen(config.port, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${config.port}`;
  console.log(`\nТравник работает: ${address}`);
  console.log('Чтобы остановить приложение, закройте это окно или нажмите Ctrl+C.\n');
  logger.info('Сервер Travnik запущен', { address, version: health().version, pid: process.pid });
  fsp.readdir(WORK_DIR, { withFileTypes: true })
    .then(entries => Promise.all(entries.map(entry => fsp.rm(path.join(WORK_DIR, entry.name), { recursive: true, force: true }))))
    .then(() => logger.info('Старые рабочие файлы очищены'))
    .catch(error => logger.error('Не удалось очистить старые рабочие файлы', { workDir: WORK_DIR }, error));
  rebuildMissingSearchIndex().catch(error => logger.error('Ошибка фонового индексирования', {}, error));
  kickWorker();
  if (process.argv.includes('--open')) {
    const opener = spawn('cmd.exe', ['/c', 'start', '', address], { detached: true, windowsHide: true, stdio: 'ignore' });
    opener.unref();
  }
});

server.on('error', error => logger.fatal('Ошибка локального HTTP-сервера', { port: config.port }, error));

process.on('unhandledRejection', (reason, promise) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Необработанный Promise rejection', { promise: String(promise) }, error);
  console.error(error);
});

process.on('uncaughtException', error => {
  logger.fatal('Необработанное исключение', { pid: process.pid }, error);
  console.error(error);
  setTimeout(() => process.exit(1), 1000).unref();
});

process.on('SIGINT', () => {
  activeChild?.kill();
  server.close(() => {
    db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
    db.close();
    process.exit(0);
  });
});

process.on('SIGTERM', () => process.emit('SIGINT'));
