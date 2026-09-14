const test = require('node:test');
const assert = require('node:assert/strict');

const EXTRA_LESSONS = require('../lib/extra-lessons');
const { extraLessons } = require('../lib/schedule');

// Шаблон на две недели с понедельника 14.09.2026.
const entry = (over = {}) => ({
  from: '2026-09-14',
  to: '2026-09-27',
  subject: 'Физическая культура',
  kind: 'пр.',
  room: 'Гребная база 1 (218 зал)',
  groups: { 'СМГ 18': 'пн 16:40, ср 18:10', 'СМГ 13': 'ср 19:40' },
  ...over,
});
const when = lessons => lessons.map(lesson => `${lesson.date} ${lesson.start}–${lesson.end} ${lesson.groups}`).sort();

test('шаблон повторяется каждую неделю, конец пары — через 80 минут', () => {
  assert.deepEqual(when(extraLessons([entry()])), [
    '2026-09-14 16:40–18:00 СМГ 18',
    '2026-09-16 18:10–19:30 СМГ 18',
    '2026-09-16 19:40–21:00 СМГ 13',
    '2026-09-21 16:40–18:00 СМГ 18',
    '2026-09-23 18:10–19:30 СМГ 18',
    '2026-09-23 19:40–21:00 СМГ 13',
  ]);
});

test('занятие вне сайта устроено так же, как пара с сайта', () => {
  assert.deepEqual(extraLessons([entry()]).find(lesson => lesson.date === '2026-09-14'), {
    date: '2026-09-14',
    start: '16:40',
    end: '18:00',
    subject: 'Физическая культура',
    kind: 'пр.',
    room: 'Гребная база 1 (218 зал)',
    groups: 'СМГ 18',
  });
});

test('края периода включительны, даже посреди недели', () => {
  // Со среды по понедельник: понедельник до начала и среда после конца отрезаны.
  assert.deepEqual(when(extraLessons([entry({ from: '2026-09-16', to: '2026-09-21' })])), [
    '2026-09-16 18:10–19:30 СМГ 18',
    '2026-09-16 19:40–21:00 СМГ 13',
    '2026-09-21 16:40–18:00 СМГ 18',
  ]);
});

test('опечатка выбрасывает кусок шаблона, а не роняет бота', t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const lessons = extraLessons([
    entry({ groups: { 'СМГ 18': 'пн 16:40, срд 18:10, чт 25:00, пт' } }),
    entry({ from: '14.09.2026' }),
  ]);
  assert.deepEqual(when(lessons), ['2026-09-14 16:40–18:00 СМГ 18', '2026-09-21 16:40–18:00 СМГ 18']);
  assert.equal(warn.mock.callCount(), 4);
});

test('настоящий шаблон разобран без потерь', t => {
  // Опечатка молча убрала бы занятие из карточки. Здесь она роняет тест.
  const warn = t.mock.method(console, 'warn', () => {});
  const lessons = extraLessons(EXTRA_LESSONS);
  assert.equal(warn.mock.callCount(), 0);
  for (const { groups } of EXTRA_LESSONS) {
    for (const name of Object.keys(groups)) {
      assert.ok(lessons.some(lesson => lesson.groups === name), `нет занятий у ${name}`);
    }
  }
});
