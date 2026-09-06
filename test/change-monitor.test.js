const test = require('node:test');
const assert = require('node:assert/strict');

const { SNAPSHOT_VERSION, scheduleSnapshot, diffSchedules, formatChangeAlert, hasChanges } = require('../lib/change-monitor');

const TODAY = '2026-09-15';
const lesson = (over = {}) => ({
  date: '2026-09-17', start: '10:05', end: '11:25',
  subject: 'Аквааэробика', kind: 'пр.', room: '31', groups: '23ФК-1',
  ...over,
});
const snapshot = lessons => scheduleSnapshot({ today: TODAY, status: 'ok', weeks: [], lessons });
const text = html => html.replace(/<br \/>/g, ' ').replace(/<[^>]+>/g, '');
const alert = (before, after) => text(formatChangeAlert(diffSchedules(snapshot(before), snapshot(after))));

const BASE = [
  lesson(),
  lesson({ date: '2026-09-17', start: '11:55', end: '13:15', subject: 'Физическая культура', room: 'Спорткомплекс ПолесГУ', groups: '26БТ-1' }),
  lesson({ date: '2026-09-18', start: '08:30', end: '09:50', subject: 'Информационный час', kind: '', room: '3507', groups: '24ТД-1' }),
];

test('снимок помечен версией и отсортирован', () => {
  const snap = snapshot(BASE);
  assert.equal(snap.version, SNAPSHOT_VERSION);
  assert.equal(snap.today, TODAY);
  // Номер недели и семестр в снимок не идут: перенумерация недель на сайте
  // не должна выглядеть как изменение расписания.
  assert.deepEqual(Object.keys(snap.lessons[0]).sort(), ['date', 'end', 'groups', 'kind', 'room', 'start', 'subject']);
});

test('одинаковые расписания изменением не считаются', () => {
  assert.equal(hasChanges(diffSchedules(snapshot(BASE), snapshot(BASE))), false);
});

test('сдвиг времени внутри дня — один перенос, а не пара «добавили/сняли»', () => {
  const after = BASE.map(item => (item.start === '10:05' ? { ...item, start: '15:05', end: '16:25' } : item));
  const diff = diffSchedules(snapshot(BASE), snapshot(after));
  assert.equal(diff.moves.length, 1);
  assert.deepEqual([diff.added.length, diff.removed.length], [0, 0]);
  assert.match(alert(BASE, after), /🕐 Аквааэробика — пр\. · 23ФК-1 чт 17\.09: 10:05–11:25 → 15:05–16:25/);
});

test('смена аудитории показана отдельным значком', () => {
  const after = BASE.map(item => (item.room === '31' ? { ...item, room: '3431' } : item));
  assert.match(alert(BASE, after), /🚪 .* чт 17\.09: ауд\. 31 → ауд\. 3431/);
});

test('время и аудитория сразу — один пункт с обоими изменениями', () => {
  const after = BASE.map(item => (item.room === '31' ? { ...item, start: '08:30', end: '09:50', room: '3405' } : item));
  const line = alert(BASE, after);
  assert.match(line, /🔀/);
  assert.match(line, /10:05–11:25 → 08:30–09:50 · ауд\. 31 → ауд\. 3405/);
});

test('перенос на другой день назван переносом', () => {
  const after = BASE.map(item => (item.date === '2026-09-18' ? { ...item, date: '2026-09-19' } : item));
  const diff = diffSchedules(snapshot(BASE), snapshot(after));
  assert.equal(diff.moves.length, 1);
  assert.match(alert(BASE, after), /📆 Информационный час · 24ТД-1 пт 18\.09 08:30 → сб 19\.09 08:30/);
});

test('правка внутри дня побеждает перенос на другой день', () => {
  // Та же пара в тот же день сдвинута по времени, и в другой день добавлена
  // ещё одна такая же. Сшивать надо ту, что осталась на месте.
  const after = [
    ...BASE.map(item => (item.start === '10:05' ? { ...item, start: '13:30', end: '14:50' } : item)),
    lesson({ date: '2026-09-24' }),
  ];
  const diff = diffSchedules(snapshot(BASE), snapshot(after));
  assert.equal(diff.moves.length, 1);
  assert.equal(diff.moves[0].before.date, diff.moves[0].after.date);
  assert.equal(diff.added.length, 1);
});

test('добавление и снятие отдельных пар', () => {
  const added = [...BASE, lesson({ date: '2026-09-16', subject: 'Плавание', groups: '27ФК-9' })];
  assert.match(alert(BASE, added), /➕ Плавание — пр\. · 27ФК-9 ср 16\.09 · 10:05–11:25 · ауд\. 31/);
  const removed = BASE.filter(item => item.date !== '2026-09-18');
  assert.match(alert(BASE, removed), /➖ Информационный час · 24ТД-1 пт 18\.09 · 08:30–09:50/);
});

test('день, у которого сняли всё, схлопывается в одну строку', () => {
  const after = BASE.filter(item => item.date !== '2026-09-17');
  const diff = diffSchedules(snapshot(BASE), snapshot(after));
  assert.deepEqual(diff.clearedDays, [{ date: '2026-09-17', count: 2 }]);
  assert.equal(diff.removed.length, 0);
  assert.match(alert(BASE, after), /❗ чт 17\.09 — сняты все пары \(2\)/);
});

test('прошедшие дни в сравнении не участвуют', () => {
  const past = [...BASE, lesson({ date: '2026-09-01' })];
  assert.equal(hasChanges(diffSchedules(snapshot(past), snapshot(BASE))), false);
  assert.equal(hasChanges(diffSchedules(snapshot(BASE), snapshot(past))), false);
});

test('публикация целого периода сворачивается в сводку', () => {
  const many = Array.from({ length: 14 }, (_, index) => lesson({
    date: `2026-09-${17 + (index % 5)}`, start: `${9 + index}:00`.padStart(5, '0'), end: `${10 + index}:00`.padStart(5, '0'),
    groups: `Г-${index}`,
  }));
  const line = alert([], many);
  assert.match(line, /📚 Опубликовано расписание/);
  assert.match(line, /Добавлено 14 пар/);
  assert.doesNotMatch(line, /➕/);
});

test('снятие целого периода тоже сводка, а не простыня', () => {
  const many = Array.from({ length: 14 }, (_, index) => lesson({ date: '2026-09-17', start: `${9 + index}:00`.padStart(5, '0'), groups: `Г-${index}` }));
  // Один день с четырнадцатью парами схлопнулся бы в «сняты все пары»,
  // поэтому раскидываем их по разным дням.
  const spread = many.map((item, index) => ({ ...item, date: `2026-09-${17 + index}` }));
  const line = alert(spread, []);
  assert.match(line, /📕 Расписание снято/);
  assert.match(line, /убрано 14 пар/);
});

test('длинный список изменений обрезается со счётчиком', () => {
  const before = Array.from({ length: 20 }, (_, index) => lesson({ date: `2026-09-${17 + index}`, groups: `Г-${index}` }));
  const after = before.map(item => ({ ...item, room: `К-${item.groups}` }));
  const line = alert(before, after);
  assert.match(line, /И ещё 8 изменений/);
  assert.ok(formatChangeAlert(diffSchedules(snapshot(before), snapshot(after))).length < 4096);
});

test('первая проверка отмечена отсутствием истории', () => {
  const diff = diffSchedules(null, snapshot(BASE));
  assert.equal(diff.hadBaseline, false);
  assert.equal(diff.added.length, 3);
});
