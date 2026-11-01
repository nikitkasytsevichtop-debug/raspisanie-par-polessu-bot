const API = 'https://api.telegram.org';

async function tgApi(method, params) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.ok) {
    throw new Error(json.description || `Telegram API ${response.status}`);
  }
  return json.result;
}

function sendRichMessage(chatId, html, replyMarkup) {
  return tgApi('sendRichMessage', {
    chat_id: chatId,
    rich_message: { html, skip_entity_detection: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function deleteMessage(chatId, messageId) {
  return tgApi('deleteMessage', { chat_id: chatId, message_id: messageId });
}

function editRichMessage(chatId, messageId, html, replyMarkup) {
  return tgApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    rich_message: { html, skip_entity_detection: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function answerCallbackQuery(callbackQueryId, text) {
  return tgApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

module.exports = { tgApi, sendRichMessage, editRichMessage, answerCallbackQuery, deleteMessage };
