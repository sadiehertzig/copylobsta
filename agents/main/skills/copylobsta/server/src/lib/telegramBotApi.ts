import { BOT_TOKEN } from "../config.js";

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

/** Send the CopyLobsta Mini App launcher button to a chat.
 *  web_app inline buttons only work in private chats, so when sending to a
 *  group (BUTTON_TYPE_INVALID), we DM the user with the web_app button and
 *  post a notice in the group instead.
 */
export async function sendLauncherButton(
  chatId: string | number,
  startParam?: string,
  miniAppBaseUrl?: string,
  userId?: string | number | null,
): Promise<unknown> {
  const base = (miniAppBaseUrl || "").replace(/\/$/, "");
  if (!base) {
    throw new Error("Mini App base URL is required to send launcher button");
  }

  const miniAppUrl = startParam
    ? `${base}/miniapp/?start=${encodeURIComponent(startParam)}`
    : `${base}/miniapp/`;

  const primaryPayload = {
    chat_id: chatId,
    text:
      "Hey! I can help you set up your own AI bot — your own instance, your own keys, fully yours.\n\n" +
      "It takes about 30-45 minutes and I'll walk you through every step. Ready?",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Let's do it", web_app: { url: miniAppUrl } }],
      ],
    },
  };

  const res = await fetch(apiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(primaryPayload),
  });
  if (!res.ok) {
    const body = await res.text();
    if (body.includes("BUTTON_TYPE_INVALID")) {
      console.log("web_app button rejected (group chat) — falling back to DM");
      // web_app buttons only work in private chats. If we have the user's ID,
      // send the web_app button as a DM and post a notice in the group.
      if (userId) {
        // Send web_app button in DM
        const dmPayload = {
          chat_id: userId,
          text:
            "Hey! I can help you set up your own AI bot — your own instance, your own keys, fully yours.\n\n" +
            "It takes about 30-45 minutes and I'll walk you through every step. Ready?",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Let's do it", web_app: { url: miniAppUrl } }],
            ],
          },
        };
        const dmRes = await fetch(apiUrl("sendMessage"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dmPayload),
        });
        if (!dmRes.ok) {
          const dmBody = await dmRes.text();
          if (dmBody.includes("chat not found") || dmBody.includes("bot can't initiate")) {
            // User hasn't started a DM with the bot yet
            await sendMessage(
              chatId,
              "I need to send you the setup link in a DM, but it looks like we haven't chatted before!\n\n" +
              "Tap @clawdia_hertz_bot, hit Start, then try /copylobsta again here.",
            );
            return { ok: true, sentViaDm: false, needsStart: true };
          }
          throw new Error(`Telegram API error (DM): ${dmRes.status} ${dmBody}`);
        }
        // Notify the group
        await sendMessage(chatId, "I just sent the CopyLobsta setup link to your DM — check your messages!");
        return { ok: true, sentViaDm: true };
      }
      // No userId available — tell the group to DM the bot
      await sendMessage(
        chatId,
        "CopyLobsta setup needs to open in a DM. Send me /copylobsta in a direct message!",
      );
      return { ok: true, sentViaDm: false };
    }
    throw new Error(`Telegram API error: ${res.status} ${body}`);
  }
  return res.json();
}

/** Send a plain text message to a chat. */
export async function sendMessage(chatId: string | number, text: string): Promise<unknown> {
  const res = await fetch(apiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return res.json();
}

/** Delete a message (used for accidental key paste cleanup). */
export async function deleteMessage(chatId: string | number, messageId: number): Promise<unknown> {
  const res = await fetch(apiUrl("deleteMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  return res.json();
}
