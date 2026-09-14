const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_WEBHOOK_SECRET = 'webhook-secret-for-tests-0123456789ab';
process.env.CHANGE_CHECK_SECRET = 'change-secret-for-tests-0123456789abc';
process.env.CRON_SECRET = 'cron-secret-for-tests-0123456789abcde';
process.env.APP_URL = 'https://bot.test';
process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-redis-token';

const { addDays, todayIso, weekStartOf } = require('../lib/schedule');
const EXTRA_LESSONS = require('../lib/extra-lessons');
const { buildPage, emptyPage, createFakeRedis } = require('./helpers');

const TODAY = todayIso();
const MONDAY = weekStartOf(TODAY);
const TUESDAY = addDays(MONDAY, 1);
const WEDNESDAY = addDays(MONDAY, 2);

// Расписание строим вокруг сегодняшнего дня: фикстура с зашитым семестром
// однажды уехала бы от «сегодня» на годы, и разбор выбрал бы другой год.
const LESSONS = [
  { weekday: 0, weeks: [0, 1], time: '8:30-9:50', subject: 'Физическая культура', kind: 'пр.', room: 'Спорткомплекс ПолесГУ', group: '24М-1' },
  { weekday: 0, weeks: [0, 1], time: '11:55-13:15', subject: 'Аквааэробика', kind: 'пр.', room: '31', group: '23ФК-1' },
  { weekday: 2, weeks: [0, 1], time: '10:05-11:25', subject: 'Информационный час', kind: '', room: '3507', group: '24ТД-1' },
];
// Настоящий шаблон СМГ привязан к датам семестра, а страницу тесты строят
// вокруг сегодняшнего дня: с ним итог зависел бы от календаря. Подменяем его
// своим на те же две недели и ставим на вторник, свободный на сайте.
EXTRA_LESSONS.splice(0, EXTRA_LESSONS.length, {
  from: MONDAY,
  to: addDays(MONDAY, 13),
  subject: 'Физическая культура',
  kind: 'пр.',
  room: 'Гребная база 1 (218 зал)',
  groups: { 'СМГ 18': 'вт 16:40' },
});
// Метка правки сайта — подвижная: сторож проверки смотрит именно на неё, и
// фикстура с застывшей меткой описывала бы сайт, которого не бывает.
let siteStamp = '01.09.2026 10:00';
let pageHtml = buildPage({ today: TODAY, lessons: LESSONS, updatedAt: siteStamp });
let siteFetches = 0;

// Сайт правит расписание и одновременно двигает метку — так это и происходит.
function publish(lessons, minute) {
  siteStamp = `01.09.2026 10:${String(minute).padStart(2, '0')}`;
  pageHtml = lessons === null ? emptyPage(siteStamp) : buildPage({ today: TODAY, lessons, updatedAt: siteStamp });
}

const redis = createFakeRedis();
const telegram = [];
let messageIdSeq = 100;

global.fetch = async (url, options = {}) => {
  const target = String(url);
  const ok = body => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
  if (target.startsWith('https://fake-redis.test/pipeline')) {
    return ok(JSON.parse(options.body).map(command => ({ result: redis.run(command) })));
  }
  if (target.startsWith('https://fake-redis.test')) return ok({ result: redis.run(JSON.parse(options.body)) });
  if (target.includes('api.telegram.org')) {
    // Счётчик сквозной, а не длина массива: тесты чистят его между собой,
    // и id сообщений начали бы повторяться.
    const messageId = ++messageIdSeq;
    telegram.push({ method: target.split('/').pop(), params: JSON.parse(options.body), messageId });
    return ok({ ok: true, result: { message_id: messageId } });
  }
  if (target.includes('polessu.by')) {
    siteFetches += 1;
    // Расписание опубликовано только в первом семестре; остальные три адреса
    // отвечают «Ничего не найдено», как и настоящий сайт.
    const html = target.includes('/term2/') || target.includes('f=2') ? emptyPage(siteStamp) : pageHtml;
    return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, arrayBuffer: async () => new TextEncoder().encode(html).buffer };
  }
  throw new Error(`fake fetch: неожиданный адрес ${target}`);
};

const telegramHandler = require('../api/telegram');
const checkChangesHandler = require('../api/check-changes');
const dailyRefreshHandler = require('../api/daily-refresh');

function makeRes() {
  const res = {};
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}

