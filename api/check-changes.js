const { safeEqual } = require('../lib/auth');
const { getSchedule, siteProbe, todayIso } = require('../lib/schedule');
const { ACK_KEYBOARD, cardView } = require('../lib/format');
const { cardStore } = require('../lib/card-store');
const { refreshCards, isRemovedCardError, inBatches } = require('../lib/refresh');
const { SNAPSHOT_VERSION, scheduleSnapshot, diffSchedules, formatChangeAlert, hasChanges } = require('../lib/change-monitor');
const { editRichMessage, sendRichMessage } = require('../lib/telegram');

// Полная проверка идёт не реже этого срока, даже когда метка сайта стоит на
// месте. Метка общая по университету и поднимается, судя по всему, при любой
// правке — но «судя по всему» не гарантия, а получасовой потолок оставляет
// сторожу право ошибаться, не превращая ошибку в потерянное изменение.
const FULL_CHECK_MS = 30 * 60 * 1000;

// Сообщение об изменениях одинаково для всех чатов, поэтому разметку собираем
// один раз и рассылаем только тем, у кого переключатель уведомлений включён.
async function notifyCards(store, cards, diff) {
  const html = formatChangeAlert(diff);
  let sent = 0;
  await inBatches(cards.filter(card => card.notify), async card => {
    try {
      await sendRichMessage(card.chatId, html, ACK_KEYBOARD);
      sent += 1;
    } catch (error) {
      if (isRemovedCardError(error)) await store.remove(card.chatId);
      else console.error(`[check-changes] уведомление ${card.chatId}:`, error.message);
    }
  });
  return sent;
}

module.exports = async (req, res) => {
  const secret = process.env.CHANGE_CHECK_SECRET;
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!secret || !safeEqual(String(req.headers?.authorization || ''), `Bearer ${secret}`)) {
    return res.status(401).json({ ok: false });
  }

  try {
    const store = cardStore();
    const today = todayIso();
    // Сначала лёгкая проба: одна страница вместо четырёх. Метка правки в её
    // подвале общая по университету, поэтому ложные срабатывания она даёт, а
    // пропусков — нет. Для сторожа это ровно та ошибка, которую можно терпеть.
    const [pulse, probe] = await Promise.all([store.getPulse(), siteProbe()]);
    const lastFull = Date.parse(pulse?.fullAt || '');
    // Битую метку времени считаем просроченной: иначе одна кривая запись
    // заперла бы сторож в закрытом положении навсегда.
    const overdue = !Number.isFinite(lastFull) || Date.now() - lastFull >= FULL_CHECK_MS;
    if (probe?.stamp && pulse?.stamp === probe.stamp && pulse.day === today && !overdue) {
      return res.status(200).json({ ok: true, gated: true, stamp: probe.stamp });
    }

    // Основную страницу проба уже принесла — второй раз за ней не ходим.
    const payload = await getSchedule({ force: true, primaryHtml: probe?.html || null });
    const stored = await store.getSnapshot();
    // Снимок другого формата сравнивать не с чем: считаем его отсутствующим,
    // первая же проверка после смены формата станет базовой и промолчит.
    const previous = stored?.version === SNAPSHOT_VERSION ? stored : null;
    // Пульс двигаем при любой полной попытке, удачной или нет: иначе после
    // недоступного сайта сторож остался бы просроченным навсегда. Метку при
    // неудаче оставляем прежнюю — тогда следующая проверка снова пойдёт в полную.
    const pulseUpdate = { stamp: probe?.stamp || pulse?.stamp || '', fullAt: new Date().toISOString(), day: today };

    // Главная защита от ложной рассылки. Пустой ответ сайта и отказ сайта
    // выглядят в снимке одинаково — как снятие всех пар разом, — поэтому
    // сравнивать и перезаписывать снимок можно только по настоящим данным.
    // Карточки при этом всё же перерисовываем на смене суток: показывать
    // вчерашнее расписание под сегодняшней датой хуже, чем честно сказать,
    // что данных нет.
    if (payload.status !== 'ok') {
      const dayChanged = previous ? previous.today !== today : false;
      if (dayChanged) {
        const cards = await store.list();
        await refreshCards({ store, cards, render: card => cardView(payload, card), edit: editRichMessage });
      }
      await store.savePulse(pulseUpdate);
      console.warn('[check-changes] источник не отдал расписание:', payload.status);
      return res.status(200).json({ ok: true, skipped: payload.status, dayChanged });
    }

    const cards = await store.list();
    const next = scheduleSnapshot(payload);
    const diff = previous ? diffSchedules(previous, next) : null;
    const changed = Boolean(diff && hasChanges(diff));
    // Первая проверка нового дня перерисовывает карточки даже без изменений:
    // иначе до первого нажатия кнопки они показывали бы вчерашнюю дату.
    const dayChanged = !previous || previous.today !== next.today;
    if (dayChanged || changed) {
      await refreshCards({ store, cards, render: card => cardView(payload, card), edit: editRichMessage });
    }
    const notifications = changed ? await notifyCards(store, cards, diff) : 0;
    // Снимок сохраняем последним: упади функция раньше или упрись в maxDuration,
    // следующая проверка найдёт те же изменения заново, а не потеряет их.
    await store.saveSnapshot(next);
    await store.savePulse({ ...pulseUpdate, stamp: payload.siteUpdatedAt || pulseUpdate.stamp });
    return res.status(200).json({
      ok: true,
      baseline: !previous,
      dayChanged,
      changed,
      lessons: next.lessons.length,
      notifications,
    });
  } catch (error) {
    console.error('[check-changes] failed:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
};
