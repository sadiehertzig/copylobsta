import { sendLauncherButton } from "./telegramBotApi.js";

const CHAT_ID = () => process.env.OPENCLAW_TELEGRAM_CHAT_ID;

/**
 * Send the web_app Mini App button to the configured chat on startup.
 * No polling needed — the gateway owns getUpdates (409 conflict otherwise).
 * The Mini App button opens directly in Telegram's WebView when tapped.
 */
export async function sendStartupButton() {
  const chatId = CHAT_ID();
  if (!chatId) {
    console.warn("OPENCLAW_TELEGRAM_CHAT_ID not set — skipping startup button");
    return;
  }

  try {
    await sendLauncherButton(chatId);
    console.log(`Sent Mini App launcher button to chat ${chatId}`);
  } catch (err) {
    console.error("Failed to send launcher button:", err.message);
  }
}

/**
 * Send a fresh Mini App button (called after a game ends).
 */
export async function sendNewRoundButton() {
  const chatId = CHAT_ID();
  if (chatId) {
    await sendLauncherButton(chatId);
  }
}