const WEBHOOK = { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET };
const call = async (handler, request) => {
  const res = makeRes();
  await handler(request, res);
  return res;
};
const send = (text, chatId = 42) => call(telegramHandler, {
  method: 'POST', headers: WEBHOOK, body: { message: { chat: { id: chatId }, text } },
});
const press = (data, chatId = 42, messageId = 555) => call(telegramHandler, {
  method: 'POST',
  headers: WEBHOOK,
  body: { callback_query: { id: 'cb', data, message: { chat: { id: chatId }, message_id: messageId } } },
});
const last = method => [...telegram].reverse().find(item => item.method === method);
const settingsOf = chatId => Object.fromEntries(redis.hashes.get(`ruz:settings:${chatId}`) || new Map());

test.beforeEach(() => { telegram.length = 0; siteFetches = 0; });

test('webhook без секрета не отвечает', async () => {
  assert.equal((await call(telegramHandler, { method: 'POST', headers: {}, body: {} })).statusCode, 401);
  assert.equal((await call(telegramHandler, { method: 'GET', headers: {}, url: '/api/telegram' })).statusCode, 405);
  assert.equal((await call(telegramHandler, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: {} })).statusCode, 401);
});

test('setup регистрирует webhook и снимает описание бота', async () => {
  const res = await call(telegramHandler, {
    method: 'GET', headers: { 'x-setup-secret': process.env.TELEGRAM_WEBHOOK_SECRET }, url: '/api/telegram',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(telegram.map(item => item.method),
    ['setWebhook', 'setMyCommands', 'setMyDescription', 'setMyShortDescription']);
  assert.equal(last('setWebhook').params.url, 'https://bot.test/api/telegram');
  assert.deepEqual(last('setWebhook').params.allowed_updates, ['message', 'callback_query']);
  assert.equal(last('setMyDescription').params.description, '');
});

test('/start создаёт карточку и запоминает её', async () => {
  await send('/start');
  const sent = last('sendRichMessage');
  assert.ok(sent, 'карточка не отправлена');
  assert.match(sent.params.rich_message.html, /Сыцевич М\. В\./);
  assert.equal(JSON.parse(redis.strings.get('ruz:card:42')).messageId, sent.messageId);
  assert.deepEqual(redis.run(['SMEMBERS', 'ruz:chats']), ['42']);
  // Карточка открывается на сегодня и в дневном виде.
  assert.equal(settingsOf(42).date, TODAY);
  assert.equal(settingsOf(42).view, 'd');
});

test('повторный /start пересоздаёт карточку и удаляет прошлую', async () => {
  const before = JSON.parse(redis.strings.get('ruz:card:42')).messageId;
  await send('/start');
  const sent = last('sendRichMessage');
  assert.equal(last('deleteMessage').params.message_id, before);
  assert.equal(JSON.parse(redis.strings.get('ruz:card:42')).messageId, sent.messageId);
});

test('листание дня перерисовывает карточку и сохраняет дату', async () => {
  await press(`d:${MONDAY}:d`);
  const edit = last('editMessageText');
  assert.match(edit.params.rich_message.html, /2 пары/);
  assert.match(edit.params.rich_message.html, /Аквааэробика/);
  assert.equal(settingsOf(42).date, MONDAY);
  // Кнопки унесли ту же дату дальше — карточка остаётся управляемой.
  assert.equal(edit.params.reply_markup.inline_keyboard[0][0].callback_data, `d:${addDays(MONDAY, -1)}:d`);
});

test('СМГ, которых нет на сайте, стоят в карточке как обычные пары', async () => {
  await press(`d:${TUESDAY}:d`);
  const html = last('editMessageText').params.rich_message.html;
  assert.match(html, /1 пара · 16:40–18:00/);
  assert.match(html, /📍 Гребная база 1 \(218 зал\) · 👥 СМГ 18/);
});

test('переключение вида меняет карточку на недельную', async () => {
  await press(`v:${MONDAY}:d`);
  assert.match(last('editMessageText').params.rich_message.html, /🗓 Неделя 1/);
  assert.equal(settingsOf(42).view, 'w');
  await press(`v:${MONDAY}:w`);
  assert.equal(settingsOf(42).view, 'd');
});

test('кнопка уведомлений переключает подписку и говорит об этом', async () => {
  await press(`n:${MONDAY}:d`);
  assert.equal(settingsOf(42).notify, '0');
  assert.match(last('answerCallbackQuery').params.text, /выключены/);
  assert.match(last('editMessageText').params.reply_markup.inline_keyboard[1][1].text, /выкл/);
  await press(`n:${MONDAY}:d`);
  assert.equal(settingsOf(42).notify, '1');
  assert.match(last('answerCallbackQuery').params.text, /включены/);
});

test('принудительное обновление подтверждается тостом', async () => {
  await press(`r:${MONDAY}:d`);
  assert.match(last('answerCallbackQuery').params.text, /обновлено/);
});

test('кнопка из старой карточки объясняет, что делать', async () => {
  await press('facility:pool:2026-01-01');
  assert.match(last('answerCallbackQuery').params.text, /устарела/);
  assert.equal(last('editMessageText'), undefined);
  // Битая дата в правильном по форме действии тоже не должна ломать карточку.
  await press('d:2026-13-45:d');
  assert.match(last('answerCallbackQuery').params.text, /устарела/);
});

test('«Ознакомлен» удаляет сообщение об изменениях', async () => {
  await press('ack', 42, 999);
  assert.equal(last('deleteMessage').params.message_id, 999);
});

test('проверка изменений закрыта секретом', async () => {
  assert.equal((await call(checkChangesHandler, { method: 'GET', headers: {} })).statusCode, 405);
  assert.equal((await call(checkChangesHandler, { method: 'POST', headers: {} })).statusCode, 401);
  assert.equal((await call(checkChangesHandler, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
});

const checkChanges = () => call(checkChangesHandler, {
  method: 'POST', headers: { authorization: `Bearer ${process.env.CHANGE_CHECK_SECRET}` },
});

test('первая проверка только запоминает расписание и молчит', async () => {
  const res = await checkChanges();
  assert.equal(res.body.baseline, true);
  assert.equal(res.body.notifications, 0);
  assert.ok(res.body.lessons > 0);
  assert.equal(telegram.filter(item => item.method === 'sendRichMessage').length, 0);
  // Полная проверка тянет все четыре источника, минус один — его принесла проба.
  assert.equal(siteFetches, 4);
  // СМГ входят в снимок наравне с парами сайта: правка их шаблона — тоже
  // изменение расписания, и сравнение обязано её видеть.
  assert.ok(JSON.parse(redis.strings.get('ruz:snapshot')).lessons.some(lesson => lesson.groups === 'СМГ 18'));
});

test('пока метка сайта на месте, проверка стоит на одной странице', async () => {
  const res = await checkChanges();
  assert.equal(res.body.gated, true);
  assert.equal(res.body.stamp, siteStamp);
  // Ради этого сторож и заведён: одна страница вместо четырёх.
  assert.equal(siteFetches, 1);
  assert.equal(telegram.length, 0);
});

test('получасовой потолок гонит полную проверку даже при той же метке', async () => {
  // Метка общая по университету и, судя по всему, поднимается при любой правке.
  // «Судя по всему» — не гарантия, поэтому потолок обязан пробивать сторож.
  const pulse = JSON.parse(redis.strings.get('ruz:pulse'));
  redis.strings.set('ruz:pulse', JSON.stringify({ ...pulse, fullAt: new Date(Date.now() - 31 * 60_000).toISOString() }));
  const res = await checkChanges();
  assert.equal(res.body.gated, undefined);
  assert.equal(res.body.changed, false);
  assert.equal(siteFetches, 4);
});

test('битая отметка времени не запирает сторож навсегда', async () => {
  const pulse = JSON.parse(redis.strings.get('ruz:pulse'));
  redis.strings.set('ruz:pulse', JSON.stringify({ ...pulse, fullAt: 'позавчера' }));
  const res = await checkChanges();
  assert.equal(res.body.gated, undefined);
  assert.equal(siteFetches, 4);
});

test('новая метка при том же расписании рассылки не порождает', async () => {
  // Метка общая по университету: её двигает и правка чужого расписания.
  publish(LESSONS, 5);
  const res = await checkChanges();
  assert.equal(res.body.changed, false);
  assert.equal(res.body.notifications, 0);
  assert.equal(siteFetches, 4);
  assert.equal(telegram.filter(item => item.method === 'sendRichMessage').length, 0);
});

test('изменение на сайте обновляет карточку и уходит в рассылку', async () => {
  publish(LESSONS.map(lesson => (lesson.room === '31' ? { ...lesson, room: '3431' } : lesson)), 10);
  const res = await checkChanges();
  assert.equal(res.body.changed, true);
  assert.equal(res.body.notifications, 1);
  const alert = last('sendRichMessage');
  assert.match(alert.params.rich_message.html, /Расписание изменилось/);
  // Новое значение выделено жирным, поэтому сверяем текст, а не сырую разметку.
  assert.match(alert.params.rich_message.html.replace(/<[^>]+>/g, ''), /ауд\. 31 → ауд\. 3431/);
  assert.equal(alert.params.reply_markup.inline_keyboard[0][0].callback_data, 'ack');
  // Карточка обновлена до рассылки, поэтому сообщение честно ссылается на неё.
  assert.ok(telegram.findIndex(item => item.method === 'editMessageText') < telegram.indexOf(alert));
});

test('чат с выключенными уведомлениями карточку получает, а сообщение — нет', async () => {
  redis.run(['HSET', 'ruz:settings:42', 'notify', '0']);
  publish(LESSONS.filter(lesson => lesson.weekday !== 2), 15);
  const res = await checkChanges();
  assert.equal(res.body.changed, true);
  assert.equal(res.body.notifications, 0);
  assert.equal(telegram.filter(item => item.method === 'sendRichMessage').length, 0);
  assert.ok(telegram.some(item => item.method === 'editMessageText'));
  redis.run(['HSET', 'ruz:settings:42', 'notify', '1']);
});

test('молчание сайта не выдаётся за снятие всех пар', async () => {
  const good = redis.strings.get('ruz:snapshot');
  publish(null, 20);
  const res = await checkChanges();
  assert.equal(res.body.skipped, 'empty');
  assert.equal(telegram.filter(item => item.method === 'sendRichMessage').length, 0);
  // Снимок остался прежним: следующая удачная проверка сравнит с настоящими
  // данными, а не с пустотой.
  assert.equal(redis.strings.get('ruz:snapshot'), good);
});

test('без сайта карточка не выдаёт одни СМГ за весь день', async () => {
  publish(null, 22);
  await press(`r:${TUESDAY}:d`);
  const html = last('editMessageText').params.rich_message.html;
  assert.match(html, /Расписание на сайте сейчас не опубликовано/);
  assert.doesNotMatch(html, /СМГ/);
});

test('после отказа сайта сторож не запирается, а идёт в полную проверку', async () => {
  // Метку при неудаче не двигали, поэтому следующая проверка обязана снова
  // сходить за всем, а не решить, что «ничего не изменилось».
  publish(LESSONS.filter(lesson => lesson.weekday !== 2), 25);
  const res = await checkChanges();
  assert.equal(res.body.changed, false);
  assert.equal(res.body.notifications, 0);
  assert.equal(siteFetches, 4);
});

test('смена суток перерисовывает карточки даже без изменений', async () => {
  const snapshot = JSON.parse(redis.strings.get('ruz:snapshot'));
  redis.strings.set('ruz:snapshot', JSON.stringify({ ...snapshot, today: addDays(TODAY, -1) }));
  const pulse = JSON.parse(redis.strings.get('ruz:pulse'));
  redis.strings.set('ruz:pulse', JSON.stringify({ ...pulse, day: addDays(TODAY, -1) }));
  const res = await checkChanges();
  assert.equal(res.body.dayChanged, true);
  assert.equal(res.body.changed, false);
  assert.ok(telegram.some(item => item.method === 'editMessageText'));
  assert.equal(telegram.filter(item => item.method === 'sendRichMessage').length, 0);
});

test('заблокировавший бота чат выпадает из рассылки сам', async () => {
  redis.run(['SET', 'ruz:card:77', JSON.stringify({ messageId: 5 })]);
  redis.run(['SADD', 'ruz:chats', '77']);
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('api.telegram.org') && JSON.parse(options.body).chat_id === '77') {
      return { ok: false, status: 403, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) };
    }
    return realFetch(url, options);
  };
  try {
    redis.strings.delete('ruz:snapshot');
    redis.strings.delete('ruz:pulse');
    await checkChanges();
    assert.equal(redis.strings.has('ruz:card:77'), false);
    assert.deepEqual(redis.run(['SMEMBERS', 'ruz:chats']), ['42']);
  } finally {
    global.fetch = realFetch;
  }
});

test('резервное обновление тоже закрыто секретом и щадит карточки при отказе', async () => {
  assert.equal((await call(dailyRefreshHandler, { method: 'GET', headers: {} })).statusCode, 401);
  publish(null, 28);
  const skipped = await call(dailyRefreshHandler, { method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(skipped.body.skipped, 'empty');
  assert.equal(telegram.length, 0);

  publish(LESSONS, 30);
  const done = await call(dailyRefreshHandler, { method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(done.body.ok, true);
  assert.equal(done.body.date, TODAY);
  assert.equal(done.body.updated, 1);
});
