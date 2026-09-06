const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parsePage, coverage, lessonsOn, weekOf, sources, TEACHER } = require('../lib/schedule');
const { buildPage, emptyPage } = require('./helpers');

const REAL = fs.readFileSync(path.join(__dirname, 'fixtures/term1-f1.html'), 'utf8');
// Живая страница за 1 семестр 2026/2027. Год в ней нигде не написан — его
// восстанавливает разбор, поэтому «сегодня» задаём явно.
const TODAY = '2026-09-06';
const page = parsePage(REAL, { today: TODAY, term: 1, part: 1 });

test('разбирает живую страницу расписания', () => {
  assert.equal(page.status, 'ok');
  assert.equal(page.teacher, 'Сыцевич Мария Владимировна');
  assert.equal(page.siteUpdatedAt, '03.09.2026 16:19');
  assert.equal(page.rowCount, 62);
  assert.equal(page.undatedRows, 0);
  assert.equal(page.lessons.length, 75);
});

test('восстанавливает год: первая неделя начинается с понедельника', () => {
  assert.equal(page.weeks.length, 10);
  assert.deepEqual(
    { num: page.weeks[0].num, from: page.weeks[0].from, to: page.weeks[0].to },
    { num: 1, from: '2026-08-31', to: '2026-09-05' },
  );
  assert.equal(page.weeks.at(-1).to, '2026-11-07');
  assert.equal(new Date(`${page.weeks[0].from}T12:00:00Z`).getUTCDay(), 1);
});

test('разворачивает строку по всем её неделям', () => {
  // «(4, 8) Физическая культура в учреждениях дошкольного образования» стоит
  // в понедельник и повторяется на неделях 4 и 8 — классы w3 и w7.
  const matching = page.lessons.filter(lesson =>
    lesson.subject === 'Физическая культура в учреждениях дошкольного образования'
    && lesson.start === '08:30'
    && new Date(`${lesson.date}T12:00:00Z`).getUTCDay() === 1);
  assert.deepEqual(matching.map(lesson => lesson.week).sort((a, b) => a - b), [4, 8]);
});

test('делит название и вид занятия, номера недель из текста убирает', () => {
  const lesson = lessonsOn(page, '2026-09-24')[0];
  assert.equal(lesson.subject, 'Аквааэробика');
  assert.equal(lesson.kind, 'пр.');
  assert.equal(lesson.room, '31');
  assert.equal(lesson.groups, '23ФК-1');
  assert.ok(page.lessons.every(item => !item.subject.startsWith('(')));
});

test('занятия отсортированы по дате и времени', () => {
  const keys = page.lessons.map(lesson => `${lesson.date} ${lesson.start}`);
  assert.deepEqual(keys, [...keys].sort());
});

test('различает выходной, свободный день и неопубликованную дату', () => {
  assert.equal(coverage(page, '2026-09-24'), 'week');
  // Воскресенье в диапазоны недель не входит: это выходной, а не пробел.
  assert.equal(coverage(page, '2026-09-06'), 'gap');
  assert.equal(coverage(page, '2026-12-01'), 'none');
  assert.equal(coverage(page, '2026-08-20'), 'none');
});

test('находит неделю по дате', () => {
  assert.equal(weekOf(page, '2026-09-24').num, 4);
  assert.equal(weekOf(page, '2026-09-06'), null);
});

test('пустая страница — это не поломка разбора', () => {
  const empty = parsePage(emptyPage(), { today: TODAY });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.teacher, '');
  assert.equal(empty.lessons.length, 0);
  // Метка правки сайта общая для всех страниц и на пустой тоже есть.
  assert.equal(empty.siteUpdatedAt, '01.09.2026 10:00');
});

test('страница со строками, но без календаря недель — поломка, а не пустота', () => {
  const broken = buildPage({
    today: TODAY,
    lessons: [{ weekday: 0, weeks: [0], time: '8:30-9:50', subject: 'Физкультура', kind: 'пр.', room: '31', group: '24М-1' }],
  }).replace(/<ul id="weeks-menu".*?<\/ul>/s, '<ul id="weeks-menu"></ul>');
  const result = parsePage(broken, { today: TODAY });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'нет календаря недель');
});

test('день, вышедший за правую границу укороченной недели, не показывается', () => {
  const html = buildPage({
    today: '2026-09-07',
    weeks: 1,
    lessons: [{ weekday: 5, weeks: [0], time: '8:30-9:50', subject: 'Физкультура', kind: 'пр.', room: '31', group: '24М-1' }],
  }).replace(/\(07\.09-12\.09\)/g, '(07.09-09.09)');
  const short = parsePage(html, { today: '2026-09-07' });
  // Суббота 12.09 в неделю 07.09–09.09 уже не входит.
  assert.equal(short.lessons.length, 0);
});

test('номер подгруппы не слипается с названием группы', () => {
  const html = buildPage({
    today: TODAY,
    weeks: 1,
    lessons: [{ weekday: 0, weeks: [0], time: '8:30-9:50', subject: 'Физкультура', kind: 'пр.', room: '31', group: '24М-1', sub: '2' }],
  });
  assert.equal(parsePage(html, { today: TODAY }).lessons[0].groups, '24М-1 (2)');
});

test('источники покрывают оба семестра и обе части', () => {
  const list = sources();
  assert.equal(list.length, 4);
  assert.deepEqual(list.map(item => `${item.term}/${item.part}`), ['1/1', '1/2', '2/1', '2/2']);
  assert.ok(list.every(item => item.url.includes(encodeURIComponent(TEACHER.query))));
  assert.ok(list.filter(item => item.term === 2).every(item => item.url.includes('/term2/')));
});

test('метка правки сайта читается из сырой разметки, без разбора', () => {
  const { siteStampOf } = require('../lib/schedule');
  assert.equal(siteStampOf(REAL), '03.09.2026 16:19');
  // Метка общая по университету, поэтому есть и на пустой странице — именно
  // это и делает её пригодной на роль сторожа перед полной проверкой.
  assert.equal(siteStampOf(emptyPage('12.01.2027 9:05')), '12.01.2027 9:05');
  assert.equal(siteStampOf('<footer>Последние изменения вносились:&nbsp;03.09.2026&nbsp;16:19</footer>'), '03.09.2026 16:19');
  assert.equal(siteStampOf('<html>без подвала</html>'), '');
  assert.equal(siteStampOf(null), '');
});

test('метка совпадает с той, что достаёт полный разбор', () => {
  const { siteStampOf } = require('../lib/schedule');
  assert.equal(siteStampOf(REAL), page.siteUpdatedAt);
});
