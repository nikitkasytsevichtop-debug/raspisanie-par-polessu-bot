const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXTRA_LESSONS = require('../lib/extra-lessons');
const { extraLessons, mergeWeeks, parsePage, sortLessons } = require('../lib/schedule');
const { cardView, dayCard, dayStamp, escapeHtml, keyboard, lessonsWord, render, shortPlace, shortSubject, weekCard } = require('../lib/format');
const { buildPage } = require('./helpers');

const TODAY = '2026-09-06';
const parsed = parsePage(fs.readFileSync(path.join(__dirname, 'fixtures/term1-f1.html'), 'utf8'), { today: TODAY });
const payload = { ...parsed, today: TODAY, generatedAt: '2026-09-06T18:15:00Z' };
const text = html => html.replace(/<br \/>/g, '\n').replace(/<[^>]+>/g, '');

test('карточка дня показывает пары, места и группы', () => {
  const card = dayCard(payload, '2026-09-17');
  const plain = text(card);
  assert.match(plain, /четверг, 17 сентября/);
  assert.match(plain, /Неделя 3 · 4 пары · 10:05–16:25/);
  assert.match(plain, /10:05–11:25 · Физическая культура — пр\./);
  // Номер аудитории и название корпуса подписаны по-разному.
  assert.match(plain, /🚪 ауд\. 31/);
  assert.match(plain, /📍 Спорткомплекс ПолесГУ/);
  assert.match(plain, /👥 26БТ-1/);
});

test('окно между парами отмечено, обычный перерыв — нет', () => {
  // 02.09: пары в 11:55–13:15 и 15:05–16:25, между ними полтора часа сверх нормы.
  assert.match(text(dayCard(payload, '2026-09-02')), /⌛ окно 1 ч 50 мин/);
  // 17.09: пары идут подряд с перерывами 15 и 30 минут — это не окно.
  assert.doesNotMatch(text(dayCard(payload, '2026-09-17')), /окно/);
});

test('пустой день объясняет причину и подсказывает ближайшие пары', () => {
  const sunday = text(dayCard(payload, '2026-09-06'));
  assert.match(sunday, /Выходной — занятий нет/);
  assert.match(sunday, /Ближайшие пары — понедельник, 7 сентября, начало в 10:05/);

  const future = text(dayCard(payload, '2026-12-01'));
  assert.match(future, /Расписание на эту дату ещё не опубликовано/);
  assert.doesNotMatch(future, /Ближайшие пары/);
});

// Пары в первую и третью неделю от 31.08: вторая (07.09–12.09) из меню сайта
// выпала, и разбор восстановил её по соседям.
const gappedPage = parsePage(buildPage({
  today: TODAY,
  weeks: 3,
  lessons: [{ weekday: 0, weeks: [0, 2], time: '8:30-9:50', subject: 'Физкультура', kind: 'пр.', room: '31', group: '24М-1' }],
}), { today: TODAY });
const gapped = { ...gappedPage, weeks: mergeWeeks([gappedPage]), today: TODAY, generatedAt: payload.generatedAt };

test('день учебной недели без пар — свободный, а не выходной', () => {
  const day = text(dayCard(gapped, '2026-09-09'));
  assert.match(day, /Пар нет — свободный день/);
  assert.match(day, /Ближайшие пары — понедельник, 14 сентября, начало в 08:30/);
  // Воскресенье перед ней остаётся выходным.
  assert.match(text(dayCard(gapped, '2026-09-06')), /Выходной — занятий нет/);
});

test('неделя без пар названа по номеру и свободной неделей', () => {
  const week = text(weekCard(gapped, '2026-09-09'));
  assert.match(week, /Неделя 2 · 07\.09 – 12\.09/);
  assert.match(week, /Пар нет — свободная неделя/);
  // В воскресенье карточка уже показывает эту неделю и говорит о ней, а не о себе.
  assert.match(text(weekCard(gapped, '2026-09-06')), /Пар нет — свободная неделя/);
  assert.equal(keyboard(gapped, '2026-08-31', 'w', true).inline_keyboard[0][2].text, 'Нед. 2 ›');
});

test('отказ сайта не выдаётся за свободный день', () => {
  const down = { ...payload, status: 'unavailable', lessons: [], weeks: [] };
  assert.match(text(dayCard(down, TODAY)), /Сайт университета не отвечает/);
  const blank = { ...payload, status: 'empty', lessons: [], weeks: [] };
  assert.match(text(dayCard(blank, TODAY)), /Расписание на сайте сейчас не опубликовано/);
});

test('недельная карточка перечисляет все дни и считает пары', () => {
  const plain = text(weekCard(payload, '2026-09-21'));
  assert.match(plain, /Неделя 4 · 21\.09 – 26\.09/);
  assert.match(plain, /16 пар за неделю/);
  assert.match(plain, /пн 21\.09 · 5 пар/);
  assert.match(plain, /сб 26\.09 — свободно/);
  // Воскресенья в неделе сайта нет — не выдумываем и мы.
  assert.doesNotMatch(plain, /вс 27/);
});

