import { Router } from "express";
import { BOT_TOKEN } from "../config.js";
import { requireUser } from "../lib/telegramAuth.js";
import * as sessionStore from "../lib/sessionStore.js";
import { transition, getNextState, getStepNumber, TOTAL_STEPS } from "../lib/stateMachine.js";
import type { SessionState, CredentialStatus } from "../types.js";

const router = Router();

/** Map provider names to credential fields and their next states. */
const PROVIDER_MAP: Record<string, { field: string; nextState: SessionState }> = {
  anthropic: { field: "anthropic", nextState: "CRED_GEMINI" },
  gemini: { field: "gemini", nextState: "CRED_OPENAI" },
  openai: { field: "openai", nextState: "CRED_TELEGRAM" },
  telegram: { field: "telegramToken", nextState: "SOUL_INTERVIEW" },
};

/**
 * POST /api/credentials/github
 * Store GitHub username or skip.
 * Body: { username: string | null }
 */
router.post("/api/credentials/github", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const sessionToken = req.headers["x-session-token"] as string || "";
    const user = requireUser(initData, sessionToken, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    const { username } = req.body as { username?: string | null };

    sessionStore.update(user.id, {
      credentials: {
        ...session.credentials,
        githubUsername: username || null,
      },
    });

    const updated = transition(session, "CRED_ANTHROPIC");

    res.json({
      session: {
        state: updated.state,
        stepNumber: getStepNumber(updated.state),
        totalSteps: TOTAL_STEPS,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/credentials/status
 * Called by Mini App after key validation on friend's instance.
 * NO key data in this request — only the validation result.
 * Body: { provider, valid, skipped?, botUsername? }
 */
router.post("/api/credentials/status", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const sessionToken = req.headers["x-session-token"] as string || "";
    const user = requireUser(initData, sessionToken, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    const { provider, valid, skipped, botUsername } = req.body as {
      provider?: string;
      valid?: boolean;
      skipped?: boolean;
      botUsername?: string;
    };

    if (!provider || !PROVIDER_MAP[provider]) {
      res.status(400).json({ error: `Invalid provider: ${provider}` });
      return;
    }

    // Only advance if the key was validated or explicitly skipped
    if (!valid && !skipped) {
      res.status(400).json({ error: "Credential must be valid or explicitly skipped to advance" });
      return;
    }

    const { field, nextState } = PROVIDER_MAP[provider];

    // Update credential status
    const credPatch: Record<string, CredentialStatus | string | null> = {
      [field]: (valid ? "valid" : skipped ? "skipped" : "unset") as CredentialStatus,
    };
    if (botUsername && provider === "telegram") {
      credPatch.botUsername = botUsername;
    }

    sessionStore.update(user.id, {
      credentials: { ...session.credentials, ...credPatch },
    });

    // Transition to next state
    const updated = transition(session, nextState);

    res.json({
      session: {
        state: updated.state,
        stepNumber: getStepNumber(updated.state),
        totalSteps: TOTAL_STEPS,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

export default router;
