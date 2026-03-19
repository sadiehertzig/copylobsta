function apiUrl(method) {
  return `https://api.telegram.org/bot${process.env.OPENCLAW_TELEGRAM_BOT_TOKEN}/${method}`;
}

export async function sendLauncherButton(chatId) {
  const miniAppUrl = `${process.env.APP_BASE_URL}/miniapp/`;
  const res = await fetch(apiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "Ready for voice trivia? Tap below to start!",
      reply_markup: {
        inline_keyboard: [[
          { text: "Start Voice Trivia", web_app: { url: miniAppUrl } }
        ]]
      }
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error: ${res.status} ${body}`);
  }
  return res.json();
}

export async function sendCallbackButton(chatId) {
  const res = await fetch(apiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "Ready for voice trivia? Tap below!",
      reply_markup: {
        inline_keyboard: [[
          { text: "Start Voice Trivia", callback_data: "trivia:start" }
        ]]
      }
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error: ${res.status} ${body}`);
  }
  return res.json();
}

export async function answerCallbackQuery(callbackQueryId, text) {
  const res = await fetch(apiUrl("answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {})
    })
  });
  return res.json();
}

export async function sendMessage(chatId, text) {
  const res = await fetch(apiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  return res.json();
}
