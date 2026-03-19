import crypto from "node:crypto";

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/**
 * Validate Telegram Mini App initData and extract the user object.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function requireTelegramUser(
  initDataRaw: string,
  botToken: string,
  { maxAgeSeconds = 3600 } = {}
): TelegramUser {
  if (!initDataRaw) throw new Error("missing initData");
  if (!botToken) throw new Error("missing bot token");

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get("hash");
  if (!hash) throw new Error("missing hash in initData");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const computed = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (computed !== hash) throw new Error("invalid initData signature");

  const authDate = Number(params.get("auth_date") || 0);
  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > maxAgeSeconds) throw new Error("initData expired");

  return JSON.parse(params.get("user") || "{}") as TelegramUser;
}
