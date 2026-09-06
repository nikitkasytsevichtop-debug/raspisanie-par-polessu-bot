#!/usr/bin/env node
// Расписание QStash для /api/check-changes: создать, показать, удалить.
//
//   node scripts/qstash.js list
//   node scripts/qstash.js create
//   node scripts/qstash.js delete <scheduleId>
//
// Читает QSTASH_TOKEN, QSTASH_URL, APP_URL и CHANGE_CHECK_SECRET из окружения или из
// .env.local рядом с проектом. Секрет уходит в заголовке Upstash-Forward-…,
// поэтому QStash передаёт его эндпоинту, и снаружи тот остаётся закрытым.

const fs = require('node:fs');
const path = require('node:path');

// Аккаунт QStash живёт в конкретном регионе, и общий адрес отвечает 404 «user
// not found in this region». Правильный эндпоинт интеграция Vercel кладёт в
// QSTASH_URL — берём его, а общий оставляем запасным. Считаем адрес функцией,
// а не константой модуля: .env.local читается уже после загрузки файла, и
// константа успела бы зафиксировать значение по умолчанию.
function api(suffix = '') {
  const base = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/$/, '');
  return `${base}/v2/schedules${suffix}`;
}
const CRON = process.env.CHECK_CRON || 'CRON_TZ=Europe/Minsk 0,30 7-20 * * *';
// Одна повторная попытка вместо трёх по умолчанию. Каждая попытка тратит
// сообщение из суточного лимита QStash: 144 вызова в сутки при трёх ретраях
// дали бы 576 и вышли бы за бесплатные 500, а для проверки раз в десять минут
// упорные ретраи всё равно бессмысленны — следующий тик уже на подходе.
const RETRIES = '1';

function loadEnvFile() {
  const file = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Не задан ${name}. Добавьте его в .env.local или в окружение.`);
    process.exit(1);
  }
  return value;
}

async function call(method, url, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${required('QSTASH_TOKEN')}`, ...headers },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`QStash ${response.status}: ${body || response.statusText}`);
  try { return body ? JSON.parse(body) : null; } catch { return body; }
}

async function list() {
  const schedules = await call('GET', api());
  if (!schedules?.length) return console.log('Расписаний нет.');
  for (const schedule of schedules) {
    console.log(`${schedule.scheduleId}  ${schedule.cron.padEnd(16)}  ${schedule.destination}${schedule.isPaused ? '  [на паузе]' : ''}`);
  }
  return schedules;
}

async function create() {
  const destination = `${required('APP_URL').replace(/\/$/, '')}/api/check-changes`;
  // Повторный запуск не должен плодить дубли: два расписания на один адрес
  // удвоили бы и число проверок, и расход суточного лимита.
  const existing = (await call('GET', api())) || [];
  const duplicate = existing.find(schedule => schedule.destination === destination);
  if (duplicate) {
    console.log(`Расписание на этот адрес уже есть: ${duplicate.scheduleId} (${duplicate.cron}).`);
    console.log(`Чтобы пересоздать: node scripts/qstash.js delete ${duplicate.scheduleId}`);
    return duplicate;
  }
  const created = await call('POST', api(`/${destination}`), {
    'Upstash-Cron': CRON,
    'Upstash-Method': 'POST',
    'Upstash-Retries': RETRIES,
    // Заголовки с этим префиксом QStash пересылает эндпоинту как есть.
    'Upstash-Forward-Authorization': `Bearer ${required('CHANGE_CHECK_SECRET')}`,
  });
  console.log(`Создано: ${created.scheduleId}`);
  console.log(`  ${CRON} → ${destination}`);
  return created;
}

async function remove(scheduleId) {
  if (!scheduleId) {
    console.error('Укажите scheduleId: node scripts/qstash.js delete <scheduleId>');
    process.exit(1);
  }
  await call('DELETE', api(`/${scheduleId}`));
  console.log(`Удалено: ${scheduleId}`);
}

const actions = { list, create, delete: remove };

(async () => {
  loadEnvFile();
  const [action, ...args] = process.argv.slice(2);
  const handler = actions[action];
  if (!handler) {
    console.error('Использование: node scripts/qstash.js list | create | delete <scheduleId>');
    process.exit(1);
  }
  await handler(...args);
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
