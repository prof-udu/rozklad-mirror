/**
 * worker.js — Telegram-бот розкладу кафедри професійної освіти
 * УДУ імені Михайла Драгоманова для Cloudflare Workers.
 *
 * Бот НЕ звертається до сервера університету напряму. Він читає статичне
 * JSON-дзеркало (data/), яке періодично оновлює sync.py і публікує на
 * GitHub. Тому бот працює навіть тоді, коли сервер розкладу вимкнений.
 *
 * Можливості (дзеркало функцій Python-бота):
 *   * розклад для студента (групи кафедри + пошук) та викладача (за прізвищем);
 *   * періоди: сьогодні, завтра, поточний/наступний тиждень, дата, місяць,
 *     довільний період;
 *   * кнопка «Оновити» — повторне читання дзеркала поверх кешу;
 *   * позначка «дані станом на …» і попередження, якщо знімок застарів;
 *   * адмін-панель /admin: статистика, інформація про дзеркало, розсилка.
 *
 * Сховище — Cloudflare D1 (див. schema.sql): стан діалогу й облік користувачів.
 *
 * Змінні середовища (wrangler.toml [vars]):
 *   BOT_USERNAME, ADMIN_USERNAME, ADMIN_IDS ("123,456"), DATA_BASE,
 *   STALE_HOURS (необов'язково, типово 30), MAX_PERIOD_DAYS (типово 92),
 *   SETUP_KEY (для /setup — реєстрації вебхука),
 *   GOOGLE_CLIENT_ID — OAuth Client ID для входу викладачів на сайті,
 *   ALLOWED_DOMAIN — корпоративний домен (типово "udu.edu.ua"),
 *   ADMIN_EMAILS — email-адреси адміністраторів сайту через кому,
 *   SITE_ORIGIN — адреса сайту для CORS (або "*").
 * Секрети (wrangler secret put ...):
 *   BOT_TOKEN — токен бота від @BotFather (обов'язково)
 *   TG_SECRET — довільний рядок для перевірки вебхука (рекомендовано)
 *   SESSION_SECRET — ключ підпису сесій сайту (довільний довгий рядок)
 *
 * API для сайту (див. site/): /api/auth, /api/me, /api/bind, /api/unbind,
 * /api/links (публічне читання), /api/link (PUT/DELETE), /api/admin/*.
 */

const API = "https://api.telegram.org/bot";
const MAX_TG_LEN = 4000;

const PAIR_EMOJI = { "1": "1️⃣", "2": "2️⃣", "3": "3️⃣", "4": "4️⃣",
                     "5": "5️⃣", "6": "6️⃣", "7": "7️⃣", "8": "8️⃣" };
const LESSON_TYPES = {
  "Л": "Лекція", "Лаб": "Лабораторна", "Пр": "Практичне",
  "С": "Семінар", "Сем": "Семінар", "Конс": "Консультація",
  "К": "Консультація", "Екз": "Екзамен", "Ісп": "Іспит", "З": "Залік",
};
const DAY_SEP = "━━━━━━━━━━━━━━";
const BULLET = "▫️";

