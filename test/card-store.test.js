const test = require('node:test');
const assert = require('node:assert/strict');

const { createCardStore, parseSettings } = require('../lib/card-store');
const { createFakeRedis } = require('./helpers');

function makeStore() {
  const redis = createFakeRedis();
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    const payload = String(url).endsWith('/pipeline')
      ? body.map(command => ({ result: redis.run(command) }))
      : { result: redis.run(body) };
    return { ok: true, status: 200, json: async () => payload };
  };
  return { redis, store: createCardStore({ url: 'https://redis.test', token: 'token', fetchFn }) };
}

test('нормализует настройки и подставляет значения по умолчанию', () => {
  assert.deepEqual(parseSettings([]), { view: 'd', date: null, notify: true });
  assert.deepEqual(parseSettings(['view', 'w', 'date', '2026-09-17', 'notify', '0']),
    { view: 'w', date: '2026-09-17', notify: false });
  // Мусор не должен доехать до callback_data: неизвестный вид и битая дата
  // сделали бы кнопки карточки нерабочими целиком.
  assert.deepEqual(parseSettings(['view', 'месяц', 'date', 'вчера']), { view: 'd', date: null, notify: true });
  // Чат без поля notify заведён до появления переключателя — он подписан.
  assert.equal(parseSettings(['view', 'd']).notify, true);
});

test('сохраняет карточку, читает её и ведёт список чатов', async () => {
  const { store } = makeStore();
  await store.save(42, 777, { view: 'w', date: '2026-09-17', notify: false });
  assert.deepEqual(await store.get(42), {
    chatId: '42', messageId: 777, view: 'w', date: '2026-09-17', notify: false,
  });
  assert.deepEqual(await store.list(), [{ chatId: '42', messageId: 777, view: 'w', date: '2026-09-17', notify: false }]);
});

test('частичная запись не задевает соседние настройки', async () => {
  const { store } = makeStore();
  await store.save(42, 777, { view: 'd', date: '2026-09-17', notify: false });
  await store.patch(42, { date: '2026-09-20', view: 'w' });
  const card = await store.get(42);
  // Переключатель уведомлений пережил листание — ради этого настройки и лежат
  // хешем, а не одним JSON-значением.
  assert.equal(card.notify, false);
  assert.deepEqual([card.date, card.view], ['2026-09-20', 'w']);
});

test('/start переписывает id карточки, не трогая настройки', async () => {
  const { store } = makeStore();
  await store.save(42, 777, { view: 'w', date: '2026-09-17', notify: false });
  await store.save(42, 888, { view: 'w', date: null, notify: false });
  const card = await store.get(42);
  assert.equal(card.messageId, 888);
  assert.equal(card.notify, false);
});

test('чат без карточки не читается и не попадает в рассылку', async () => {
  const { store, redis } = makeStore();
  await store.save(42, 777, {});
  redis.strings.delete('ruz:card:42');
  assert.equal(await store.get(42), null);
  assert.deepEqual(await store.list(), []);
});

test('удаление чистит карточку, настройки и список', async () => {
  const { store, redis } = makeStore();
  await store.save(42, 777, { view: 'w' });
  await store.remove(42);
  assert.equal(await store.get(42), null);
  assert.deepEqual(redis.run(['SMEMBERS', 'ruz:chats']), []);
  assert.equal(redis.hashes.has('ruz:settings:42'), false);
});

test('снимок расписания сохраняется и читается', async () => {
  const { store } = makeStore();
  assert.equal(await store.getSnapshot(), null);
  await store.saveSnapshot({ version: 1, lessons: [] });
  assert.deepEqual(await store.getSnapshot(), { version: 1, lessons: [] });
});

test('битый messageId не сохраняется', async () => {
  const { store } = makeStore();
  await assert.rejects(() => store.save(42, 0, {}), /messageId is invalid/);
  await assert.rejects(() => store.save(42, 'abc', {}), /messageId is invalid/);
});

test('без адреса Redis хранилище не создаётся', () => {
  assert.throws(() => createCardStore({ url: '', token: 'x' }), /UPSTASH_REDIS_REST_URL/);
});
