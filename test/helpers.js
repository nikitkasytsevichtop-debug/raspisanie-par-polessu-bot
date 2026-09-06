const { addDays, weekStartOf } = require('../lib/schedule');

const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function ddmm(iso) {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

// Страница в вёрстке сайта, но с датами вокруг переданного дня. Фикстура с
// жёстко зашитым семестром однажды уехала бы от «сегодня» на годы, и разбор
// начал бы выбирать другой год — тесты, зависящие от дат, обязаны строить
// страницу сами.
function buildPage({ today, weeks = 2, teacher = 'Сыцевич Мария Владимировна', lessons = [], updatedAt = '01.09.2026 10:00' }) {
  const first = weekStartOf(today);
  const ranges = Array.from({ length: weeks }, (_, index) => {
    const from = addDays(first, index * 7);
    return { key: `w${index}`, num: index + 1, from, to: addDays(from, 5) };
  });
  const menu = [`<li><a href="#">На семестр (${ddmm(ranges[0].from)}-${ddmm(ranges[ranges.length - 1].to)})</a></li>`]
    .concat(ranges.map(range => `<li><a href="#${range.key}">Неделя ${range.num} (${ddmm(range.from)}-${ddmm(range.to)})</a></li>`))
    .join('');
  const body = WEEKDAYS.map((name, weekday) => {
    const rows = lessons.filter(lesson => lesson.weekday === weekday).map(lesson => {
      const classes = lesson.weeks.map(index => `w${index}`).join(' ');
      const numbers = lesson.weeks.map(index => index + 1).join(', ');
      return `<tr class="${classes} s${lesson.subject.length.toString(16)}abc">`
        + `<td>${lesson.time}</td>`
        + `<td>(${numbers}) ${lesson.subject}${lesson.kind ? ` - ${lesson.kind}` : ''}</td>`
        + `<td><span>${lesson.room}</span></td>`
        + `<td><span><a href="?q=ABC&f=1">${lesson.group}</a> <sup>${lesson.sub || ''}</sup></span></td></tr>`;
    }).join('');
    return `<tr class="wa"><th>${name}</th><th>(Неделя) Предмет</th><th>Аудитория</th><th>Группа</th></tr>${rows}`;
  }).join('');
  return `<!DOCTYPE html><html lang="ru"><body>
    <section><div class="container">
      <h1>Расписание занятий <small>${teacher}</small></h1>
      <div class="btn-group pull-right hidden-print">
        <ul id="weeks-menu" class="dropdown-menu">${menu}</ul>
      </div>
      <table class="table"><tbody id="weeks-filter">${body}</tbody></table>
    </div></section>
    <footer><div class="container"><p class="small">Последние изменения вносились: ${updatedAt}<br>
      Телефон для справок: 36-38-36</p></div></footer>
  </body></html>`;
}

// Страница, которую сайт отдаёт, когда по запросу ничего не нашлось.
function emptyPage(updatedAt = '01.09.2026 10:00') {
  return `<!DOCTYPE html><html lang="ru"><body><section><div class="container">
    <h1>Расписание занятий</h1><p>Ничего не найдено.</p>
  </div></section><footer><p class="small">Последние изменения вносились: ${updatedAt}</p></footer></body></html>`;
}

module.exports = { buildPage, emptyPage, ddmm };

// Фальшивый Redis: понимает ровно те команды, которыми пользуется card-store.
// Незнакомая команда — ошибка, а не тихий null: молчаливая заглушка спрятала бы
// опечатку в имени команды до продакшена.
function createFakeRedis() {
  const strings = new Map();
  const sets = new Map();
  const hashes = new Map();

  function run([command, key, ...args]) {
    switch (command) {
      case 'GET': return strings.get(key) ?? null;
      case 'SET': strings.set(key, args[0]); return 'OK';
      case 'DEL': return Number(strings.delete(key) || hashes.delete(key));
      case 'SADD': {
        if (!sets.has(key)) sets.set(key, new Set());
        sets.get(key).add(args[0]);
        return 1;
      }
      case 'SREM': sets.get(key)?.delete(args[0]); return 1;
      case 'SMEMBERS': return [...(sets.get(key) || [])];
      case 'HSET': {
        if (!hashes.has(key)) hashes.set(key, new Map());
        const hash = hashes.get(key);
        for (let i = 0; i + 1 < args.length; i += 2) hash.set(args[i], String(args[i + 1]));
        return 1;
      }
      // Upstash REST отдаёт HGETALL плоским массивом — воспроизводим форму.
      case 'HGETALL': return [...(hashes.get(key) || new Map())].flat();
      default: throw new Error(`fake redis: неизвестная команда ${command}`);
    }
  }

  return { strings, sets, hashes, run, reset() { strings.clear(); sets.clear(); hashes.clear(); } };
}

module.exports.createFakeRedis = createFakeRedis;
