'use strict';
require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'private_uploads');
const MAX_AGE = Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS || 86400);
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });

const db = new Database(path.join(DATA_DIR, 'academy.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT, last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0, is_paid INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY, module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', duration TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
  is_paid INTEGER NOT NULL DEFAULT 0, video_path TEXT
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY, module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  question TEXT NOT NULL, options_json TEXT NOT NULL, answer INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Общее',
  description TEXT NOT NULL DEFAULT '', published INTEGER NOT NULL DEFAULT 0,
  is_paid INTEGER NOT NULL DEFAULT 0, file_path TEXT
);
CREATE TABLE IF NOT EXISTS progress (
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL, PRIMARY KEY (telegram_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS favorites (
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  PRIMARY KEY (telegram_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS quiz_results (
  id INTEGER PRIMARY KEY, telegram_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  score INTEGER NOT NULL, total INTEGER NOT NULL, completed_at TEXT NOT NULL
);
`);
for (const [table, column] of [['modules', 'is_paid'], ['lessons', 'is_paid']]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
}

const json = express.json({ limit: '1mb' });
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use('/api', json);

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function verifyInitData(raw) {
  if (!process.env.BOT_TOKEN) throw Object.assign(new Error('Сервер не настроен: добавьте BOT_TOKEN.'), { status: 503 });
  if (!raw || raw.length > 16384) return null;
  const params = new URLSearchParams(raw);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!receivedHash || !Number.isFinite(authDate) || Math.floor(Date.now() / 1000) - authDate > MAX_AGE || authDate > Math.floor(Date.now() / 1000) + 60) return null;
  params.delete('hash');
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  if (!safeEqual(calculated, receivedHash)) return null;
  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { return null; }
  if (!user || !user.id) return null;
  return user;
}
const admins = new Set((process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
function auth(req, res, next) {
  try {
    const user = verifyInitData(req.get('X-Telegram-Init-Data') || '');
    if (!user) return res.status(401).json({ error: 'Не удалось подтвердить вход через Telegram. Перезапустите приложение из бота.' });
    const id = String(user.id);
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Ученик';
    db.prepare(`INSERT INTO users(telegram_id,name,username,last_seen) VALUES(?,?,?,?)
      ON CONFLICT(telegram_id) DO UPDATE SET name=excluded.name,username=excluded.username,last_seen=excluded.last_seen`)
      .run(id, name, user.username || null, new Date().toISOString());
    req.user = { id, name, username: user.username || '', admin: admins.has(id) };
    next();
  } catch (e) { next(e); }
}
function admin(req, res, next) {
  if (!req.user.admin) return res.status(403).json({ error: 'Управление доступно только администратору.' });
  next();
}
function asInt(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw Object.assign(new Error(`Проверьте поле «${label}».`), { status: 400 });
  return n;
}
function published(value) { return value === true || value === 1 || value === '1'; }
function removeOldFile(relative) {
  if (!relative || !relative.startsWith('/api/media/')) return;
  const file = path.join(UPLOAD_DIR, path.basename(relative));
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, api: 'avito-academy', telegramConfigured: Boolean(process.env.BOT_TOKEN) }));
app.use('/api', auth);
app.get('/api/me', (req, res) => res.json(req.user));
app.get('/api/content', (req, res) => {
  const isAdmin = req.user.admin && req.query.admin === '1';
  const modules = db.prepare(`SELECT * FROM modules ${isAdmin ? '' : 'WHERE published=1 AND is_paid=0'} ORDER BY position,id`).all().map(m => {
    const lessons = db.prepare(`SELECT * FROM lessons WHERE module_id=? ${isAdmin ? '' : 'AND published=1 AND is_paid=0'} ORDER BY position,id`).all(m.id);
    const questions = db.prepare('SELECT * FROM questions WHERE module_id=? ORDER BY id').all(m.id).map(q => ({
      id: q.id, question: q.question, options: JSON.parse(q.options_json), ...(isAdmin ? { answer: q.answer } : {})
    }));
    return { ...m, published: Boolean(m.published), is_paid: Boolean(m.is_paid), lessons: lessons.map(l => ({ ...l, published: Boolean(l.published), is_paid: Boolean(l.is_paid) })), questions };
  });
  const materials = db.prepare(`SELECT * FROM materials WHERE published=1 ${isAdmin ? '' : 'AND is_paid=0'} ORDER BY id DESC`)
    .all().map(m => ({ ...m, published: Boolean(m.published), is_paid: Boolean(m.is_paid) }));
  res.json({ modules, materials });
});
app.get('/api/state', (req, res) => {
  const completed = db.prepare('SELECT lesson_id FROM progress WHERE telegram_id=?').all(req.user.id).map(r => r.lesson_id);
  const favorites = db.prepare('SELECT lesson_id FROM favorites WHERE telegram_id=?').all(req.user.id).map(r => r.lesson_id);
  const results = db.prepare('SELECT module_id,score,total,completed_at FROM quiz_results WHERE telegram_id=? ORDER BY id DESC').all(req.user.id);
  res.json({ completed, favorites, results });
});
app.put('/api/progress/:id', (req, res) => {
  const id = asInt(req.params.id, 'урок');
  const lesson = db.prepare('SELECT l.id FROM lessons l JOIN modules m ON m.id=l.module_id WHERE l.id=? AND l.published=1 AND m.published=1 AND l.is_paid=0 AND m.is_paid=0').get(id);
  if (!lesson && !req.user.admin) return res.status(404).json({ error: 'Урок не найден.' });
  db.prepare('INSERT OR IGNORE INTO progress VALUES(?,?,?)').run(req.user.id, id, new Date().toISOString());
  res.json({ ok: true });
});
app.put('/api/favorites/:id', (req, res) => {
  const id = asInt(req.params.id, 'урок');
  if (req.body?.favorite) db.prepare('INSERT OR IGNORE INTO favorites VALUES(?,?)').run(req.user.id, id);
  else db.prepare('DELETE FROM favorites WHERE telegram_id=? AND lesson_id=?').run(req.user.id, id);
  res.json({ ok: true });
});
app.post('/api/quiz/:id', (req, res) => {
  const moduleId = asInt(req.params.id, 'модуль');
  const module = db.prepare('SELECT published,is_paid FROM modules WHERE id=?').get(moduleId);
  if (!module || ((!module.published || module.is_paid) && !req.user.admin)) return res.status(404).json({ error: 'Тест не найден.' });
  const questions = db.prepare('SELECT id,answer FROM questions WHERE module_id=?').all(moduleId);
  if (!questions.length) return res.status(400).json({ error: 'В этом модуле пока нет вопросов.' });
  const answers = req.body?.answers || {};
  const score = questions.reduce((n, q) => n + (Number(answers[q.id]) === q.answer ? 1 : 0), 0);
  db.prepare('INSERT INTO quiz_results(telegram_id,module_id,score,total,completed_at) VALUES(?,?,?,?,?)')
    .run(req.user.id, moduleId, score, questions.length, new Date().toISOString());
  res.json({ score, total: questions.length });
});

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 250 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const video = ['.mp4', '.webm'].includes(ext) && ['video/mp4', 'video/webm', 'application/octet-stream'].includes(file.mimetype);
    const material = ['.pdf', '.txt', '.zip', '.png', '.jpg', '.jpeg'].includes(ext);
    cb(null, video || material);
  }
});
app.post('/api/admin/upload/lesson/:id', admin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Выберите MP4 или WebM видео (до 250 МБ).' });
  const id = asInt(req.params.id, 'урок');
  const lesson = db.prepare('SELECT video_path FROM lessons WHERE id=?').get(id);
  if (!lesson) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Урок не найден.' }); }
  const stored = `lesson-${id}-${crypto.randomUUID()}${path.extname(req.file.originalname).toLowerCase()}`;
  fs.renameSync(req.file.path, path.join(UPLOAD_DIR, stored));
  db.prepare('UPDATE lessons SET video_path=? WHERE id=?').run(`/api/media/file/${stored}`, id);
  removeOldFile(lesson.video_path);
  res.json({ ok: true });
});
app.post('/api/admin/upload/material/:id', admin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не подходит. Разрешены PDF, TXT, ZIP, PNG и JPG (до 250 МБ).' });
  const id = asInt(req.params.id, 'материал');
  const material = db.prepare('SELECT file_path FROM materials WHERE id=?').get(id);
  if (!material) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Материал не найден.' }); }
  const ext = path.extname(req.file.originalname).toLowerCase();
  const stored = `material-${id}-${crypto.randomUUID()}${ext}`;
  fs.renameSync(req.file.path, path.join(UPLOAD_DIR, stored));
  db.prepare('UPDATE materials SET file_path=? WHERE id=?').run(`/api/media/file/${stored}`, id);
  removeOldFile(material.file_path);
  res.json({ ok: true });
});
app.get('/api/media/material/:id', (req, res) => {
  const material = db.prepare('SELECT * FROM materials WHERE id=? AND published=1').get(asInt(req.params.id, 'материал'));
  if (!material || (material.is_paid && !req.user.admin)) return res.status(404).json({ error: 'Материал недоступен.' });
  if (!material.file_path) return res.status(404).json({ error: 'Файл ещё не загружен.' });
  res.sendFile(path.join(UPLOAD_DIR, path.basename(material.file_path)));
});
app.get('/api/media/file/:name', (req, res) => {
  const name = path.basename(req.params.name);
  if (name !== req.params.name) return res.sendStatus(404);
  const lesson = db.prepare('SELECT l.*,m.published AS module_published,m.is_paid AS module_paid FROM lessons l JOIN modules m ON m.id=l.module_id WHERE l.video_path=?').get(`/api/media/file/${name}`);
  const material = db.prepare('SELECT * FROM materials WHERE file_path=?').get(`/api/media/file/${name}`);
  if (lesson && ((!lesson.published || !lesson.module_published || lesson.is_paid || lesson.module_paid) && !req.user.admin)) return res.sendStatus(404);
  if (material && ((!material.published || material.is_paid) && !req.user.admin)) return res.sendStatus(404);
  if (!lesson && !material) return res.sendStatus(404);
  res.sendFile(path.join(UPLOAD_DIR, name));
});

const allowed = {
  modules: { table: 'modules', fields: ['title', 'position', 'published', 'is_paid'] },
  lessons: { table: 'lessons', fields: ['module_id', 'title', 'description', 'duration', 'position', 'published', 'is_paid'] },
  questions: { table: 'questions', fields: ['module_id', 'question', 'options_json', 'answer'] },
  materials: { table: 'materials', fields: ['title', 'category', 'description', 'published', 'is_paid'] }
};
function normalize(type, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Некорректные данные.'), { status: 400 });
  const out = {};
  if (type === 'modules') {
    out.title = String(body.title || '').trim(); out.position = asInt(body.position ?? 0, 'порядок'); out.published = published(body.published) ? 1 : 0; out.is_paid = published(body.is_paid) ? 1 : 0;
  } else if (type === 'lessons') {
    out.module_id = asInt(body.module_id, 'модуль'); out.title = String(body.title || '').trim();
    out.description = String(body.description || ''); out.duration = String(body.duration || ''); out.position = asInt(body.position ?? 0, 'порядок'); out.published = published(body.published) ? 1 : 0; out.is_paid = published(body.is_paid) ? 1 : 0;
  } else if (type === 'materials') {
    out.title = String(body.title || '').trim(); out.category = String(body.category || 'Общее').trim(); out.description = String(body.description || '');
    out.published = published(body.published) ? 1 : 0; out.is_paid = published(body.is_paid) ? 1 : 0;
  } else {
    out.module_id = asInt(body.module_id, 'модуль'); out.question = String(body.question || '').trim();
    const options = Array.isArray(body.options) ? body.options.map(x => String(x).trim()).filter(Boolean) : [];
    out.options_json = JSON.stringify(options); out.answer = asInt(body.answer, 'правильный ответ');
    if (options.length < 2 || out.answer >= options.length) throw Object.assign(new Error('Проверьте варианты ответов и правильный ответ.'), { status: 400 });
  }
  if (!out.title && type !== 'questions') throw Object.assign(new Error('Заполните название.'), { status: 400 });
  if (!out.question && type === 'questions') throw Object.assign(new Error('Заполните вопрос.'), { status: 400 });
  return out;
}
for (const type of Object.keys(allowed)) {
  const { table, fields } = allowed[type];
  app.post(`/api/admin/${type}`, admin, (req, res, next) => {
    try {
      const data = normalize(type, req.body);
      const result = db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).run(fields.map(f => data[f]));
      res.status(201).json({ id: result.lastInsertRowid });
    } catch (e) { next(e); }
  });
  app.patch(`/api/admin/${type}/:id`, admin, (req, res, next) => {
    try {
      const id = asInt(req.params.id, 'ID'); const data = normalize(type, req.body);
      const result = db.prepare(`UPDATE ${table} SET ${fields.map(f => `${f}=?`).join(',')} WHERE id=?`).run(...fields.map(f => data[f]), id);
      if (!result.changes) return res.status(404).json({ error: 'Запись не найдена.' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.delete(`/api/admin/${type}/:id`, admin, (req, res, next) => {
    try {
      const id = asInt(req.params.id, 'ID');
      if (type === 'lessons') { const row = db.prepare('SELECT video_path FROM lessons WHERE id=?').get(id); if (row) removeOldFile(row.video_path); }
      if (type === 'materials') { const row = db.prepare('SELECT file_path FROM materials WHERE id=?').get(id); if (row) removeOldFile(row.file_path); }
      const result = db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      if (!result.changes) return res.status(404).json({ error: 'Запись не найдена.' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}
app.get('/api/admin/students', admin, (_req, res) => {
  const users = db.prepare('SELECT telegram_id AS id,name,username,last_seen FROM users ORDER BY last_seen DESC').all();
  res.json(users);
});

app.use(['/data', '/private_uploads', '/.git', '/server.js', '/package.json', '/.env'], (_req, res) => res.sendStatus(404));
app.use(express.static(ROOT, { index: 'index.html', dotfiles: 'ignore' }));
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Максимальный размер файла — 250 МБ.' });
  const status = Number(err.status) || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера.' : err.message });
});
app.listen(PORT, () => console.log(`Avito Academy API listening on :${PORT}`));
