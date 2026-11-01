function isRemovedCardError(error) {
  return /(chat not found|bot was blocked by the user|user is deactivated|message to edit not found)/i.test(String(error?.message || error));
}

function isUnchangedMessageError(error) {
  return /message is not modified/i.test(String(error?.message || error));
}

// Telegram ограничивает бота примерно тридцатью сообщениями в секунду: шлём
// пачками, а не одним Promise.all на всех — иначе при росте числа чатов
// посыплются 429.
async function inBatches(items, handler, size = 25) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(handler));
  }
}

// render получает запись чата целиком: у каждого чата своя дата и свой вид
// карточки, поэтому разметку собираем отдельно для каждой.
async function refreshCards({ store, render, edit, cards }) {
  const list = cards || await store.list();
  const results = { total: list.length, updated: 0, unchanged: 0, removed: 0, failed: 0 };
  await inBatches(list, async card => {
    try {
      const { html, replyMarkup } = render(card);
      await edit(card.chatId, card.messageId, html, replyMarkup);
      results.updated += 1;
    } catch (error) {
      if (isUnchangedMessageError(error)) {
        // Разметка совпала с той, что уже в чате: обновлять нечего, и ошибкой
        // это не является.
        results.unchanged += 1;
      } else if (isRemovedCardError(error)) {
        // Чат удалён, бот заблокирован или карточку стёрли — чистим запись,
        // иначе она будет падать при каждой следующей проверке.
        await store.remove(card.chatId);
        results.removed += 1;
      } else {
        console.error(`[refresh] ${card.chatId}:`, error.message);
        results.failed += 1;
      }
    }
  });
  return results;
}

module.exports = { refreshCards, isRemovedCardError, isUnchangedMessageError, inBatches };
