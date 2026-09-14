const { dayStamp, escapeHtml, numericDate, shortPlace } = require('./format');
const { lessonKey } = require('./schedule');

// Формат снимка. Меняется то, что попадает в сравнение, — поля или источники
// занятий, — номер поднимается: снимок прошлой версии тогда считается базовым и
// не порождает рассылку об «изменениях», которых на сайте не было.
// 2 — к расписанию с сайта добавились занятия вне сайта (СМГ).
const SNAPSHOT_VERSION = 2;

// Больше этого числа строк в сообщении не показываем: остальное сворачивается
// в одну строку «и ещё N». Телеграм режет сообщение на 4096 символах, а читать
// простыню из полусотни правок всё равно невозможно.
const MAX_ROWS = 12;
// Публикация нового периода — это не «изменения», а появление расписания
// целиком. Перечислять его по одной паре бессмысленно, поэтому от этого порога
// сообщение сворачивается в сводку.
const BULK_LIMIT = 10;

// Что считаем «той же парой», которую могли передвинуть. Дата, время и
// аудитория сюда не входят намеренно: именно они и меняются при переносе.
function identityKey(lesson) {
  return [lesson.subject, lesson.kind, lesson.groups].join('|');
}

function scheduleSnapshot(payload) {
  return {
    version: SNAPSHOT_VERSION,
    // Дату держим для проверки смены суток: карточки надо перерисовать, даже
    // если на сайте ничего не менялось. В сравнении расписаний не участвует.
    today: payload.today || '',
    status: payload.status,
    weeks: payload.weeks.map(({ term, num, from, to }) => ({ term, num, from, to })),
    lessons: payload.lessons
      .map(({ date, start, end, subject, kind, room, groups }) => ({ date, start, end, subject, kind, room, groups }))
      .sort((a, b) => lessonKey(a).localeCompare(lessonKey(b))),
  };
}

// Прошедшие дни из сравнения выбрасываем. Иначе смена суток сама по себе
// выглядела бы как изменение: вчерашние пары никуда не делись, но говорить
// о них уже незачем, а окно разбора со временем их и вовсе теряет.
function upcoming(lessons, from) {
  return (lessons || []).filter(lesson => lesson.date >= from);
}

function byIdentity(lessons) {
  const map = new Map();
  for (const lesson of lessons) {
    const key = identityKey(lesson);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(lesson);
  }
  return map;
}

function describeEdit(before, after) {
  const timeChanged = before.start !== after.start || before.end !== after.end;
  const roomChanged = before.room !== after.room;
  return { timeChanged, roomChanged };
}

// Голый список «добавлено/удалено» для расписания читается плохо: перенос пары
// выглядит как две несвязанные строки, и глазами их приходится сшивать самому.
// Поэтому сначала сшиваем сами — по предмету, виду занятия и группе.
function pair(removed, added) {
  const moves = [];
  const leftAdded = new Map(byIdentity(added));
  const leftRemoved = [];
  for (const lesson of removed) {
    const candidates = leftAdded.get(identityKey(lesson));
    if (!candidates?.length) { leftRemoved.push(lesson); continue; }
    // Совпадение по дате берём первым: правка внутри дня вероятнее переноса на
    // другой день, и иначе пара могла бы «уехать» к чужому дню с тем же временем.
    let index = candidates.findIndex(candidate => candidate.date === lesson.date);
    if (index < 0) {
      index = candidates.reduce((best, candidate, current) => (
        Math.abs(Date.parse(candidate.date) - Date.parse(lesson.date))
          < Math.abs(Date.parse(candidates[best].date) - Date.parse(lesson.date)) ? current : best
      ), 0);
    }
    const [match] = candidates.splice(index, 1);
    moves.push({ before: lesson, after: match, ...describeEdit(lesson, match) });
  }
  return { moves, added: [...leftAdded.values()].flat(), removed: leftRemoved };
}

// День, у которого сняли все пары разом, — это одно событие, а не пять.
// Схлопываем его в строку: так видно главное, а не пять одинаковых «➖».
function collapseClearedDays(removed, nextLessons) {
  const stillBusy = new Set(nextLessons.map(lesson => lesson.date));
  const byDate = new Map();
  for (const lesson of removed) {
    if (!byDate.has(lesson.date)) byDate.set(lesson.date, []);
    byDate.get(lesson.date).push(lesson);
  }
  const clearedDays = [];
  const rest = [];
  for (const [date, lessons] of byDate) {
    if (!stillBusy.has(date) && lessons.length > 1) clearedDays.push({ date, count: lessons.length });
    else rest.push(...lessons);
  }
  return { clearedDays: clearedDays.sort((a, b) => a.date.localeCompare(b.date)), removed: rest };
}

