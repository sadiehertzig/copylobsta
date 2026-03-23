import { Router } from "express";
import { BOT_TOKEN, SHARING_ENABLED } from "../config.js";
import {
  requireUser,
  issueSessionToken,
  type TelegramUser,
} from "../lib/telegramAuth.js";
import * as sessionStore from "../lib/sessionStore.js";
import { getStepNumber, TOTAL_STEPS } from "../lib/stateMachine.js";
import { referralStore } from "./launch.js";

const router = Router();

/**
 * POST /api/session
 * Called by the Mini App on load. Validates initData (or session token), creates
 * or resumes session. If auth is missing and a startParam is provided, the
 * request is allowed only when the launch link is identity-bound.
 *
 * Body: { startParam?: string, fresh?: boolean | "1" }
 * Returns the session state + a sessionToken the client must store.
 */
router.post("/api/session", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const sessionToken = req.headers["x-session-token"] as string || "";
    const body = (req.body || {}) as { startParam?: string; fresh?: boolean | string | number };
    const startParam = body.startParam;
    const rawFresh = body.fresh;
    const freshRequested = rawFresh === true || rawFresh === "1" || rawFresh === 1;

    let user: TelegramUser;
    let newToken: string | undefined;

    // Try initData or existing session token first
    try {
      user = requireUser(initData, sessionToken, BOT_TOKEN);
    } catch {
      // Neither initData nor session token — check for valid startParam
      const referral = startParam ? referralStore.get(startParam) : undefined;
      if (referral) {
        if (!referral.intendedUserId) {
          throw new Error("This launch link is missing a bound Telegram user. Relaunch /copylobsta.");
        }
        throw new Error("This launch link is bound to a Telegram user. Re-open from the bot message inside Telegram.");
      } else {
        throw new Error("missing initData");
      }
    }

    const referral = startParam ? referralStore.get(startParam) : undefined;
    const forceFresh = freshRequested || !!referral?.forceFresh;

    // Issue a session token (client stores it for subsequent requests)
    newToken = issueSessionToken(user);

    let session = forceFresh
      ? sessionStore.reset(user.id, user.username || null)
      : sessionStore.getOrCreate(user.id, user.username || null);

    // Check for stale sessions (14 days inactive) — mark as abandoned
    if (sessionStore.isStale(session) && !["COMPLETE", "ABANDONED", "FAILED"].includes(session.state)) {
      sessionStore.update(user.id, { state: "ABANDONED" as const });
      session = sessionStore.reset(user.id, user.username || null);
    }

    // Bind referral context from deep-link start param.
    if (startParam) {
      if (referral) {
        if (referral.intendedUserId && user.id !== Number(referral.intendedUserId)) {
          throw new Error("This launch link belongs to a different Telegram user.");
        }

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

    const isResuming = session.state !== "WELCOME" && !["COMPLETE", "ABANDONED", "FAILED"].includes(session.state);
    const current = sessionStore.get(user.id) || session;

    res.json({
      sessionToken: newToken,
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