// ---------------------------------------------------------------------------
// Допоміжне: HTML, дати (Europe/Kyiv)
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Сьогодні за Києвом як ISO "YYYY-MM-DD". */
function kyivTodayISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function isoToDate(iso) { return new Date(iso + "T00:00:00Z"); }
function dateToISO(d) { return d.toISOString().slice(0, 10); }
function addDays(iso, n) {
  const d = isoToDate(iso); d.setUTCDate(d.getUTCDate() + n); return dateToISO(d);
}
function fmtISO(iso) { // "2026-11-21" -> "21.11.2026"
  const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`;
}
function fmtISOshort(iso) { // "2026-11-21" -> "21.11"
  const [y, m, d] = iso.split("-"); return `${d}.${m}`;
}
function weekBounds(iso) {
  const d = isoToDate(iso);
  const wd = (d.getUTCDay() + 6) % 7; // 0 = понеділок
  const mon = new Date(d); mon.setUTCDate(mon.getUTCDate() - wd);
  const sun = new Date(mon); sun.setUTCDate(sun.getUTCDate() + 6);
  return [dateToISO(mon), dateToISO(sun)];
}
function monthBounds(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return [dateToISO(first), dateToISO(last)];
}

/** "2026-11-21T09:07:05+02:00" -> "21.11.2026 09:07" */
function fmtStamp(stamp) {
  const m = String(stamp).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : String(stamp);
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

async function tg(env, method, payload) {
  const resp = await fetch(API + env.BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return resp.json().catch(() => ({}));
}

const send = (env, chatId, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML",
                           disable_web_page_preview: true, ...extra });
const edit = (env, chatId, msgId, text, extra = {}) =>
  tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, text,
                               parse_mode: "HTML",
                               disable_web_page_preview: true, ...extra });
const answerCb = (env, cbId, text) =>
  tg(env, "answerCallbackQuery", { callback_query_id: cbId, ...(text ? { text, show_alert: true } : {}) });

/** Редагує повідомлення; якщо не вдалося (старе/однакове) — шле нове. */
async function editOrSend(env, chatId, msgId, text, extra = {}) {
  const r = await edit(env, chatId, msgId, text, extra);
  if (!r.ok) await send(env, chatId, text, extra);
}

const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });

// ---------------------------------------------------------------------------
// Стан діалогу й користувачі (D1)
// ---------------------------------------------------------------------------

async function getState(env, chatId) {
  const row = await env.DB.prepare("SELECT data FROM state WHERE chat_id = ?")
    .bind(String(chatId)).first();
  return row ? JSON.parse(row.data) : {};
}

async function setState(env, chatId, state) {
  try {
    await env.DB.prepare(
      "INSERT INTO state (chat_id, data, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data, " +
      "updated_at = excluded.updated_at")
      .bind(String(chatId), JSON.stringify(state), Date.now()).run();
  } catch (e) { console.error("state write failed:", e); }
}

async function touchUser(env, user, incQuery = false) {
  if (!user) return;
  try {
    const now = new Date().toISOString();
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
    await env.DB.prepare(
      `INSERT INTO users (user_id, username, name, first_seen, last_seen, queries)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username, name = excluded.name,
         last_seen = excluded.last_seen,
         queries = users.queries + excluded.queries`)
      .bind(String(user.id), user.username || "", name, now, now,
            incQuery ? 1 : 0).run();
  } catch (e) { console.error("user touch failed:", e); }
}

async function userStats(env) {
  const total = await env.DB.prepare("SELECT COUNT(*) c FROM users").first();
  const today = await env.DB.prepare(
    "SELECT COUNT(*) c FROM users WHERE last_seen >= ?")
    .bind(new Date().toISOString().slice(0, 10)).first();
  const queries = await env.DB.prepare(
    "SELECT COALESCE(SUM(queries),0) q FROM users").first();
  return { total: total.c, active_today: today.c, queries: queries.q };
}

// ---------------------------------------------------------------------------
// Дзеркало даних (з edge-кешем)
// ---------------------------------------------------------------------------

async function fetchJson(env, path, bust = false) {
  const url = env.DATA_BASE.replace(/\/+$/, "") + "/" + path;
  const cache = caches.default;
  const req = new Request(url);
  if (!bust) {
    const hit = await cache.match(req);
    if (hit) return hit.json();
  }
  const resp = await fetch(url, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!resp.ok) throw new Error(`дзеркало: HTTP ${resp.status} для ${path}`);
  if (resp.ok) await cache.put(req, resp.clone());
  return resp.json();
}

const getMeta = (env, bust) => fetchJson(env, "meta.json", bust);
const getGroups = (env) => fetchJson(env, "groups.json");
const getTeachers = (env) => fetchJson(env, "teachers.json");
const getEntity = (env, file, bust) => fetchJson(env, "schedules/" + file, bust);

async function findEntity(env, kind, name) {
  const list = kind === "group" ? await getGroups(env) : await getTeachers(env);
  return list.find((e) => e.n === name) || null;
}

/** Вік дзеркала в годинах (NaN, якщо не вдалося розібрати). */
function mirrorAgeHours(meta) {
  const t = Date.parse(meta.updated_at);
  return Number.isNaN(t) ? NaN : (Date.now() - t) / 36e5;
}

// ---------------------------------------------------------------------------
// Форматування розкладу
// ---------------------------------------------------------------------------

function fmtLesson(ls, kind) {
  const num = PAIR_EMOJI[ls.n] || `${ls.n}️⃣`;
  const lines = [`${num} <b>${esc(ls.ts)} – ${esc(ls.te)}</b>`,
                 `📘 <b>${esc(ls.s)}</b>`];
  const tail = [];
  if (ls.t) tail.push(`${BULLET} ${esc(LESSON_TYPES[ls.t] || ls.t)}`);
  // для групи показуємо викладача, для викладача — групи
  const who = kind === "group" ? ls.w : (ls.g || ls.w);
  if (who) tail.push(`${kind === "group" ? "👤" : "👥"} ${esc(who)}`);
  if (tail.length) lines.push(tail.join("  ·  "));
  if (ls.l) {
    const tag = ls._manual ? " ✍️ <i>(посилання від викладача)</i>" : "";
    lines.push(`🔗 <a href="${esc(ls.l)}">Приєднатися до заняття</a>${tag}`);
  }
  return lines.join("\n");
}

function fmtDay(day, kind) {
  const head = `🗓 <b>${esc(day.wd.toUpperCase())} · ${fmtISO(day.d)}</b>`;
  const body = day.lessons.map((ls) => fmtLesson(ls, kind)).join("\n\n");
  return body ? `${head}\n\n${body}` : head;
}

function fmtPeriod(days, kind, title) {
  if (!days.length) return [`${title}\n\n✨ <b>Занять немає</b> — вільний час!`];
  const messages = [];
  let current = title;
  for (const day of days) {
    const block = fmtDay(day, kind);
    const candidate = current + `\n\n${DAY_SEP}\n\n` + block;
    if (candidate.length > MAX_TG_LEN) { messages.push(current); current = block; }
    else current = candidate;
  }
  messages.push(current);
  return messages;
}

function header(state, periodText) {
  const line2 = state.kind === "group"
    ? `👨‍🎓 Група <b>${esc(state.name)}</b>` : `👩‍🏫 <b>${esc(state.name)}</b>`;
  return `🏛 <b>Кафедра професійної освіти</b>\n${line2}  ·  ${periodText}`;
}

// ---------------------------------------------------------------------------
// Клавіатури
// ---------------------------------------------------------------------------

function kbRoles(isAdmin) {
  const rows = [[btn("👨‍🎓 Я студент", "role:student"),
                 btn("👩‍🏫 Я викладач", "role:teacher")]];
  if (isAdmin) rows.push([btn("🛠 Адмін-панель", "a:panel")]);
  return kb(rows);
}

function kbGroups(groups) {
  const rows = [];
  let row = [];
  groups.forEach((g, i) => {
    row.push(btn(g.n, `g:${i}`));
    if (row.length === 3) { rows.push(row); row = []; }
  });
  if (row.length) rows.push(row);
  rows.push([btn("⬅️ Назад", "nav:start")]);
  return kb(rows);
}

function kbMatches(matches) {
  const rows = matches.map((m, i) => [btn(m, `m:${i}`)]);
  rows.push([btn("⬅️ Назад", "nav:start")]);
  return kb(rows);
}

const kbPeriods = () => kb([
  [btn("📅 Сьогодні", "p:today"), btn("📅 Завтра", "p:tomorrow")],
  [btn("🗓 Цей тиждень", "p:week"), btn("🗓 Наступний тиждень", "p:nextweek")],
  [btn("📆 Дата…", "p:date"), btn("📚 Місяць…", "p:month")],
  [btn("⏳ Свій період…", "p:period")],
  [btn("🔁 Змінити групу/викладача", "nav:start")],
]);

const kbAfterResult = () => kb([
  [btn("🔄 Оновити", "p:refresh"), btn("⬅️ Меню періодів", "p:menu")],
]);

const kbAdmin = () => kb([
  [btn("📊 Статистика", "a:stats")],
  [btn("🗄 Дані дзеркала", "a:mirror"), btn("📢 Розсилка", "a:broadcast")],
  [btn("❌ Закрити", "a:close")],
]);

const kbBackAdmin = kb([[btn("⬅️ До адмін-панелі", "a:panel")]]);

// ---------------------------------------------------------------------------
// Безпека
// ---------------------------------------------------------------------------

function isAdmin(env, user) {
  if (!user) return false;
  const ids = (env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.includes(String(user.id))) return true;
  return (user.username || "").toLowerCase() ===
         (env.ADMIN_USERNAME || "").toLowerCase();
}

async function denyAdmin(env, chatId, msgId) {
  await editOrSend(env, chatId, msgId,
    "⛔️ <b>Доступ заборонено</b>\n\nАдмін-панель доступна лише адміністратору бота.");
}

// ---------------------------------------------------------------------------
// Виконання запиту розкладу
// ---------------------------------------------------------------------------

function mirrorNote(meta, env) {
  const age = mirrorAgeHours(meta);
  const staleLimit = Number(env.STALE_HOURS || 30);
  let note = `\n\n<i>🗄 Дані станом на ${esc(fmtStamp(meta.updated_at))} (дзеркало)</i>`;
  if (!Number.isNaN(age) && age > staleLimit) {
    note += `\n⚠️ <i>Знімок застарів (> ${staleLimit} год): сервер університету, ` +
            "імовірно, був недоступний. Розклад міг змінитися.</i>";
  }
  return note;
}

/** Спільна логіка: дістати дні з дзеркала, відфільтрувати, показати. */
async function runQuery(env, chatId, msgId, state, d1, d2, title, bust = false) {
  state.last_range = [d1, d2, title];
  await setState(env, chatId, state);
  await touchUser(env, { id: chatId }, true);

  let entity, meta;
  try {
    [entity, meta] = await Promise.all([
      findEntity(env, state.kind, state.name), getMeta(env, bust)]);
    if (!entity) throw new Error("сутність відсутня у дзеркалі");
    var data = await getEntity(env, entity.f, bust);
  } catch (e) {
    console.error("runQuery:", e);
    const text = "⚠️ <b>Дзеркало розкладу тимчасово недоступне</b>\n\n" +
                 "Спробуйте, будь ласка, за кілька хвилин.";
    if (msgId) await editOrSend(env, chatId, msgId, text, { reply_markup: kbAfterResult() });
    else await send(env, chatId, text, { reply_markup: kbAfterResult() });
    return;
  }

  const days = (data.days || []).filter((d) => d.d >= d1 && d.d <= d2);
  await mergeManualLinks(env, state, days, d1, d2);
  let titleFull = title + mirrorNote(meta, env);
  if (meta.from && (d1 < meta.from || d2 > meta.to)) {
    titleFull += `\n<i>ℹ️ Дзеркало охоплює ${fmtISO(meta.from)} – ${fmtISO(meta.to)}</i>`;
  }
  const messages = fmtPeriod(days, state.kind, titleFull);

  if (msgId) {
    for (const extra of messages.slice(0, -1)) await send(env, chatId, extra);
    await editOrSend(env, chatId, msgId, messages[messages.length - 1],
                     { reply_markup: kbAfterResult() });
  } else {
    for (const m of messages.slice(0, -1)) await send(env, chatId, m);
    await send(env, chatId, messages[messages.length - 1],
               { reply_markup: kbAfterResult() });
  }
}

async function showPeriodMenu(env, chatId, msgId, state) {
  const label = state.kind === "group"
    ? `✅ Група <b>${esc(state.name)}</b>` : `✅ Викладач <b>${esc(state.name)}</b>`;
  await editOrSend(env, chatId, msgId,
    `${label}\n\nОберіть період перегляду 👇`, { reply_markup: kbPeriods() });
}

// ---------------------------------------------------------------------------
// Обробники оновлень
// ---------------------------------------------------------------------------

const DATE_RE = /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/g;

function parseOneDate(text) {
  const m = /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/.exec(text);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return d.getUTCDate() === +m[1] ? dateToISO(d) : null;
}

async function cmdStart(env, chatId, msgId, user) {
  await setState(env, chatId, {});
  const text =
    "👋 <b>Вітаю!</b>\n\n" +
    "Я — бот розкладу <b>кафедри професійної освіти</b> " +
    "УДУ імені Михайла Драгоманова.\n\n" +
    "<b>Мої можливості:</b>\n" +
    `${BULLET} розклад на сьогодні, завтра чи тиждень\n` +
    `${BULLET} будь-яка дата, місяць або свій період\n` +
    `${BULLET} працюю навіть коли сервер університету вимкнений — ` +
    "читаю резервну копію 🔄\n\n" +
    "<b>Оберіть, хто ви</b> 👇";
  const markup = kbRoles(isAdmin(env, user));
  if (msgId) await editOrSend(env, chatId, msgId, text, { reply_markup: markup });
  else await send(env, chatId, text, { reply_markup: markup });
}

async function cmdHelp(env, chatId) {
  await send(env, chatId,
    "ℹ️ <b>Як користуватися</b>\n\n" +
    "1️⃣ /start — оберіть: 👨‍🎓 студент чи 👩‍🏫 викладач.\n" +
    "2️⃣ Студент обирає групу зі списку; викладач вводить прізвище.\n" +
    "3️⃣ Обирайте період: сьогодні, завтра, тиждень, дату, місяць " +
    "або ⏳ свій період.\n\n" +
    "🔄 <b>Звідки дані.</b> Бот читає резервну копію розкладу (дзеркало), " +
    "яка оновлюється кілька разів на день, — тому працює навіть під час " +
    "вимкнення серверів університету. Під кожним розкладом вказано час " +
    "останнього оновлення копії.\n\n" +
    "Команди: /start — почати спочатку · /help — довідка.");
}

async function onCallback(env, cq) {
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const user = cq.from;
  const data = cq.data || "";
  const state = await getState(env, chatId);
  await answerCb(env, cq.id);
  await touchUser(env, user);

  // ============================ АДМІНКА =================================
  if (data.startsWith("a:")) {
    if (!isAdmin(env, user)) return denyAdmin(env, chatId, msgId);
    const action = data.slice(2);

    if (action === "panel") {
      await editOrSend(env, chatId, msgId,
        "🛠 <b>Адмін-панель</b>\n\nОберіть дію 👇", { reply_markup: kbAdmin() });
      return;
    }
    if (action === "stats") {
      const st = await userStats(env);
      await editOrSend(env, chatId, msgId,
        "📊 <b>Статистика бота</b>\n\n" +
        `👥 Користувачів усього: <b>${st.total}</b>\n` +
        `🟢 Активних сьогодні: <b>${st.active_today}</b>\n` +
        `🔍 Запитів розкладу: <b>${st.queries}</b>`,
        { reply_markup: kbBackAdmin });
      return;
    }
    if (action === "mirror") {
      try {
        const meta = await getMeta(env, true);
        const age = mirrorAgeHours(meta);
        await editOrSend(env, chatId, msgId,
          "🗄 <b>Дзеркало розкладу</b>\n\n" +
          `▫️ Оновлено: <b>${esc(fmtStamp(meta.updated_at))}</b> ` +
          `(${Number.isNaN(age) ? "?" : age.toFixed(1)} год тому)\n` +
          `▫️ Горизонт: ${fmtISO(meta.from)} – ${fmtISO(meta.to)}\n` +
          `▫️ Груп: <b>${meta.groups}</b> · Викладачів: <b>${meta.teachers}</b>\n` +
          `▫️ Помилок останньої синхронізації: <b>${meta.failed}</b>`,
          { reply_markup: kbBackAdmin });
      } catch (e) {
        await editOrSend(env, chatId, msgId, "⚠️ Дзеркало недоступне.",
                         { reply_markup: kbBackAdmin });
      }
      return;
    }
    if (action === "broadcast") {
      state.awaiting = "broadcast";
      await setState(env, chatId, state);
      await editOrSend(env, chatId, msgId,
        "📢 <b>Розсилка</b>\n\n" +
        "Надішліть текст оголошення — його отримають усі користувачі бота.\n" +
        "<i>Підтримується HTML-розмітка Telegram.</i>",
        { reply_markup: kb([[btn("❌ Скасувати", "a:panel")]]) });
      return;
    }
    if (action === "close") {
      await tg(env, "deleteMessage", { chat_id: chatId, message_id: msgId });
      return;
    }
  }

  // ============================ НАВІГАЦІЯ ===============================
  if (data === "nav:start") return cmdStart(env, chatId, msgId, user);

  if (data === "role:student") {
    try {
      const groups = await getGroups(env);
      state.role = "student";
      state.kb = groups.map((g) => g.n);
      await setState(env, chatId, state);
      await editOrSend(env, chatId, msgId,
        "👨‍🎓 <b>Оберіть вашу групу</b> 👇\n\n" +
        `${BULLET} ПОцт — цифрові технології\n` +
        `${BULLET} ПОхт — харчові технології\n\n` +
        "<i>У дзеркалі — групи кафедри професійної освіти.</i>",
        { reply_markup: kbGroups(groups) });
    } catch (e) {
      await editOrSend(env, chatId, msgId,
        "⚠️ Дзеркало розкладу недоступне. Спробуйте пізніше.");
    }
    return;
  }

  if (data === "role:teacher") {
    state.role = "teacher";
    state.awaiting = "teacher_name";
    await setState(env, chatId, state);
    await editOrSend(env, chatId, msgId,
      "👩‍🏫 Введіть ваше <b>прізвище</b> (можна лише початок), " +
      "наприклад: <code>Ткаченко</code>",
      { reply_markup: kb([[btn("⬅️ Назад", "nav:start")]]) });
    return;
  }

  if (data.startsWith("g:")) {
    const idx = Number(data.slice(2));
    const name = (state.kb || [])[idx];
    if (!name) {
      await answerCb(env, cq.id, "Список застарів, повторіть /start");
      return;
    }
    state.kind = "group"; state.name = name; state.awaiting = null;
    await setState(env, chatId, state);
    await showPeriodMenu(env, chatId, msgId, state);
    return;
  }

  if (data.startsWith("m:")) {
    const idx = Number(data.slice(2));
    const name = (state.matches || [])[idx];
    if (!name) {
      await answerCb(env, cq.id, "Список застарів, повторіть пошук");
      return;
    }
    state.name = name; state.awaiting = null;
    await setState(env, chatId, state);
    await showPeriodMenu(env, chatId, msgId, state);
    return;
  }

  // ============================ ПЕРІОДИ =================================
  if (data.startsWith("p:")) {
    const action = data.slice(2);
    if (!state.name) return cmdStart(env, chatId, msgId, user);
    const today = kyivTodayISO();

    if (action === "menu") return showPeriodMenu(env, chatId, msgId, state);

    if (action === "refresh") {
      const rng = state.last_range;
      if (!rng) return showPeriodMenu(env, chatId, msgId, state);
      await runQuery(env, chatId, msgId, state, rng[0], rng[1], rng[2], true);
      return;
    }
    if (action === "today") {
      await runQuery(env, chatId, msgId, state, today, today,
        header(state, `📅 <b>Сьогодні, ${fmtISO(today)}</b>`));
      return;
    }
    if (action === "tomorrow") {
      const d = addDays(today, 1);
      await runQuery(env, chatId, msgId, state, d, d,
        header(state, `📅 <b>Завтра, ${fmtISO(d)}</b>`));
      return;
    }
    if (action === "week") {
      const [mon, sun] = weekBounds(today);
      await runQuery(env, chatId, msgId, state, mon, sun,
        header(state, `🗓 <b>${fmtISOshort(mon)}–${fmtISO(sun)}</b>`));
      return;
    }
    if (action === "nextweek") {
      const [mon, sun] = weekBounds(addDays(today, 7));
      await runQuery(env, chatId, msgId, state, mon, sun,
        header(state, `🗓 <b>${fmtISOshort(mon)}–${fmtISO(sun)}</b>`));
      return;
    }
    const ask = {
      date: ["📆 Введіть дату у форматі <b>дд.мм.рррр</b>\n" +
             `наприклад: <code>${fmtISO(today)}</code>`],
      month: ["📚 Введіть місяць у форматі <b>мм.рррр</b>\n" +
              `наприклад: <code>${fmtISO(today).slice(3)}</code>`],
      period: ["⏳ Введіть період у форматі\n<b>дд.мм.рррр - дд.мм.рррр</b>\n" +
               "наприклад: <code>01.03.2026 - 15.03.2026</code>"],
    }[action];
    if (ask) {
      state.awaiting = action;
      await setState(env, chatId, state);
      await editOrSend(env, chatId, msgId, ask[0],
        { reply_markup: kb([[btn("⬅️ Назад", "p:menu")]]) });
    }
    return;
  }
}

async function onMessage(env, msg, ctx) {
  const chatId = msg.chat.id;
  const user = msg.from;
  const text = (msg.text || "").trim();
  const state = await getState(env, chatId);
  await touchUser(env, user);

  if (text === "/start") return cmdStart(env, chatId, null, user);
  if (text === "/help") return cmdHelp(env, chatId);
  if (text === "/admin") {
    if (!isAdmin(env, user)) {
      await send(env, chatId,
        "⛔️ <b>Доступ заборонено</b>\n\nАдмін-панель доступна лише адміністратору бота.");
      return;
    }
    await send(env, chatId,
      `🛠 <b>Адмін-панель</b>\n\nВаш ID: <code>${user.id}</code>\n` +
      "<i>Переконайтеся, що він є в ADMIN_IDS у налаштуваннях Workers.</i>\n\n" +
      "Оберіть дію 👇", { reply_markup: kbAdmin() });
    return;
  }

  const awaiting = state.awaiting;

  // --- розсилка від адміна -------------------------------------------------
  if (awaiting === "broadcast") {
    if (!isAdmin(env, user)) return;
    state.awaiting = null;
    await setState(env, chatId, state);
    const status = await send(env, chatId, "📢 Розсилаю…");
    ctx.waitUntil((async () => {
      const { results } = await env.DB.prepare("SELECT user_id FROM users").all();
      let ok = 0, fail = 0;
      for (const row of results) {
        const r = await tg(env, "sendMessage",
          { chat_id: row.user_id, text, parse_mode: "HTML" });
        r.ok ? ok++ : fail++;
        await new Promise((res) => setTimeout(res, 50));
      }
      await edit(env, chatId, status.result.message_id,
        "📢 <b>Розсилку завершено</b>\n\n" +
        `✅ Доставлено: <b>${ok}</b>\n🚫 Не доставлено: <b>${fail}</b>`);
    })());
    return;
  }

  // --- прізвище викладача --------------------------------------------------
  if (awaiting === "teacher_name") {
    if (text.length < 3) {
      await send(env, chatId, "Введіть щонайменше 3 літери прізвища.");
      return;
    }
    const teachers = await getTeachers(env);
    const needle = text.toLowerCase();
    const matches = teachers.map((t) => t.n)
      .filter((n) => n.toLowerCase().includes(needle)).slice(0, 10);
    if (!matches.length) {
      await send(env, chatId,
        `😕 Викладача «${esc(text)}» не знайдено.\n` +
        "Перевірте написання та спробуйте ще раз.");
      return;
    }
    state.kind = "teacher"; state.matches = matches; state.awaiting = null;
    await setState(env, chatId, state);
    await send(env, chatId, "Знайдено 👇 Оберіть себе:",
               { reply_markup: kbMatches(matches) });
    return;
  }

  // --- дата / місяць / період ---------------------------------------------
  const finish = () => { state.awaiting = null; };

  if (awaiting === "date") {
    const d = parseOneDate(text);
    if (!d) {
      await send(env, chatId,
        "⚠️ Невірний формат або такої дати не існує.\n" +
        "Введіть як <b>дд.мм.рррр</b>, наприклад: <code>05.03.2026</code>");
      return;
    }
    finish();
    await runQuery(env, chatId, null, state, d, d,
      header(state, `📆 <b>${fmtISO(d)}</b>`));
    return;
  }

  if (awaiting === "month") {
    const m = /^(\d{1,2})[.\-/](\d{4})$/.exec(text);
    if (!m || +m[1] < 1 || +m[1] > 12) {
      await send(env, chatId,
        "⚠️ Невірний формат. Введіть місяць як <b>мм.рррр</b>, " +
        "наприклад: <code>03.2026</code>");
      return;
    }
    finish();
    const [first, last] = monthBounds(+m[2], +m[1]);
    await runQuery(env, chatId, null, state, first, last,
      header(state, `📚 <b>${m[1].padStart(2, "0")}.${m[2]}</b>`));
    return;
  }

  if (awaiting === "period") {
    DATE_RE.lastIndex = 0;
    const found = [...text.matchAll(DATE_RE)];
    if (found.length !== 2) {
      await send(env, chatId,
        "⚠️ Потрібні дві дати через дефіс:\n<b>дд.мм.рррр - дд.мм.рррр</b>\n" +
        "наприклад: <code>01.03.2026 - 15.03.2026</code>");
      return;
    }
    let d1 = parseOneDate(found[0][0]), d2 = parseOneDate(found[1][0]);
    if (!d1 || !d2) {
      await send(env, chatId, "⚠️ Однієї з дат не існує. Спробуйте ще раз.");
      return;
    }
    if (d2 < d1) [d1, d2] = [d2, d1];
    const maxDays = Number(env.MAX_PERIOD_DAYS || 92);
    if ((isoToDate(d2) - isoToDate(d1)) / 864e5 > maxDays) {
      await send(env, chatId,
        `⚠️ Занадто довгий період — максимум <b>${maxDays} дні</b>.`);
      return;
    }
    finish();
    await runQuery(env, chatId, null, state, d1, d2,
      header(state, `⏳ <b>${fmtISO(d1)} – ${fmtISO(d2)}</b>`));
    return;
  }

  await send(env, chatId,
    "Натисніть /start, щоб обрати групу чи викладача, або /help для довідки.");
}

// ---------------------------------------------------------------------------
// Сесії сайту (HMAC-підписаний токен)
// ---------------------------------------------------------------------------

const te = new TextEncoder();

function b64url(input) {
  const bytes = typeof input === "string" ? te.encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, te.encode(data));
}

/** Видати сесійний токен на 30 днів. */
async function makeToken(env, email) {
  const payload = b64url(JSON.stringify({ email, exp: Date.now() + 30 * 864e5 }));
  const sig = b64url(await hmacSign(env.SESSION_SECRET, payload));
  return `${payload}.${sig}`;
}

/** Перевірити токен із заголовка Authorization: Bearer. Повертає email або null. */
async function readSession(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  if (!env.SESSION_SECRET) return null;
  const expected = b64url(await hmacSign(env.SESSION_SECRET, payload));
  if (expected !== sig) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return data.exp > Date.now() ? data.email : null;
  } catch { return null; }
}

/** Перевірити Google ID token і домен. Повертає email або null. */
async function verifyGoogle(env, idToken) {
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" +
                        encodeURIComponent(idToken));
  if (!r.ok) return null;
  const p = await r.json();
  if (!env.GOOGLE_CLIENT_ID || p.aud !== env.GOOGLE_CLIENT_ID) return null;
  const domain = (env.ALLOWED_DOMAIN || "udu.edu.ua").toLowerCase();
  const email = (p.email || "").toLowerCase();
  if (!email.endsWith("@" + domain)) return null;
  if (String(p.email_verified) !== "true") return null;
  return email;
}

function isAdminEmail(env, email) {
  const list = (env.ADMIN_EMAILS || "").toLowerCase().split(",")
    .map((s) => s.trim()).filter(Boolean);
  return list.includes((email || "").toLowerCase());
}

// ---------------------------------------------------------------------------
// HTTP API для сайту
// ---------------------------------------------------------------------------

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.SITE_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function jsonResp(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

async function getBinding(env, email) {
  // лише ПІДТВЕРДЖЕНА прив'язка дає право редагувати
  const row = await env.DB.prepare(
    "SELECT teacher FROM bindings WHERE email = ? AND status = 'approved'")
    .bind(email).first();
  return row ? row.teacher : null;
}

async function getBindingFull(env, email) {
  const row = await env.DB.prepare(
    "SELECT teacher, status FROM bindings WHERE email = ?")
    .bind(email).first();
  return row || null;
}

const ISO_D_RE = /^\d{4}-\d{2}-\d{2}$/;

function validLinkInput(body) {
  if (!body || !ISO_D_RE.test(body.d || "")) return "дата має бути у форматі YYYY-MM-DD";
  const pair = String(body.pair || "").trim();
  if (!pair || pair.length > 8) return "невірний номер пари";
  const url = String(body.url || "").trim();
  if (!/^https?:\/\/.{3,490}$/.test(url)) return "посилання має починатися з http(s)://";
  const today = kyivTodayISO();
  if (body.d < addDays(today, -30) || body.d > addDays(today, 180)) {
    return "дата поза допустимим діапазоном";
  }
  return null;
}

async function handleApi(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }
  const path = url.pathname;
  const method = request.method;

  // --- вхід через Google ---------------------------------------------------
  if (path === "/api/auth" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const email = await verifyGoogle(env, body.id_token || "");
    if (!email) {
      return jsonResp(env, { error: "Вхід лише з корпоративної пошти @" +
                              (env.ALLOWED_DOMAIN || "udu.edu.ua") }, 403);
    }
    const token = await makeToken(env, email);
    const binding = await getBindingFull(env, email);
    return jsonResp(env, { token, email,
                           teacher: binding && binding.status === "approved"
                                    ? binding.teacher : null,
                           pending_teacher: binding && binding.status === "pending"
                                            ? binding.teacher : null,
                           is_admin: isAdminEmail(env, email) });
  }

  // --- публічне читання ручних посилань ------------------------------------
  if (path === "/api/links" && method === "GET") {
    const from = url.searchParams.get("from") || addDays(kyivTodayISO(), -30);
    const to = url.searchParams.get("to") || addDays(kyivTodayISO(), 90);
    const { results } = await env.DB.prepare(
      "SELECT teacher, d, pair, url, note, by_email, updated_at FROM links " +
      "WHERE d BETWEEN ? AND ?").bind(from, to).all();
    return jsonResp(env, { links: results });
  }

  // --- далі лише для автентифікованих ---------------------------------------
  const email = await readSession(env, request);
  if (!email) return jsonResp(env, { error: "Потрібен вхід" }, 401);
  const admin = isAdminEmail(env, email);

  if (path === "/api/me" && method === "GET") {
    const binding = await getBindingFull(env, email);
    return jsonResp(env, { email,
                           teacher: binding && binding.status === "approved"
                                    ? binding.teacher : null,
                           pending_teacher: binding && binding.status === "pending"
                                            ? binding.teacher : null,
                           is_admin: admin });
  }

  // --- прив'язка email ↔ ПІБ -------------------------------------------------
  if (path === "/api/bind" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const teacher = String(body.teacher || "").trim();
    const teachers = await getTeachers(env);
    if (!teachers.some((t) => t.n === teacher)) {
      return jsonResp(env, { error: "Викладача немає в довіднику розкладу" }, 400);
    }
    const owner = await env.DB.prepare(
      "SELECT email FROM bindings WHERE teacher = ?").bind(teacher).first();
    if (owner && owner.email !== email) {
      return jsonResp(env, { error: "Це прізвище вже прив'язане до іншої пошти. " +
                             "Зверніться до адміністратора." }, 409);
    }
    // нова або змінена прив'язка завжди потребує підтвердження адміністратором
    await env.DB.prepare(
      "INSERT INTO bindings (email, teacher, status, created_at) " +
      "VALUES (?, ?, 'pending', ?) " +
      "ON CONFLICT(email) DO UPDATE SET teacher = excluded.teacher, " +
      "status = 'pending', created_at = excluded.created_at")
      .bind(email, teacher, new Date().toISOString()).run();
    return jsonResp(env, { ok: true, teacher, status: "pending",
                           message: "Заявку надіслано адміністратору" });
  }

  if (path === "/api/unbind" && method === "POST") {
    await env.DB.prepare("DELETE FROM bindings WHERE email = ?").bind(email).run();
    return jsonResp(env, { ok: true });
  }

  // --- адміністрування прив'язок ---------------------------------------------
  if (path === "/api/admin/bindings" && method === "GET") {
    if (!admin) return jsonResp(env, { error: "Лише для адміністратора" }, 403);
    const { results } = await env.DB.prepare(
      "SELECT email, teacher, status, created_at FROM bindings " +
      "ORDER BY status DESC, teacher").all();  // спочатку 'pending'
    return jsonResp(env, { bindings: results });
  }

  if (path === "/api/admin/approve" && method === "POST") {
    if (!admin) return jsonResp(env, { error: "Лише для адміністратора" }, 403);
    const body = await request.json().catch(() => ({}));
    await env.DB.prepare(
      "UPDATE bindings SET status = 'approved' WHERE teacher = ?")
      .bind(String(body.teacher || "")).run();
    return jsonResp(env, { ok: true });
  }

  if (path === "/api/admin/unbind" && method === "POST") {
    if (!admin) return jsonResp(env, { error: "Лише для адміністратора" }, 403);
    const body = await request.json().catch(() => ({}));
    await env.DB.prepare("DELETE FROM bindings WHERE email = ?")
      .bind(String(body.email || "")).run();
    return jsonResp(env, { ok: true });
  }

  // --- додати/змінити посилання ----------------------------------------------
  if (path === "/api/link" && (method === "PUT" || method === "POST")) {
    const body = await request.json().catch(() => ({}));
    const err = validLinkInput(body);
    if (err) return jsonResp(env, { error: err }, 400);
    const teacher = admin && body.teacher
      ? String(body.teacher).trim() : await getBinding(env, email);
    if (!teacher) {
      return jsonResp(env, { error: "Спочатку прив'яжіть своє прізвище " +
                             "(кнопка «Це я» у своєму розкладі)" }, 409);
    }
    await env.DB.prepare(
      "INSERT INTO links (teacher, d, pair, url, note, by_email, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(teacher, d, pair) DO UPDATE SET url = excluded.url, " +
      "note = excluded.note, by_email = excluded.by_email, " +
      "updated_at = excluded.updated_at")
      .bind(teacher, body.d, String(body.pair).trim(), String(body.url).trim(),
            String(body.note || "").trim(), email, new Date().toISOString()).run();
    return jsonResp(env, { ok: true });
  }

  if (path === "/api/link" && method === "DELETE") {
    const body = await request.json().catch(() => ({}));
    const teacher = admin && body.teacher
      ? String(body.teacher).trim() : await getBinding(env, email);
    if (!teacher) return jsonResp(env, { error: "Немає прив'язки" }, 409);
    await env.DB.prepare("DELETE FROM links WHERE teacher = ? AND d = ? AND pair = ?")
      .bind(teacher, String(body.d || ""), String(body.pair || "")).run();
    return jsonResp(env, { ok: true });
  }

  return jsonResp(env, { error: "not found" }, 404);
}

// ---------------------------------------------------------------------------
// Ручні посилання → накладання на розклад у боті
// ---------------------------------------------------------------------------

/** Прізвище з рядка виду "ст. викладач Антоневич Б.Р.". */
function surnameFromWho(who) {
  const tokens = String(who || "").trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (/^[А-ЩЮЯЇІЄҐ][а-щьюяїієґ']+\.[А-ЩЮЯЇІЄҐ]\.?$/.test(tokens[i]) ||
        /^[А-ЩЮЯЇІЄҐ]\.[А-ЩЮЯЇІЄҐ]\.$/.test(tokens[i])) {
      if (i > 0) return tokens[i - 1];
    }
  }
  return tokens.length >= 2 ? tokens[tokens.length - 2] : (tokens[0] || "");
}

/** Підтягнути ручні посилання з D1 і накласти на дні розкладу (in-place). */
async function mergeManualLinks(env, state, days, d1, d2) {
  if (!days.length) return;
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      "SELECT teacher, d, pair, url FROM links WHERE d BETWEEN ? AND ?")
      .bind(d1, d2).all());
  } catch (e) { console.error("links read failed:", e); return; }
  if (!rows.length) return;

  // мапа прізвище → повне ПІБ (для розкладу групи, де є лише "… Антоневич Б.Р.")
  let surnameMap = null;
  if (state.kind === "group") {
    surnameMap = {};
    try {
      for (const t of await getTeachers(env)) {
        surnameMap[t.n.split(/\s+/)[0].toLowerCase()] = t.n;
      }
    } catch { /* без мапи — просто пропустимо групи */ }
  }

  const byKey = {};
  for (const r of rows) byKey[`${r.teacher}|${r.d}|${r.pair}`] = r.url;

  for (const day of days) {
    for (const ls of day.lessons) {
      let teacher = null;
      if (state.kind === "teacher") teacher = state.name;
      else if (surnameMap) {
        teacher = surnameMap[surnameFromWho(ls.w).toLowerCase()] || null;
      }
      if (!teacher) continue;
      const url2 = byKey[`${teacher}|${day.d}|${ls.n}`];
      if (url2) { ls.l = url2; ls._manual = true; }
    }
  }
}

// ---------------------------------------------------------------------------
// Точка входу
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // HTTP API для сайту (вхід викладачів, ручні посилання)
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        console.error("api failed:", e);
        return jsonResp(env, { error: "Внутрішня помилка сервера" }, 500);
      }
    }

    // Сервісна сторінка
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        "Schedule bot (дзеркало розкладу УДУ) працює. " +
        "Вебхук: POST /webhook", { status: 200 });
    }

    // Реєстрація вебхука: GET /setup?key=<SETUP_KEY>
    if (url.pathname === "/setup" && request.method === "GET") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const hookUrl = `https://${url.hostname}/webhook`;
      const r = await tg(env, "setWebhook", {
        url: hookUrl,
        secret_token: env.TG_SECRET || undefined,
        drop_pending_updates: true,
        allowed_updates: ["message", "callback_query"],
      });
      return Response.json({ webhook: hookUrl, telegram: r });
    }

    if (url.pathname !== "/webhook" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    // Перевірка секретного токена вебхука
    if (env.TG_SECRET &&
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    let update;
    try { update = await request.json(); }
    catch { return new Response("bad request", { status: 400 }); }

    try {
      if (update.callback_query) {
        await onCallback(env, update.callback_query);
      } else if (update.message) {
        await onMessage(env, update.message, ctx);
      }
    } catch (e) {
      console.error("update failed:", e, JSON.stringify(update).slice(0, 500));
    }
    return new Response("ok", { status: 200 });
  },
};
