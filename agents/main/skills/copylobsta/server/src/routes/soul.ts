import { Router } from "express";
import { BOT_TOKEN } from "../config.js";
import { requireUser } from "../lib/telegramAuth.js";
import * as sessionStore from "../lib/sessionStore.js";
import { transition, getStepNumber, TOTAL_STEPS } from "../lib/stateMachine.js";
import { sendMessage } from "../lib/telegramBotApi.js";

const router = Router();

/**
 * POST /api/soul/answers
 * Save the soul interview answers and generate a SOUL.md draft.
 * Body: { answers: Record<string, string> }
 */
router.post("/api/soul/answers", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const sessionToken = req.headers["x-session-token"] as string || "";
    const user = requireUser(initData, sessionToken, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    const { answers } = req.body as { answers?: Record<string, string> };
    if (!answers || typeof answers !== "object") {
      res.status(400).json({ error: "missing answers object" });
      return;
    }

    // Generate SOUL.md from answers
    const draft = generateSoulDoc(answers);

    sessionStore.update(user.id, {
      soul: {
        ...session.soul,
        answers,
        draftMarkdown: draft,
      },
    });

    const updated = transition(session, "SOUL_REVIEW");

    res.json({
      session: {
        state: updated.state,
        stepNumber: getStepNumber(updated.state),
        totalSteps: TOTAL_STEPS,
      },
      draft,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/soul/approve
 * Approve the SOUL.md draft (optionally with edits) and advance to DEPLOY.
 * Body: { markdown?: string }
 */
router.post("/api/soul/approve", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const sessionToken = req.headers["x-session-token"] as string || "";
    const user = requireUser(initData, sessionToken, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    const { markdown } = req.body as { markdown?: string };
    const finalDoc = markdown || session.soul.draftMarkdown;
    if (!finalDoc) {
      res.status(400).json({ error: "no soul doc to approve" });
      return;
    }

    sessionStore.update(user.id, {
      soul: {
        ...session.soul,
        draftMarkdown: finalDoc,
        approved: true,
      },
    });

    const updated = transition(session, "USER_INTERVIEW");

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
 * POST /api/soul/deploy
 * Trigger deployment: send SOUL.md to the friend's instance and start the bot.
 */
router.post("/api/soul/deploy", async (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const sessionToken = req.headers["x-session-token"] as string || "";
    const user = requireUser(initData, sessionToken, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    if (!session.soul.approved || !session.soul.draftMarkdown) {
      res.status(400).json({ error: "soul doc not approved yet" });
      return;
    }

    if (!session.user.approved || !session.user.draftMarkdown) {
      res.status(400).json({ error: "user doc not approved yet" });
      return;
    }

    if (!session.aws.setupBaseUrl || !session.setupToken) {
      res.status(400).json({ error: "instance not ready" });
      return;
    }

    const setupUrl = session.aws.setupBaseUrl;

    // Send SOUL.md to the instance
    const deployRes = await fetch(`${setupUrl}/setup/deploy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": session.setupToken,
      },
      body: JSON.stringify({
        soulMarkdown: session.soul.draftMarkdown,
        userMarkdown: session.user.draftMarkdown,
        githubUsername: session.credentials.githubUsername,
        botUsername: session.credentials.botUsername,
        chatId: String(session.friendTelegramId),
      }),
    });

    const deployData = await deployRes.json() as { ok?: boolean; error?: string; botUsername?: string };

    if (!deployData.ok) {
      sessionStore.update(user.id, {
        deploy: {
          ...session.deploy,
          error: deployData.error || "Deploy failed",
        },
      });
      const failed = transition(session, "FAILED");
      res.json({
        session: {
          state: failed.state,
          stepNumber: getStepNumber(failed.state),
          totalSteps: TOTAL_STEPS,
        },
        error: deployData.error,
      });
      return;
    }

    sessionStore.update(user.id, {
      deploy: {
        ...session.deploy,
        startedAt: session.deploy.startedAt || new Date().toISOString(),
        completedAt: new Date().toISOString(),
        stepsCompleted: ["clone_repo", "install_deps", "write_soul", "write_user", "configure", "start_pm2", "health_check", "auto_restart"],
      },
    });

    const updated = transition(session, "HANDSHAKE");

    res.json({
      session: {
        state: updated.state,
        stepNumber: getStepNumber(updated.state),
        totalSteps: TOTAL_STEPS,
      },
      botUsername: deployData.botUsername || session.credentials.botUsername,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Deploy error:", message);
    res.status(502).json({ error: "Could not reach your server for deployment." });
  }
});

/**
 * GET /api/deploy/status
 * Proxy deploy progress from the friend's setup API.
 */
router.get("/api/deploy/status", async (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const sessionToken = req.headers["x-session-token"] as string || "";
    const user = requireUser(initData, sessionToken, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    if (!session.aws.setupBaseUrl || !session.setupToken) {
      res.status(400).json({ error: "instance not ready" });
      return;
    }

    const setupUrl = session.aws.setupBaseUrl;
    const statusRes = await fetch(`${setupUrl}/setup/deploy-status`, {
      headers: { "x-session-token": session.setupToken },
    });
    const data = await statusRes.json();
    res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

/**
 * POST /api/soul/complete
 * Mark onboarding as complete.
 */
router.post("/api/soul/complete", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const sessionToken = req.headers["x-session-token"] as string || "";
    const user = requireUser(initData, sessionToken, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    const updated = transition(session, "COMPLETE");

    // Notify the original group chat that the friend's bot is live
    if (session.groupChatId) {
      const botName = session.credentials.botUsername
        ? `@${session.credentials.botUsername}`
        : "their new bot";
      const friendName = session.friendUsername
        ? `@${session.friendUsername}`
        : "Your friend";
      const msg =
        `${friendName}'s bot ${botName} is live! 🦞\n\n` +
        `Want your own AI bot? Type /copylobsta`;
      sendMessage(session.groupChatId, msg).catch((err) => {
        console.error("Failed to send group notification:", err);
      });
    }

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

/** Generate a SOUL.md from interview answers (10-question version). */
function generateSoulDoc(answers: Record<string, string>): string {
  const name = answers.botName || "My Bot";
  const personality = answers.personality || "friendly and helpful";
  const vibe = answers.vibe || "";
  const relationship = answers.relationship || "helpful assistant";
  const pushback = answers.pushback || "";
  const neverJoke = answers.neverJoke || "";
  const expertise = answers.expertise || "";
  const quirks = answers.quirks || "";
  const frustrated = answers.frustrated || "";
  const character = answers.character || "";

  let doc = `# ${name}\n\n`;

  // Identity
  doc += `## Identity\n`;
  doc += `${name} is ${personality}.`;
  if (vibe) doc += ` Their vibe is ${vibe}.`;
  if (character) doc += ` Think ${character}.`;
  doc += `\n\n`;

  // Communication Style
  doc += `## Communication Style\n`;
  if (vibe) doc += `${name} communicates with a ${vibe} energy. `;
  if (quirks) doc += `Quirks: ${quirks}. `;
  if (pushback) doc += `On pushback: ${pushback}.`;
  doc += `\n\n`;

  // Relationship Dynamic
  doc += `## Relationship Dynamic\n`;
  doc += `${name}'s role is: ${relationship}.`;
  if (frustrated) doc += ` When the user is frustrated: ${frustrated}.`;
  doc += `\n\n`;

  // Boundaries
  if (neverJoke) {
    doc += `## Boundaries\n`;
    doc += `Never joke about: ${neverJoke}\n\n`;
  }

  // Expertise
  if (expertise) {
    doc += `## Expertise\n`;
    doc += `Especially knowledgeable about: ${expertise}\n\n`;
  }

  // Core Values
  doc += `## Core Values\n`;
  doc += `- Be authentic and consistent\n`;
  doc += `- Help users learn and grow\n`;
  doc += `- Respect boundaries\n`;
  doc += `- Stay curious and open-minded\n`;

  return doc;
}

export default router;
