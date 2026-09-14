const { TEACHER, TZ, addDays, coverage, lessonsOn, scheduleWeekStart, sources, weekOf, weekdayOf } = require('./schedule');

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const WEEKDAYS_LONG = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
// Страница преподавателя одна на все четыре источника — ссылку в подписи ведём
// на основную, где расписание лежит в течение семестра.
const TEACHER_URL = sources()[0].url;
// Стандартные перерывы между парами — 15 и 30 минут. Всё, что длиннее, это
// пропущенная пара, то есть окно: преподавателю оно важнее самих перерывов.
const WINDOW_MIN = 35;
// Длинные названия предметов в недельной карточке не помещаются. Сокращения
// косметические: в карточке дня и в сравнении расписаний участвует полное имя.
const SHORTCUTS = [
  [/^Физическая культура в учреждениях дошкольного образования$/i, 'Физкультура в УДО'],
  [/^Физическая культура$/i, 'Физкультура'],
];
const SHORT_LIMIT = 26;
// Название корпуса длиннее номера аудитории и в недельной строке съедает место.
// Уточнение «ПолесГУ» в расписании одного университета ничего не добавляет.
const PLACE_SUFFIX_RE = /\s+ПолесГУ$/i;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plural(count, forms) {
  const tens = count % 100;
  if (tens >= 11 && tens <= 14) return forms[2];
  const ones = count % 10;
  if (ones === 1) return forms[0];
  if (ones >= 2 && ones <= 4) return forms[1];
  return forms[2];
}

function lessonsWord(count) {
  return `${count} ${plural(count, ['пара', 'пары', 'пар'])}`;
}

function dayNumber(iso) {
  return Number(iso.slice(8, 10));
}

