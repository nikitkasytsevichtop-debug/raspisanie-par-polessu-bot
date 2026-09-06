const INDEX_KEY = 'ruz:chats';
const CARD_PREFIX = 'ruz:card:';
const SETTINGS_PREFIX = 'ruz:settings:';
const SNAPSHOT_KEY = 'ruz:snapshot';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cardKey(chatId) {
  return `${CARD_PREFIX}${chatId}`;
}

function settingsKey(chatId) {
  return `${SETTINGS_PREFIX}${chatId}`;
}

function parseJson(value) {
  if (!value) return null;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
}

// HGETALL в Upstash REST приходит плоским массивом [поле, значение, …], но
// прямое подключение может вернуть и объект. Принимаем обе формы.
function toObject(value) {
  if (!value) return {};
  if (!Array.isArray(value)) return typeof value === 'object' ? value : {};
  const result = {};
  for (let i = 0; i + 1 < value.length; i += 2) result[value[i]] = value[i + 1];
  return result;
}

// Настройки нормализуем на чтении, а не на записи: неизвестный вид или мусор
// в дате не должны доехать до callback_data — маршрутизация их не примет, и
// карточка перестала бы отвечать целиком, включая /start.
function parseSettings(raw) {
  const fields = toObject(raw);
  return {
    view: fields.view === 'w' ? 'w' : 'd',
    date: DATE_RE.test(String(fields.date || '')) ? String(fields.date) : null,
    // Отсутствие поля означает «включено»: чаты, заведённые до появления
    // переключателя, продолжают получать уведомления.
    notify: String(fields.notify ?? '1') !== '0',
  };
}

function parseCard(chatId, cardValue, settingsValue) {
  const card = parseJson(cardValue);
  const messageId = Number(card?.messageId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return null;
  return { chatId: String(chatId), messageId, ...parseSettings(settingsValue) };
}

function settingsFields({ view, date, notify }) {
  const fields = [];
  if (view) fields.push('view', view);
  if (date) fields.push('date', date);
  if (notify !== undefined) fields.push('notify', notify ? '1' : '0');
  return fields;
}

function createCardStore({ url, token, fetchFn = fetch }) {
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
  const endpoint = url.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function command(...args) {
    const response = await fetchFn(endpoint, { method: 'POST', headers, body: JSON.stringify(args) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.error) throw new Error(json.error || `Upstash Redis HTTP ${response.status}`);
    return json.result;
  }

  async function pipeline(commands) {
    const response = await fetchFn(`${endpoint}/pipeline`, { method: 'POST', headers, body: JSON.stringify(commands) });
    const json = await response.json().catch(() => []);
    if (!response.ok || !Array.isArray(json)) throw new Error(`Upstash Redis HTTP ${response.status}`);
    const error = json.find(item => item?.error)?.error;
    if (error) throw new Error(error);
    return json.map(item => item.result);
  }

  return {
    // Карточка и настройки лежат в разных ключах намеренно. /start переписывает
    // только id сообщения, кнопки — только настройки, поэтому одновременные
    // запросы не могут затереть чужой messageId. Карточка, потерявшая его,
    // стала бы «сообщением, которого нет»: фоновое обновление получило бы
    // message to edit not found, и чат молча выпал бы из рассылки.
    async save(chatId, messageId, settings = {}) {
      const id = String(chatId);
      if (!Number.isSafeInteger(Number(messageId)) || Number(messageId) < 1) throw new Error('messageId is invalid');
      const fields = settingsFields(settings);
      await pipeline([
        ['SET', cardKey(id), JSON.stringify({ messageId: Number(messageId) })],
        ...(fields.length ? [['HSET', settingsKey(id), ...fields]] : []),
        ['SADD', INDEX_KEY, id],
      ]);
    },

    // Частичная запись без предварительного чтения: настройки лежат хешем,
    // поэтому дата и вид обновляются, не задевая переключатель уведомлений.
    async patch(chatId, settings) {
      const fields = settingsFields(settings);
      if (!fields.length) return;
      await command('HSET', settingsKey(String(chatId)), ...fields);
    },

    async get(chatId) {
      const id = String(chatId);
      const [card, settings] = await pipeline([['GET', cardKey(id)], ['HGETALL', settingsKey(id)]]);
      return parseCard(id, card, settings);
    },

    async list() {
      const chatIds = await command('SMEMBERS', INDEX_KEY);
      if (!Array.isArray(chatIds) || !chatIds.length) return [];
      const values = await pipeline([
        ...chatIds.map(chatId => ['GET', cardKey(chatId)]),
        ...chatIds.map(chatId => ['HGETALL', settingsKey(chatId)]),
      ]);
      return chatIds
        .map((chatId, index) => parseCard(chatId, values[index], values[chatIds.length + index]))
        .filter(Boolean);
    },

    async remove(chatId) {
      const id = String(chatId);
      await pipeline([['DEL', cardKey(id)], ['DEL', settingsKey(id)], ['SREM', INDEX_KEY, id]]);
    },

    async getSnapshot() {
      return parseJson(await command('GET', SNAPSHOT_KEY));
    },

    async saveSnapshot(snapshot) {
      await command('SET', SNAPSHOT_KEY, JSON.stringify(snapshot));
    },
  };
}

function cardStore() {
  return createCardStore({
    // Интеграция Vercel Marketplace называет переменные KV_REST_API_*,
    // напрямую подключённая база Upstash — UPSTASH_REDIS_REST_*.
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  });
}

module.exports = { createCardStore, cardStore, parseSettings };
