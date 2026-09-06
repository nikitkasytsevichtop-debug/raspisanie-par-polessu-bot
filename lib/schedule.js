const cheerio = require('cheerio');

const TZ = 'Europe/Minsk';
const TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 90_000;
const MAX_BYTES = 2 * 1024 * 1024;

// Кого показывает бот. Запрос уходит в поиск сайта как есть; поиск нестрогий,
// поэтому хватило бы и одной фамилии, но полное имя защищает от однофамильцев,
// которые могут появиться на кафедре позже.
const TEACHER = {
  name: 'Сыцевич Мария Владимировна',
  short: 'Сыцевич М. В.',
  query: 'Сыцевич Мария Владимировна',
};

const BASE = 'https://www.polessu.by/ruz';

// Расписание разложено по четырём страницам: два семестра, в каждом основная
// часть и сессия. Пустые отвечают «Ничего не найдено» — их пропускаем, но
// опрашиваем всё равно: так второй семестр появится сам, без правки кода.
function sources(query = TEACHER.query) {
  const q = encodeURIComponent(query);
  return [
    { term: 1, part: 1, url: `${BASE}/?q=${q}&f=1` },
    { term: 1, part: 2, url: `${BASE}/?q=${q}&f=2` },
    { term: 2, part: 1, url: `${BASE}/term2/?q=${q}&f=1` },
    { term: 2, part: 2, url: `${BASE}/term2/?q=${q}&f=2` },
  ];
}

// Понедельник — ноль: неделя на сайте задана диапазоном «31.08-05.09», и день
// занятия отсчитывается смещением от её начала.
const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const SLOT_RE = /(\d{1,2})[:.](\d{2})\s*[–—-]\s*(\d{1,2})[:.](\d{2})/;
const SPAN_RE = /\((\d{1,2})\.(\d{1,2})\s*[–—-]\s*(\d{1,2})\.(\d{1,2})\)/;
const WEEK_NUM_RE = /Неделя\s+(\d+)/i;
const SITE_UPDATED_RE = /Последние изменения вносились:\s*(\d{2}\.\d{2}\.\d{4}\s+\d{1,2}:\d{2})/;
// Номера недель дублируются в тексте предмета — «(2, 7-8, 10) Физическая
// культура». Классы строки те же недели задают машинно, поэтому текст только
// срезаем. Класс символов намеренно узкий: настоящий предмет со скобки в начале
// под него не попадёт.
const LEADING_WEEKS_RE = /^\(\s*[\d\s,.–—-]+\)\s*/;
// Вид занятия стоит в хвосте через тире: «- пр.», «- лек.», «- зач.».
const KIND_RE = /\s[-–—]\s([а-яё]{1,12}\.?)$/i;

let cache = null;

