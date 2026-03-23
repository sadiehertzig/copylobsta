import crypto from "node:crypto";

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

// ── Session-token fallback for plain-URL (non-web_app) opens ────────────
// web_app inline buttons only work in Telegram DMs. When the mini app is
// opened via a plain URL button (group chats), there's no initData. After
// the first /api/session call validates a startParam, we issue a session
// token the client sends on all subsequent requests.

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const tokenStore = new Map<string, { user: TelegramUser; issuedAt: number }>();

/** Issue a session token for a user (initData-verified or startParam-verified). */
export function issueSessionToken(user: TelegramUser): string {
  const token = crypto.randomBytes(32).toString("hex");
  tokenStore.set(token, { user, issuedAt: Date.now() });
  // Prune expired tokens lazily
  for (const [k, v] of tokenStore) {
    if (Date.now() - v.issuedAt > TOKEN_TTL_MS) tokenStore.delete(k);
  }
  return token;
}

/** Resolve a session token to a user, or null if invalid/expired. */
export function resolveSessionToken(token: string): TelegramUser | null {
  if (!token) return null;
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (Date.now() - entry.issuedAt > TOKEN_TTL_MS) {
    tokenStore.delete(token);
    return null;
  }
  return entry.user;
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

/**
 * Require a user identity from initData, session token, or throw.
 * Tries initData first (Telegram-signed), falls back to session token.
 */
export function requireUser(
  initDataRaw: string,
  sessionToken: string,
  botToken: string,
): TelegramUser {
  // Try initData first (preferred, cryptographically signed)
  if (initDataRaw) {
    try {
      return requireTelegramUser(initDataRaw, botToken);
    } catch {
      // Fall through to session token
    }
  }
  // Try session token (issued after initial auth)
  const user = resolveSessionToken(sessionToken);
  if (user) return user;
  // Neither worked
  if (initDataRaw) {
    // Had initData but it failed — give the specific error
    return requireTelegramUser(initDataRaw, botToken);
  }
  throw new Error("missing initData");
}
