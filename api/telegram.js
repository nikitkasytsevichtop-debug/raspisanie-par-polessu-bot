const { safeEqual } = require('../lib/auth');
const { tgApi, sendRichMessage, editRichMessage, answerCallbackQuery, deleteMessage } = require('../lib/telegram');
const { getSchedule } = require('../lib/schedule');
const { cardView, keyboard, render } = require('../lib/format');
const { cardStore } = require('../lib/card-store');

// Действие, дата и вид едут в callback_data целиком: у функции нет памяти между
// запросами, и кнопка обязана оставаться рабочей после любого холодного старта.
const ACTION_RE = /^([drvn]):(\d{4}-\d{2}-\d{2}):([dw])$/;

function isValidDate(date) {
  return Number.isFinite(Date.parse(`${date}T12:00:00Z`));
}

async function sendCommand(chatId, command) {
  if (command !== 'start' && command !== 'help') return null;
  const store = cardStore();
  // Запись чата и расписание друг от друга не зависят: последовательные
  // ожидания складывали бы задержку Redis и сайта на самом частом пути.
  const [existing, payload] = await Promise.all([store.get(chatId), getSchedule()]);
  // Дату намеренно не переносим из прошлой карточки: /start — это «покажи, что
  // сейчас», а не «верни меня туда, где я листал неделю назад». Вид карточки и
  // переключатель уведомлений при этом сохраняются.
  const view = cardView(payload, { view: existing?.view, notify: existing?.notify });
  // Старую карточку не редактируем, а пересоздаём: после очистки истории
  // «только у себя» она жива для бота, но невидима для пользователя — и
  // успешное редактирование выглядело бы как молчание в ответ на /start.
  const message = await sendRichMessage(chatId, view.html, view.replyMarkup);
  await store.save(chatId, message.message_id, {
    view: view.view,
    date: view.date,
    notify: existing?.notify !== false,
  });
  // Прошлую карточку удаляем последней: упади отправка раньше, в чате и в
  // хранилище осталась бы рабочая старая, а не ссылка на удалённое сообщение.
  if (existing) await deleteMessage(chatId, existing.messageId).catch(() => {});
  return message;
}

async function handleCallback(callback) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const data = String(callback.data || '');
  let toast;
  try {
    if (!chatId || !messageId) return;
    if (data === 'ack') {
      // «Ознакомлен» под сообщением об изменениях: удаляем его, чтобы чат не
      // зарастал. Сообщения старше 48 часов Telegram удалять не даёт.
      await deleteMessage(chatId, messageId).catch(() => {
        toast = 'Сообщение старше 48 часов — удалите его вручную';
      });
      return;
    }
    const match = ACTION_RE.exec(data);
    if (!match || !isValidDate(match[2])) {
      // Кнопка из карточки прошлой версии: перерисовать её нечем, зато можно
      // объяснить, что делать.
      toast = 'Кнопка устарела — отправьте /start';
      return;
    }
    const [, action, date, view] = match;
    const store = cardStore();
    const [existing, payload] = await Promise.all([
      store.get(chatId),
      getSchedule({ force: action === 'r' }),
    ]);
    const nextView = action === 'v' ? (view === 'w' ? 'd' : 'w') : view;
    const wasNotifying = existing?.notify !== false;
    const notify = action === 'n' ? !wasNotifying : wasNotifying;
    // Дату и вид сохраняем: фоновое обновление перерисовывает карточку и без
    // этого возвращало бы её на сегодняшний день, отменяя листание.
    const stored = await store.patch(chatId, {
      date,
      view: nextView,
      ...(action === 'n' ? { notify } : {}),
    }).then(() => true).catch(() => false);
    // Здесь рисуем именно выбранную дату, а не cardView: тот подтягивает
    // карточку на сегодня, и листать прошедшие дни стало бы невозможно.
    await editRichMessage(chatId, messageId, render(payload, date, nextView), keyboard(payload, date, nextView, notify));
    if (action === 'r') toast = 'Расписание обновлено ✓';
    // О незаписанном переключателе говорим прямо: промолчать нельзя, иначе
    // пользователь увидит новое состояние кнопки, которое через десять минут
    // само вернётся обратно.
    if (!stored) toast = action === 'n' ? 'Не сохранилось — попробуйте ещё раз' : 'День не сохранён — обновление вернёт сегодняшний';
    else if (action === 'n') toast = notify ? 'Уведомления включены 🔔' : 'Уведомления выключены 🔕';
  } finally {
    await answerCallbackQuery(callback.id, toast).catch(() => {});
  }
}

async function setup(req, res) {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error('APP_URL is not configured');
  const webhook = await tgApi('setWebhook', {
    url: `${appUrl.replace(/\/$/, '')}/api/telegram`,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  const commands = await tgApi('setMyCommands', {
    commands: [{ command: 'start', description: 'Открыть расписание' }],
  });
  // Описание снято намеренно: экран «Что умеет этот бот?» занимал бы весь чат
  // до первого /start. Пустая строка стирает ранее заданный текст.
  const description = await tgApi('setMyDescription', { description: '' });
  const shortDescription = await tgApi('setMyShortDescription', { short_description: '' });
  res.status(200).json({ ok: true, webhook, commands, description, shortDescription });
}

module.exports = async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!secret || !process.env.TELEGRAM_BOT_TOKEN || !redisUrl || !redisToken) {
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }
  // Секрет предпочтительно передавать заголовком — он не попадает в логи
  // запросов. Query-параметр оставлен для настройки из браузера; после неё
  // секрет стоит заменить.
  const setupToken = String(req.headers?.['x-setup-secret'] || '')
    || new URL(req.url || '/', `https://${req.headers?.host || 'localhost'}`).searchParams.get('setup') || '';
  if (req.method === 'GET' && safeEqual(setupToken, secret)) {
    try { await setup(req, res); } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
    return;
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!safeEqual(String(req.headers?.['x-telegram-bot-api-secret-token'] || ''), secret)) return res.status(401).json({ ok: false });

  try {
    const update = req.body || {};
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message?.text) {
      const match = /^\/([a-z_]+)(?:@(\w+))?(?:\s|$)/i.exec(update.message.text.trim());
      // Updates, адресованные другим ботам, сюда не поступают, поэтому не
      // запрашиваем getMe: это лишняя точка отказа на пути /start.
      if (match) await sendCommand(update.message.chat.id, match[1].toLowerCase());
    }
  } catch (error) {
    // После не-2xx Telegram повторит update: не создаём лавину дублей.
    console.error('[telegram] update failed:', error.message);
  }
  res.status(200).json({ ok: true });
};
