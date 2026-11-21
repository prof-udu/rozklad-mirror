-- schema.sql — схема D1 для бота розкладу та редагування посилань.
-- Застосування: npx wrangler d1 execute rozklad-bot-db --file=schema.sql --remote
-- Безпечно для повторного запуску (IF NOT EXISTS) — оновлює схему без втрати даних.

-- Стан діалогів Telegram-бота
CREATE TABLE IF NOT EXISTS state (
  chat_id    TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Користувачі Telegram-бота
CREATE TABLE IF NOT EXISTS users (
  user_id    TEXT PRIMARY KEY,
  username   TEXT,
  name       TEXT,
  first_seen TEXT,
  last_seen  TEXT,
  queries    INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen);

-- Прив'язка корпоративної пошти викладача до його ПІБ у розкладі.
-- Один email = один викладач; одне ПІБ = один email.
-- status: 'pending' — заявка очікує підтвердження адміністратором,
--         'approved' — підтверджено, викладач може додавати посилання.
CREATE TABLE IF NOT EXISTS bindings (
  email      TEXT PRIMARY KEY,
  teacher    TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

-- Ручні посилання на заняття, додані викладачами через сайт.
-- Ключ (teacher, d, pair): одне посилання на пару викладача в конкретну дату.
CREATE TABLE IF NOT EXISTS links (
  teacher    TEXT NOT NULL,
  d          TEXT NOT NULL,        -- дата ISO, напр. "2026-11-24"
  pair       TEXT NOT NULL,        -- номер пари, напр. "2"
  url        TEXT NOT NULL,
  note       TEXT DEFAULT '',
  by_email   TEXT NOT NULL,        -- хто додав/змінив
  updated_at TEXT NOT NULL,
  PRIMARY KEY (teacher, d, pair)
);

CREATE INDEX IF NOT EXISTS idx_links_date ON links (d);
