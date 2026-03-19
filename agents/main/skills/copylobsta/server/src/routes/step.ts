import { Router } from "express";
import { BOT_TOKEN } from "../config.js";
import { requireTelegramUser } from "../lib/telegramAuth.js";
import * as sessionStore from "../lib/sessionStore.js";
import { transition, getNextState, getStepNumber, TOTAL_STEPS } from "../lib/stateMachine.js";
import { stopTunnelByUrl } from "../lib/tunnelManager.js";
import type { SessionState } from "../types.js";

const router = Router();

/**
 * POST /api/step
 * Called by the Mini App when the user completes a step or takes an action.
 * Advances the state machine and returns the updated session.
 */
router.post("/api/step", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const user = requireTelegramUser(initData, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    const { action, data } = req.body || {};

    let updated;
    switch (action) {
      case "next": {
        const next = getNextState(session.state);
        if (!next) {
          res.status(400).json({ error: "no next state available" });
          return;
        }
        updated = transition(session, next);
        break;
      }
      case "goto": {
        const ALLOWED_GOTOS: Partial<Record<SessionState, SessionState[]>> = {
          AWS_SIGNUP_GUIDE: ["AWS_LAUNCH"],
          SOUL_REVIEW: ["SOUL_INTERVIEW"],
          USER_REVIEW: ["USER_INTERVIEW"],
        };
        const target = data?.target as SessionState | undefined;
        if (!target) {
          res.status(400).json({ error: "missing data.target for goto action" });
          return;
        }
        const allowed = ALLOWED_GOTOS[session.state];
        if (!allowed || !allowed.includes(target)) {
          res.status(403).json({ error: `goto ${target} not allowed from ${session.state}` });
          return;
        }
        updated = transition(session, target);
        break;
      }
      case "pause": {
        updated = transition(session, "PAUSED");
        break;
      }
      case "resume": {
        if (session.state !== "PAUSED") {
          res.status(400).json({ error: "session is not paused" });
          return;
        }
        if (!session.previousState) {
          res.status(400).json({ error: "no previous state to resume to" });
          return;
        }
        updated = transition(session, session.previousState);
        break;
      }
      case "cancel": {
        updated = transition(session, "ABANDONED");
        if (session.sharingSession?.launchUrl) {
          void stopTunnelByUrl(session.sharingSession.launchUrl);
        }
        const hasStack = !!session.aws.instanceId;
        res.json({
          session: {
            sessionId: updated.sessionId,
            state: updated.state,
            stepNumber: 0,
            totalSteps: TOTAL_STEPS,
          },
          message: hasStack
            ? "Session cancelled. Don't forget to delete your CloudFormation stack in AWS Console to avoid charges."
            : "Session cancelled.",
        });
        return;
      }
      default:
        res.status(400).json({ error: `unknown action: ${action}` });
        return;
    }

    if (updated.state === "COMPLETE" || updated.state === "FAILED" || updated.state === "ABANDONED") {
      if (updated.sharingSession?.launchUrl) {
        void stopTunnelByUrl(updated.sharingSession.launchUrl);
      }
      sessionStore.update(user.id, {
        sharingSession: {
          ...(updated.sharingSession || {
            launchUrl: "",
            setupBaseUrl: null,
            expiresAt: new Date().toISOString(),
            tunnelPid: null,
            status: "closed" as const,
          }),
          status: "closed",
        },
      });
    }

    res.json({
      session: {
        sessionId: updated.sessionId,
        state: updated.state,
        stepNumber: getStepNumber(updated.state),
        totalSteps: TOTAL_STEPS,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Step error:", message);
    res.status(400).json({ error: message });
  }
});

export default router;