function sortByWhen(lessons) {
  return [...lessons].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

function diffSchedules(previous, next) {
  const from = next.today || '';
  const before = upcoming(previous?.lessons, from);
  const after = upcoming(next.lessons, from);
  const beforeKeys = new Set(before.map(lessonKey));
  const afterKeys = new Set(after.map(lessonKey));
  const paired = pair(
    before.filter(lesson => !afterKeys.has(lessonKey(lesson))),
    after.filter(lesson => !beforeKeys.has(lessonKey(lesson))),
  );
  const collapsed = collapseClearedDays(paired.removed, after);
  return {
    moves: paired.moves.sort((a, b) => a.after.date.localeCompare(b.after.date) || a.after.start.localeCompare(b.after.start)),
    added: sortByWhen(paired.added),
    removed: sortByWhen(collapsed.removed),
    clearedDays: collapsed.clearedDays,
    // Сравнивали ли вообще с чем-то. Пустая история — не «всё расписание
    // добавили», а первая проверка, и сообщать о ней нечего.
    hadBaseline: Boolean(previous?.lessons?.length),
  };
}

function hasChanges(diff) {
  return Boolean(diff.moves.length || diff.added.length || diff.removed.length || diff.clearedDays.length);
}

function lessonTitle(lesson) {
  return `<b>${escapeHtml(lesson.subject)}</b>${lesson.kind ? ` — ${escapeHtml(lesson.kind)}` : ''}`
    + `${lesson.groups ? ` · ${escapeHtml(lesson.groups)}` : ''}`;
}

function when(lesson) {
  return `${dayStamp(lesson.date)} · ${lesson.start}–${lesson.end}`;
}

function moveRow(move) {
  const { before, after, timeChanged, roomChanged } = move;
  if (before.date !== after.date) {
    return `📆 ${lessonTitle(after)}<br />${escapeHtml(`${dayStamp(before.date)} ${before.start}`)}`
      + ` → <b>${escapeHtml(`${dayStamp(after.date)} ${after.start}`)}</b>`;
  }
  const icon = timeChanged && roomChanged ? '🔀' : timeChanged ? '🕐' : '🚪';
  const parts = [];
  if (timeChanged) parts.push(`${before.start}–${before.end} → <b>${after.start}–${after.end}</b>`);
  if (roomChanged) parts.push(`${escapeHtml(shortPlace(before.room) || '—')} → <b>${escapeHtml(shortPlace(after.room) || '—')}</b>`);
  return `${icon} ${lessonTitle(after)}<br />${escapeHtml(dayStamp(after.date))}: ${parts.join(' · ')}`;
}

function plainRow(icon, lesson) {
  const place = shortPlace(lesson.room);
  return `${icon} ${lessonTitle(lesson)}<br />${escapeHtml(when(lesson))}${place ? ` · ${escapeHtml(place)}` : ''}`;
}

function dateRange(lessons) {
  const dates = lessons.map(lesson => lesson.date).sort();
  return `${numericDate(dates[0])} – ${numericDate(dates[dates.length - 1])}`;
}

// Появление расписания на новый период — не десятки отдельных правок, а одно
// событие. Разворачивать его в список бессмысленно: читать никто не станет,
// а карточка рядом всё равно показывает актуальные дни.
function bulkSummary(diff) {
  if (!diff.moves.length && !diff.removed.length && !diff.clearedDays.length && diff.added.length >= BULK_LIMIT) {
    return `<h3>📚 Опубликовано расписание</h3><p>Добавлено ${diff.added.length} пар: ${escapeHtml(dateRange(diff.added))}.</p>`;
  }
  if (!diff.moves.length && !diff.added.length && diff.removed.length >= BULK_LIMIT && !diff.clearedDays.length) {
    return `<h3>📕 Расписание снято</h3><p>С сайта убрано ${diff.removed.length} пар: ${escapeHtml(dateRange(diff.removed))}.</p>`;
  }
  return null;
}

function formatChangeAlert(diff) {
  const bulk = bulkSummary(diff);
  if (bulk) return `${bulk}<footer>Карточка расписания выше уже обновлена.</footer>`;
  const rows = [
    ...diff.clearedDays.map(day => `❗ <b>${escapeHtml(dayStamp(day.date))}</b> — сняты все пары (${day.count})`),
    ...diff.moves.map(moveRow),
    ...diff.added.map(lesson => plainRow('➕', lesson)),
    ...diff.removed.map(lesson => plainRow('➖', lesson)),
  ];
  const shown = rows.slice(0, MAX_ROWS);
  const blocks = ['<h3>🔔 Расписание изменилось</h3>'];
  blocks.push(shown.map(row => `<p>${row}</p>`).join(''));
  if (rows.length > shown.length) blocks.push(`<p>И ещё ${rows.length - shown.length} ${rows.length - shown.length === 1 ? 'изменение' : 'изменений'}.</p>`);
  blocks.push('<footer>Карточка расписания выше уже обновлена.</footer>');
  return blocks.join('');
}

module.exports = {
  BULK_LIMIT,
  SNAPSHOT_VERSION,
  diffSchedules,
  formatChangeAlert,
  hasChanges,
  identityKey,
  lessonKey,
  scheduleSnapshot,
};
