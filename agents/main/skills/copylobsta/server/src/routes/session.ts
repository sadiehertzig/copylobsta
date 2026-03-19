import { Router } from "express";
import { BOT_TOKEN, SHARING_ENABLED } from "../config.js";
import { requireTelegramUser } from "../lib/telegramAuth.js";
import * as sessionStore from "../lib/sessionStore.js";
import { getStepNumber, TOTAL_STEPS } from "../lib/stateMachine.js";
import { referralStore } from "./launch.js";

const router = Router();

/**
 * POST /api/session
 * Called by the Mini App on load. Validates initData, creates or resumes session.
 * Body: { startParam?: string } — deep-link token from launcher
 * Returns the session state so the Mini App knows which screen to show.
 */
router.post("/api/session", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const user = requireTelegramUser(initData, BOT_TOKEN);

    let session = sessionStore.getOrCreate(user.id, user.username || null);

    // Check for stale sessions (14 days inactive) — mark as abandoned
    if (sessionStore.isStale(session) && !["COMPLETE", "ABANDONED", "FAILED"].includes(session.state)) {
      sessionStore.update(user.id, { state: "ABANDONED" as const });
      // Start fresh
      session = sessionStore.getOrCreate(user.id, user.username || null);
    }

    // Bind referral context from deep-link start param (first load only)
    const { startParam } = req.body as { startParam?: string } || {};
    if (startParam && !session.referrerTelegramId) {
      const referral = referralStore.get(startParam);
      if (referral) {
        sessionStore.update(user.id, {
          referrerTelegramId: referral.referrerId ? Number(referral.referrerId) : null,
          groupChatId: referral.groupId ? Number(referral.groupId) : null,
          sharingEnabled: SHARING_ENABLED,
          sharingSession: {
            launchUrl: referral.launchUrl,
            setupBaseUrl: null,
            expiresAt: referral.expiresAt,
            tunnelPid: null,
            status: "active",
          },
        });
        referralStore.delete(startParam);
      }
    }

    // Determine if this is a resuming session (existing + in progress)
    const isResuming = session.state !== "WELCOME" && !["COMPLETE", "ABANDONED", "FAILED"].includes(session.state);

    // Re-read session in case referral context was just bound
    const current = sessionStore.get(user.id) || session;

    res.json({
      session: {
        sessionId: current.sessionId,
        state: current.state,
        stepNumber: getStepNumber(current.state),
        totalSteps: TOTAL_STEPS,
        aws: current.aws,
        sharingEnabled: current.sharingEnabled,
        sharingSession: current.sharingSession,
        credentials: current.credentials,
        soul: { approved: current.soul.approved, draftMarkdown: current.soul.draftMarkdown },
        user: { approved: current.user.approved, draftMarkdown: current.user.draftMarkdown },
        deploy: {
          stepsCompleted: current.deploy.stepsCompleted,
          error: current.deploy.error,
        },
        isResuming,
      },
      user: {
        id: user.id,
        firstName: user.first_name,
        username: user.username,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Session error:", message);
    res.status(401).json({ error: message });
  }
});

export default router;