test('недельная карточка помещается в лимит Telegram', () => {
  const longest = Math.max(...payload.weeks.map(week => weekCard(payload, week.from).length));
  assert.ok(longest < 4096, `самая длинная карточка ${longest} символов`);
});

test('с занятиями вне сайта недельная карточка тоже в лимите', () => {
  // Настоящий шаблон, перенесённый на недели фикстуры: проверка не устареет,
  // когда его заменят расписанием следующего семестра.
  const onFixture = EXTRA_LESSONS.map(entry => ({ ...entry, from: payload.weeks[0].from, to: payload.weeks.at(-1).to }));
  const merged = { ...payload, lessons: sortLessons([...payload.lessons, ...extraLessons(onFixture)]) };
  const longest = Math.max(...merged.weeks.map(week => weekCard(merged, week.from).length));
  assert.ok(longest < 4096, `самая длинная карточка ${longest} символов`);
});

test('клавиатура листает дни, недели и переключает вид', () => {
  const day = keyboard(payload, '2026-09-17', 'd', true).inline_keyboard;
  assert.deepEqual(day[0].map(button => button.callback_data), ['d:2026-09-16:d', 'd:2026-09-06:d', 'd:2026-09-18:d']);
  assert.deepEqual(day[0].map(button => button.text), ['‹ ср 16', 'Сегодня', 'пт 18 ›']);
  assert.deepEqual(day[1].map(button => button.text), ['🗓 Неделя', '🔔 вкл', '↻']);

  const week = keyboard(payload, '2026-09-21', 'w', false).inline_keyboard;
  // В недельном виде шаг — семь дней, а подпись берёт номер недели с сайта.
  assert.deepEqual(week[0].map(button => button.callback_data), ['d:2026-09-14:w', 'd:2026-09-06:w', 'd:2026-09-28:w']);
  assert.deepEqual(week[0].map(button => button.text), ['‹ Нед. 3', 'Эта неделя', 'Нед. 5 ›']);
  assert.deepEqual(week[1].map(button => button.text), ['📅 День', '🔕 выкл', '↻']);
});

test('callback_data умещается в лимит Telegram', () => {
  for (const view of ['d', 'w']) {
    for (const button of keyboard(payload, '2026-09-21', view, true).inline_keyboard.flat()) {
      assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);
    }
  }
});

test('карточка чата не застревает во вчерашнем дне', () => {
  // Прошедшую дату фоновое обновление подтягивает на сегодня …
  assert.equal(cardView(payload, { date: '2026-09-01', view: 'd' }).date, TODAY);
  // … а будущую оставляет: пользователь открыл её нарочно.
  assert.equal(cardView(payload, { date: '2026-10-05', view: 'd' }).date, '2026-10-05');
  assert.equal(cardView(payload, { view: 'w' }).view, 'w');
  // Выключенные уведомления видны на кнопке.
  assert.match(cardView(payload, { notify: false }).replyMarkup.inline_keyboard[1][1].text, /выкл/);
});

test('подпись показывает и правку сайта, и время проверки', () => {
  const footer = render(payload, TODAY, 'd');
  assert.match(footer, /сайт от 03\.09 16:19/);
  assert.match(footer, /<tg-time unix="\d+" format="dt">/);
  assert.match(footer, /Сыцевич М\. В\./);
});

test('склонения, сокращения и экранирование', () => {
  assert.deepEqual([1, 2, 5, 11, 21].map(lessonsWord), ['1 пара', '2 пары', '5 пар', '11 пар', '21 пара']);
  assert.equal(shortSubject('Физическая культура в учреждениях дошкольного образования'), 'Физкультура в УДО');
  assert.equal(shortSubject('Информационный час'), 'Информационный час');
  assert.ok(shortSubject('Очень длинное название дисциплины без сокращения').endsWith('…'));
  assert.equal(shortPlace('3430'), 'ауд. 3430');
  assert.equal(shortPlace('Спорткомплекс ПолесГУ'), 'Спорткомплекс');
  assert.equal(dayStamp('2026-09-24'), 'чт 24.09');
  assert.equal(escapeHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
});

test('название предмета с угловыми скобками не ломает разметку', () => {
  const risky = { ...payload, lessons: [{ date: TODAY, start: '08:30', end: '09:50', subject: '<b>Хак</b>', kind: '', room: '31', groups: '24М-1', week: 1, term: 1 }] };
  assert.match(dayCard(risky, TODAY), /&lt;b&gt;Хак&lt;\/b&gt;/);
});

test('в воскресенье недельная карточка смотрит вперёд, а не назад', () => {
  // 06.09.2026 — воскресенье между неделями 1 (31.08–05.09) и 2 (07.09–12.09).
  assert.match(text(weekCard(payload, '2026-09-06')), /Неделя 2 · 07\.09 – 12\.09/);
  // Листание при этом остаётся ровным: соседи — недели 1 и 3.
  const nav = keyboard(payload, '2026-09-06', 'w', true).inline_keyboard[0];
  assert.deepEqual(nav.map(button => button.text), ['‹ Нед. 1', 'Эта неделя', 'Нед. 3 ›']);
});
