import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { DEFAULT_CHAT_ID, LAUNCH_SECRET, SHARING_ENABLED } from "../config.js";
import { sendLauncherButton } from "../lib/telegramBotApi.js";
import { ensureOnDemandTunnel } from "../lib/tunnelManager.js";

/** In-memory map of deep-link start params -> referral context. */
export const referralStore = new Map<string, {
  referrerId: string | null;
  groupId: string | null;
  intendedUserId: string | null;
  forceFresh: boolean;
  launchUrl: string;
  expiresAt: string;
}>();

const router = Router();

function safeSecretEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * POST /api/launch
 * Called by the host bot (via web_fetch) when someone invokes /copylobsta.
 * Starts/uses an on-demand Cloudflare tunnel and sends a launcher button.
 * Authenticated via x-launch-secret header.
 * Body: { chat_id?, referrer_id?, group_id?, user_id?, fresh? }
 */
router.post("/api/launch", async (req, res) => {
  try {
    if (!SHARING_ENABLED) {
      res.status(503).json({
        error: "Sharing is not enabled. The owner can enable it with /enable-sharing.",
      });
      return;
    }

    if (!LAUNCH_SECRET) {
      res.status(503).json({
        error: "Sharing is not configured: missing COPYLOBSTA_LAUNCH_SECRET.",
      });
      return;
    }

    const provided = req.headers["x-launch-secret"] as string || "";
    if (!safeSecretEquals(provided, LAUNCH_SECRET)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const chatId = req.body?.chat_id || DEFAULT_CHAT_ID;
    if (!chatId) {
      res.status(400).json({ error: "missing chat_id" });
      return;
    }

    const referrerId = req.body?.referrer_id || null;
    const groupId = req.body?.group_id || null;
    const requestedUserId = req.body?.user_id || null;
    const rawFresh = req.body?.fresh;
    const forceFresh = rawFresh === undefined ? true : (rawFresh === true || rawFresh === "1" || rawFresh === 1);
    const userId = requestedUserId || (!groupId ? chatId : null);
    if (!userId) {
      res.status(400).json({
        error: "missing user_id for group launch",
      });
      return;
    }

    const tunnel = await ensureOnDemandTunnel(String(chatId));

    const startParam = randomBytes(8).toString("hex");
    referralStore.set(startParam, {
      referrerId,
      groupId,
      intendedUserId: String(userId),
      forceFresh,
      launchUrl: tunnel.url,
      expiresAt: tunnel.expiresAt,
    });

    // Cleanup old entries (older than 2 hours)
    for (const [key, val] of referralStore) {
      if (Date.now() - new Date(val.expiresAt).getTime() > 7_200_000) {
        referralStore.delete(key);
      }
    }

    await sendLauncherButton(chatId, startParam, tunnel.url, userId);
    res.json({ ok: true, startParam, launchUrl: tunnel.url, expiresAt: tunnel.expiresAt, forceFresh });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Launch error:", message);
    res.status(500).json({ error: `Could not start sharing session: ${message}` });
  }
});

export default router;
