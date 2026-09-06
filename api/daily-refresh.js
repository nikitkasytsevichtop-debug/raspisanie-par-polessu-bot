const { safeEqual } = require('../lib/auth');
const { getSchedule } = require('../lib/schedule');
const { cardView } = require('../lib/format');
const { editRichMessage } = require('../lib/telegram');
const { cardStore } = require('../lib/card-store');
const { refreshCards } = require('../lib/refresh');

// Резервный путь обновления карточек: если QStash молчит, Vercel Cron раз в
// сутки всё равно переведёт их на новый день. Разметку оба маршрута собирают
// одной функцией cardView.
module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (req.method !== 'GET') return res.status(405).json({ ok: false });
  if (!secret || !safeEqual(String(req.headers?.authorization || ''), `Bearer ${secret}`)) {
    return res.status(401).json({ ok: false });
  }

  try {
    const payload = await getSchedule({ force: true });
    // Сайт не ответил — карточки не трогаем: заменить рабочее расписание на
    // «данных нет» из-за одной неудачной попытки хуже, чем ничего не делать.
    // Через десять минут придёт очередная проверка QStash.
    if (payload.status !== 'ok') {
      return res.status(200).json({ ok: true, skipped: payload.status });
    }
    const result = await refreshCards({
      store: cardStore(),
      render: card => cardView(payload, card),
      edit: editRichMessage,
    });
    return res.status(200).json({ ok: true, date: payload.today, ...result });
  } catch (error) {
    console.error('[daily-refresh] failed:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
};