function normalize(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function iso(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

// Понедельник = 0, как в WEEKDAYS: Date.getUTCDay() считает от воскресенья.
function weekdayOf(isoDate) {
  return (new Date(`${isoDate}T12:00:00Z`).getUTCDay() + 6) % 7;
}

function weekStartOf(isoDate) {
  return addDays(isoDate, -weekdayOf(isoDate));
}

// Воскресенье в учебной неделе сайта не участвует: недели идут понедельник–
// суббота. Недельная карточка относит его к предстоящей неделе, а не к
// прошедшей: в воскресенье смотрят вперёд, а не назад. Шаг листания при этом
// остаётся ровным — каждое воскресенье сдвигается ровно на день, поэтому ±7
// дней по-прежнему переводят на соседнюю неделю.
function scheduleWeekStart(isoDate) {
  return weekStartOf(weekdayOf(isoDate) === 6 ? addDays(isoDate, 1) : isoDate);
}

function time(hours, minutes) {
  const h = Number(hours);
  const m = Number(minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

// Выпадающий список недель — единственное место на странице, где сказано, каким
// календарным датам соответствуют классы w0, w1, … Без него строки таблицы
// не привязать ко дню, поэтому страница без списка считается непригодной.
function parseWeekMenu($) {
  const weeks = [];
  $('#weeks-menu a').each((_, link) => {
    const label = normalize($(link).text());
    const span = SPAN_RE.exec(label);
    const key = String($(link).attr('href') || '').slice(1);
    if (!span || !key) return;
    weeks.push({
      key,
      num: Number(WEEK_NUM_RE.exec(label)?.[1]) || weeks.length + 1,
      fromDay: Number(span[1]), fromMonth: Number(span[2]),
      toDay: Number(span[3]), toMonth: Number(span[4]),
    });
  });
  return weeks;
}

// Года на странице нет вообще: недели подписаны как «31.08-05.09». Год
// проставляем сами, увеличивая его там, где месяц пошёл назад — так семестр
// переживает переход через январь.
function assignYears(weeks, baseYear) {
  let year = baseYear;
  let previousMonth = null;
  return weeks.map(week => {
    if (previousMonth !== null && week.fromMonth < previousMonth) year += 1;
    previousMonth = week.fromMonth;
    const toYear = week.toMonth < week.fromMonth ? year + 1 : year;
    return {
      key: week.key,
      num: week.num,
      from: iso(year, week.fromMonth, week.fromDay),
      to: iso(toYear, week.toMonth, week.toDay),
    };
  });
}

// Год выбираем двумя признаками сразу. Первый жёсткий: учебная неделя на сайте
// всегда начинается с понедельника, и мимо года это почти наверняка не пройдёт.
// Второй разводит оставшиеся варианты по близости к сегодняшнему дню — иначе
// весенний семестр, выложенный осенью, уехал бы на год назад.
function resolveWeeks(weeks, today) {
  if (!weeks.length) return [];
  const base = Number(today.slice(0, 4));
  const distance = list => {
    const first = list[0].from;
    const last = list[list.length - 1].to;
    if (today >= first && today <= last) return 0;
    return Math.min(Math.abs(daysBetween(today, first)), Math.abs(daysBetween(today, last)));
  };
  const variants = [base - 1, base, base + 1].map(year => assignYears(weeks, year));
  const mondays = variants.filter(list => weekdayOf(list[0].from) === 0);
  return (mondays.length ? mondays : variants)
    .reduce((best, list) => (distance(list) < distance(best) ? list : best));
}

function splitSubject(text) {
  const withoutWeeks = text.replace(LEADING_WEEKS_RE, '').trim();
  const kind = KIND_RE.exec(withoutWeeks);
  if (!kind) return { subject: withoutWeeks, kind: '' };
  return { subject: withoutWeeks.slice(0, kind.index).trim(), kind: kind[1] };
}

// Группа лежит ссылкой внутри span, а рядом с ней в <sup> иногда стоит номер
// подгруппы. Берём текст ссылки, а не всей ячейки: без этого номер подгруппы
// прилип бы к названию группы без всякого разделителя.
function parseGroups($, cell) {
  const names = $(cell).children('span').toArray().map(span => {
    const $span = $(span);
    const sup = normalize($span.find('sup').text());
    let name = normalize($span.find('a').first().text());
    if (!name) {
      const plain = normalize($span.text());
      name = sup ? normalize(plain.slice(0, plain.lastIndexOf(sup))) : plain;
    }
    if (!name) return '';
    return sup ? `${name} (${sup})` : name;
  }).filter(Boolean);
  return [...new Set(names)].join(', ') || normalize($(cell).text());
}

// Строки таблицы идут сплошным списком, а день недели задаёт предыдущая строка
// класса wa. Поэтому разбор последовательный, а не по секциям.
function parseRows($) {
  const rows = [];
  let weekday = -1;
  $('#weeks-filter > tr').each((_, tr) => {
    const row = $(tr);
    const classes = String(row.attr('class') || '').split(/\s+/).filter(Boolean);
    if (classes.includes('wa')) {
      weekday = WEEKDAYS.indexOf(normalize(row.find('th').first().text()).toLowerCase());
      return;
    }
    if (weekday < 0) return;
    const cells = row.find('td');
    if (cells.length < 2) return;
    const slot = SLOT_RE.exec(normalize($(cells[0]).text()));
    if (!slot) return;
    const start = time(slot[1], slot[2]);
    const end = time(slot[3], slot[4]);
    if (!start || !end || start >= end) return;
    const { subject, kind } = splitSubject(normalize($(cells[1]).text()));
    if (!subject) return;
    rows.push({
      weekday,
      // Недели строки заданы классами w0, w1, … Текст в скобках их дублирует,
      // но диапазоны там записаны словами («5-7»), а классы — перечислением.
      weeks: classes.filter(name => /^w\d+$/.test(name)),
      start,
      end,
      subject,
      kind,
      room: normalize($(cells[2]).text()),
      groups: cells.length > 3 ? parseGroups($, cells[3]) : '',
    });
  });
  return rows;
}

function expand(rows, weeks, term) {
  const byKey = new Map(weeks.map(week => [week.key, week]));
  const lessons = [];
  for (const row of rows) {
    for (const key of row.weeks) {
      const week = byKey.get(key);
      if (!week) continue;
      const date = addDays(week.from, row.weekday);
      // Неделя бывает урезанной («02.11-07.11» вместо полной): день, вышедший
      // за её правую границу, на сайте не показывается — не показываем и мы.
      if (date > week.to) continue;
      lessons.push({
        date,
        start: row.start,
        end: row.end,
        subject: row.subject,
        kind: row.kind,
        room: row.room,
        groups: row.groups,
        week: week.num,
        term,
      });
    }
  }
  return lessons;
}

function sortLessons(lessons) {
  const seen = new Set();
  return lessons.filter(lesson => {
    const key = lessonKey(lesson);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date)
    || a.start.localeCompare(b.start)
    || a.subject.localeCompare(b.subject)
    || a.groups.localeCompare(b.groups));
}

function lessonKey(lesson) {
  return [lesson.date, lesson.start, lesson.end, lesson.subject, lesson.kind, lesson.room, lesson.groups].join('|');
}

// Разбор отделён от загрузки: тесты гоняют его на сохранённых страницах, а
// сеть в них не участвует вовсе.
function parsePage(html, { today, term = 1, part = 1, url = '' } = {}) {
  const $ = cheerio.load(html);
  const teacher = normalize($('h1 small').first().text());
  const siteUpdatedAt = SITE_UPDATED_RE.exec(normalize($('footer').text()))?.[1] || '';
  const head = { term, part, url, teacher, siteUpdatedAt, weeks: [], lessons: [] };
  // Пустая страница отличается от сломанной: сайт отвечает «Ничего не найдено»
  // и не печатает имя в заголовке. Это законное состояние — сессия или второй
  // семестр ещё не выложены, и молчать о нём в мониторинге правильно.
  if (!teacher) return { ...head, status: 'empty' };
  const weeks = resolveWeeks(parseWeekMenu($), today || todayIso());
  const rows = parseRows($);
  // Строки есть, а календаря недель нет — привязать занятия к датам нечем.
  // Это уже поломка разбора, и выдавать её за пустое расписание нельзя.
  if (!weeks.length) return { ...head, status: rows.length ? 'error' : 'empty', reason: 'нет календаря недель' };
  return {
    ...head,
    status: 'ok',
    weeks: weeks.map(week => ({ ...week, term })),
    // Сортируем здесь, а не только при склейке источников: порядок — часть
    // контракта разбора, и «ближайшая пара» ищется по нему обычным поиском.
    lessons: sortLessons(expand(rows, weeks, term)),
    rowCount: rows.length,
    // Строки без классов недель на сайте не показываются ни под одним фильтром;
    // считаем их, чтобы поломка вёрстки была видна в диагностике.
    undatedRows: rows.filter(row => !row.weeks.length).length,
  };
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'raspisanie-par-polessu-bot/1.0', 'Accept-Language': 'ru' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Заголовок длины может врать или отсутствовать, поэтому проверяем дважды:
    // до чтения тела и после.
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('response too large');
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_BYTES) throw new Error('response too large');
    const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get('content-type') || '')?.[1] || 'utf-8';
    try { return new TextDecoder(charset).decode(body); } catch { return body.toString('utf8'); }
  } finally {
    clearTimeout(timer);
  }
}

async function loadSource(source, today) {
  try {
    return parsePage(await fetchHtml(source.url), { ...source, today });
  } catch (error) {
    console.warn(`[schedule] ${source.url}:`, error.message);
    return { ...source, status: 'error', teacher: '', weeks: [], lessons: [], reason: error.message };
  }
}

function mergeWeeks(loaded) {
  const byKey = new Map();
  for (const source of loaded) {
    // Номера недель повторяются от семестра к семестру, поэтому ключ составной.
    for (const week of source.weeks) byKey.set(`${week.term}:${week.num}`, week);
  }
  return [...byKey.values()].sort((a, b) => a.from.localeCompare(b.from));
}

async function getSchedule({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  const today = todayIso();
  const loaded = await Promise.all(sources().map(source => loadSource(source, today)));
  const found = loaded.filter(source => source.status === 'ok');
  const answered = loaded.filter(source => source.status !== 'error');
  const payload = {
    today,
    generatedAt: new Date().toISOString(),
    teacher: found[0]?.teacher || TEACHER.name,
    // Три разных состояния, и мониторингу важно их различать: «ok» — расписание
    // разобрано; «empty» — сайт ответил, но преподавателя не показал ни на одной
    // странице; «unavailable» — сайт не ответил вовсе. Рассылку об изменениях
    // порождает только первое, иначе падение сайта выглядело бы как снятие всех пар.
    status: found.length ? 'ok' : answered.length ? 'empty' : 'unavailable',
    siteUpdatedAt: loaded.find(source => source.siteUpdatedAt)?.siteUpdatedAt || '',
    weeks: mergeWeeks(found),
    lessons: sortLessons(found.flatMap(source => source.lessons)),
    sources: loaded.map(({ term, part, url, status, reason }) => ({ term, part, url, status, ...(reason ? { reason } : {}) })),
  };
  cache = { at: Date.now(), payload };
  return payload;
}

function weekOf(payload, date) {
  return payload.weeks.find(week => date >= week.from && date <= week.to) || null;
}

// Чем закрыта дата. Различать обязательно: «пар нет» и «расписание на эту дату
// ещё не выкладывали» — разные утверждения, и врать про свободный день, которого
// сайт просто не публиковал, бот не должен. Воскресений в диапазонах недель нет
// вовсе (недели идут понедельник–суббота), поэтому день внутри семестра, но вне
// любой недели — это выходной, а не пробел в данных.
function coverage(payload, date) {
  if (weekOf(payload, date)) return 'week';
  if (!payload.weeks.length) return 'none';
  const first = payload.weeks[0].from;
  const last = payload.weeks[payload.weeks.length - 1].to;
  return date >= first && date <= last ? 'gap' : 'none';
}

function lessonsOn(payload, date) {
  return payload.lessons.filter(lesson => lesson.date === date);
}

module.exports = {
  TEACHER,
  TZ,
  WEEKDAYS,
  addDays,
  daysBetween,
  getSchedule,
  coverage,
  lessonKey,
  lessonsOn,
  parsePage,
  scheduleWeekStart,
  sortLessons,
  sources,
  todayIso,
  weekOf,
  weekStartOf,
  weekdayOf,
};