function dateLabel(iso) {
  return `${WEEKDAYS_LONG[weekdayOf(iso)].toLowerCase()}, ${dayNumber(iso)} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

function shortLabel(iso) {
  return `${WEEKDAYS_SHORT[weekdayOf(iso)]} ${iso.slice(8, 10)}`;
}

// «чт 24.09» — день недели и дата одной меткой. Держим её здесь, а не собираем
// из shortLabel и numericDate на месте: собранная из двух кусков, она дважды
// печатала число дня.
function dayStamp(iso) {
  return `${WEEKDAYS_SHORT[weekdayOf(iso)]} ${numericDate(iso)}`;
}

function numericDate(iso) {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

function minutes(time) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function duration(total) {
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest} мин`;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ${plural(hours, ['час', 'часа', 'часов'])}`;
}

// Номер аудитории и название корпуса читаются по-разному: «ауд. 3430» и
// «Спорткомплекс ПолесГУ». Подпись выбираем по виду значения, а не по списку
// известных мест — новый корпус тогда не придётся вносить в код.
function placeLabel(room) {
  if (!room) return '';
  return /^\d+[а-я]?$/i.test(room) ? `🚪 ауд. ${room}` : `📍 ${room}`;
}

function shortPlace(room) {
  if (!room) return '';
  return /^\d+[а-я]?$/i.test(room) ? `ауд. ${room}` : room.replace(PLACE_SUFFIX_RE, '');
}

function shortSubject(subject) {
  const known = SHORTCUTS.find(([pattern]) => pattern.test(subject));
  if (known) return known[1];
  if (subject.length <= SHORT_LIMIT) return subject;
  const cut = subject.slice(0, SHORT_LIMIT);
  const space = cut.lastIndexOf(' ');
  return `${(space > SHORT_LIMIT / 2 ? cut.slice(0, space) : cut).trim()}…`;
}

function lessonBlock(lesson) {
  const title = `<b>${lesson.start}–${lesson.end}</b> · ${escapeHtml(lesson.subject)}${lesson.kind ? ` — ${escapeHtml(lesson.kind)}` : ''}`;
  const meta = [placeLabel(lesson.room), lesson.groups ? `👥 ${escapeHtml(lesson.groups)}` : '']
    .filter(Boolean).join(' · ');
  return `<blockquote>${title}${meta ? `<br />${meta}` : ''}</blockquote>`;
}

// Первая пара после указанной даты. Нужна пустым дням: «занятий нет» без
// подсказки, когда они снова будут, заставляет листать карточку вручную.
function nextLesson(payload, date) {
  return payload.lessons.find(lesson => lesson.date > date) || null;
}

// Недельная карточка называет ту же причину, но говорит о неделе: учебная
// неделя без пар бывает, и «свободный день» под её заголовком был бы неправдой.
function emptyText(payload, date, view = 'd') {
  const state = coverage(payload, date);
  if (payload.status === 'unavailable') return 'Сайт университета не отвечает — данные временно недоступны.';
  if (payload.status === 'empty') return 'Расписание на сайте сейчас не опубликовано.';
  if (state === 'none') return 'Расписание на эту дату ещё не опубликовано.';
  if (state === 'gap') return 'Выходной — занятий нет.';
  return view === 'w' ? 'Пар нет — свободная неделя.' : 'Пар нет — свободный день.';
}

function dayCard(payload, date) {
  const lessons = lessonsOn(payload, date);
  const week = weekOf(payload, date);
  const blocks = [`<h3>${escapeHtml(dateLabel(date))}</h3>`];
  if (!lessons.length) {
    blocks.push(`<p>${escapeHtml(emptyText(payload, date))}</p>`);
    const upcoming = nextLesson(payload, date);
    if (upcoming) {
      blocks.push(`<p>Ближайшие пары — <b>${escapeHtml(dateLabel(upcoming.date))}</b>, начало в ${upcoming.start}.</p>`);
    }
    return blocks.join('');
  }
  const span = `${lessons[0].start}–${lessons[lessons.length - 1].end}`;
  blocks.push(`<p>${week ? `Неделя ${week.num} · ` : ''}${lessonsWord(lessons.length)} · ${span}</p>`);
  lessons.forEach((lesson, index) => {
    const previous = lessons[index - 1];
    const gap = previous ? minutes(lesson.start) - minutes(previous.end) : 0;
    // Окно показываем строкой между парами, а не в шапке: так видно, где именно
    // в дне разрыв, и не нужно считать его по времени начала самому.
    if (gap >= WINDOW_MIN) blocks.push(`<p>⌛ окно ${escapeHtml(duration(gap))}</p>`);
    blocks.push(lessonBlock(lesson));
  });
  return blocks.join('');
}

function weekDayLine(payload, date) {
  const lessons = lessonsOn(payload, date);
  const heading = `<b>${WEEKDAYS_SHORT[weekdayOf(date)]} ${numericDate(date)}</b>`;
  if (!lessons.length) return `<p>${heading} — свободно</p>`;
  const rows = lessons.map(lesson => {
    const place = lesson.room ? ` · ${escapeHtml(shortPlace(lesson.room))}` : '';
    return `${lesson.start} ${escapeHtml(shortSubject(lesson.subject))}${lesson.groups ? ` · ${escapeHtml(lesson.groups)}` : ''}${place}`;
  });
  return `<blockquote>${heading} · ${lessonsWord(lessons.length)}<br />${rows.join('<br />')}</blockquote>`;
}

function weekCard(payload, date) {
  const start = scheduleWeekStart(date);
  const week = weekOf(payload, date) || weekOf(payload, start);
  // Неделя на сайте идёт понедельник–суббота; воскресенье в диапазон не входит,
  // и показывать его отдельной пустой строкой незачем.
  const days = Array.from({ length: 6 }, (_, index) => addDays(start, index));
  const total = days.reduce((sum, day) => sum + lessonsOn(payload, day).length, 0);
  const title = week ? `Неделя ${week.num} · ${numericDate(week.from)} – ${numericDate(week.to)}`
    : `${numericDate(start)} – ${numericDate(addDays(start, 5))}`;
  const blocks = [`<h3>🗓 ${escapeHtml(title)}</h3>`];
  if (!total) {
    // Причину берём по понедельнику показанной недели, а не по дате: в
    // воскресенье карточка уже смотрит на следующую неделю, а само воскресенье —
    // выходной.
    blocks.push(`<p>${escapeHtml(emptyText(payload, start, 'w'))}</p>`);
    return blocks.join('');
  }
  blocks.push(`<p>${lessonsWord(total)} за неделю</p>`);
  for (const day of days) blocks.push(weekDayLine(payload, day));
  return blocks.join('');
}

function footer(payload) {
  const generated = new Date(payload.generatedAt || Date.now());
  const unix = Math.floor(generated.getTime() / 1000);
  const fallback = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(generated);
  // Метка сайта и время проверки — разные вещи: первая говорит, когда учебная
  // часть правила расписание, вторая — когда бот последний раз туда смотрел.
  const site = payload.siteUpdatedAt ? ` · сайт от ${escapeHtml(payload.siteUpdatedAt.replace(/\.\d{4}\s/, ' '))}` : '';
  return `<footer><a href="${escapeHtml(TEACHER_URL)}">${escapeHtml(TEACHER.short)}</a>${site}`
    + ` · <tg-time unix="${unix}" format="dt">${escapeHtml(fallback)}</tg-time></footer>`;
}

function render(payload, date, view) {
  return (view === 'w' ? weekCard(payload, date) : dayCard(payload, date)) + footer(payload);
}

function navLabel(payload, target, view, left) {
  if (view !== 'w') return left ? `‹ ${shortLabel(target)}` : `${shortLabel(target)} ›`;
  const week = weekOf(payload, target) || weekOf(payload, scheduleWeekStart(target));
  const text = week ? `Нед. ${week.num}` : numericDate(scheduleWeekStart(target));
  return left ? `‹ ${text}` : `${text} ›`;
}

// Два ряда, по одному вопросу на ряд: куда смотреть — и чем управлять.
// Дата и вид едут в callback_data целиком, поэтому кнопка остаётся рабочей
// даже после перезапуска функции, у которой нет ничего в памяти.
function keyboard(payload, date, view, notify) {
  const step = view === 'w' ? 7 : 1;
  const previous = addDays(date, -step);
  const next = addDays(date, step);
  return {
    inline_keyboard: [
      [
        { text: navLabel(payload, previous, view, true), callback_data: `d:${previous}:${view}` },
        { text: view === 'w' ? 'Эта неделя' : 'Сегодня', callback_data: `d:${payload.today}:${view}` },
        { text: navLabel(payload, next, view, false), callback_data: `d:${next}:${view}` },
      ],
      [
        { text: view === 'w' ? '📅 День' : '🗓 Неделя', callback_data: `v:${date}:${view}` },
        { text: notify ? '🔔 вкл' : '🔕 выкл', callback_data: `n:${date}:${view}` },
        { text: '↻', callback_data: `r:${date}:${view}` },
      ],
    ],
  };
}

// Карточка чата целиком: разметку и клавиатуру собирает одна функция, поэтому
// фоновое обновление рисует ровно то же, что и нажатие кнопки.
function cardView(payload, settings) {
  const view = settings?.view === 'w' ? 'w' : 'd';
  // Карточка не застревает во вчерашнем дне: дату из прошлого фоновое
  // обновление подтягивает на сегодня, дату из будущего оставляет как есть —
  // пользователь мог открыть её нарочно.
  const date = settings?.date && settings.date >= payload.today ? settings.date : payload.today;
  return {
    date,
    view,
    html: render(payload, date, view),
    replyMarkup: keyboard(payload, date, view, settings?.notify !== false),
  };
}

// Кнопка под сообщением об изменениях: по нажатию сообщение удаляется, чтобы
// в чате оставалась одна актуальная карточка, а не лента старых уведомлений.
const ACK_KEYBOARD = { inline_keyboard: [[{ text: '✓ Ознакомлен', callback_data: 'ack' }]] };

module.exports = {
  ACK_KEYBOARD,
  cardView,
  dateLabel,
  dayStamp,
  dayCard,
  escapeHtml,
  keyboard,
  lessonsWord,
  numericDate,
  placeLabel,
  render,
  shortLabel,
  shortPlace,
  shortSubject,
  weekCard,
};
