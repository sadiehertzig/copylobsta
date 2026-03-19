import { Router } from "express";
import { BOT_TOKEN } from "../config.js";
import { requireTelegramUser } from "../lib/telegramAuth.js";
import * as sessionStore from "../lib/sessionStore.js";
import { transition, getStepNumber, TOTAL_STEPS } from "../lib/stateMachine.js";

const router = Router();

/**
 * POST /api/user/answers
 * Save user interview answers and generate a USER.md draft.
 * Body: { answers: Record<string, string> }
 */
router.post("/api/user/answers", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const user = requireTelegramUser(initData, BOT_TOKEN);

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

    const draft = generateUserDoc(answers);

    sessionStore.update(user.id, {
      user: {
        ...session.user,
        answers,
        draftMarkdown: draft,
      },
    });

    const updated = transition(session, "USER_REVIEW");

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
 * POST /api/user/approve
 * Approve the USER.md draft (optionally with edits) and advance to DEPLOY.
 * Body: { markdown?: string }
 */
router.post("/api/user/approve", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const user = requireTelegramUser(initData, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    const { markdown } = req.body as { markdown?: string };
    const finalDoc = markdown || session.user.draftMarkdown;
    if (!finalDoc) {
      res.status(400).json({ error: "no user doc to approve" });
      return;
    }

    sessionStore.update(user.id, {
      user: {
        ...session.user,
        draftMarkdown: finalDoc,
        approved: true,
      },
    });

    const updated = transition(session, "DEPLOY");

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

/** Generate a USER.md from interview answers. Handles student and adult branches. */
function generateUserDoc(answers: Record<string, string>): string {
  const name = answers.name || "User";
  const branch = answers.branch || "adult";

  let doc = `# User Document\n\n`;

  if (branch === "student") {
    // About
    doc += `## About\n`;
    doc += `${name} is a ${answers.grade || "student"}`;
    if (answers.school) doc += ` at ${answers.school}`;
    doc += `.\n\n`;

    // Academics
    doc += `## Academics\n`;
    if (answers.subjects) doc += `Current subjects: ${answers.subjects}\n`;
    if (answers.helpSubjects) doc += `Needs most help with: ${answers.helpSubjects}\n`;
    if (answers.studyStyle) doc += `Study style: ${answers.studyStyle}\n`;
    doc += `\n`;

    // Interests
    if (answers.interests) {
      doc += `## Interests\n${answers.interests}\n\n`;
    }

    // Goals
    if (answers.goals) {
      doc += `## Goals\n${answers.goals}\n\n`;
    }

    // Preferences
    doc += `## Preferences\n`;
    if (answers.pushOrEasy) doc += `- Feedback style: ${answers.pushOrEasy}\n`;
    if (answers.studyStyle) doc += `- Study approach: ${answers.studyStyle}\n`;
    doc += `\n`;
  } else {
    // Adult path
    doc += `## About\n`;
    doc += `${name}`;
    if (answers.occupation) doc += ` \u2014 ${answers.occupation}`;
    doc += `.\n\n`;

    // Work & Expertise
    doc += `## Work & Expertise\n`;
    if (answers.botUseCase) doc += `Uses bot for: ${answers.botUseCase}\n`;
    if (answers.expertiseAreas) doc += `Key topics: ${answers.expertiseAreas}\n`;
    if (answers.skillLevel) doc += `Skill level: ${answers.skillLevel}\n`;
    doc += `\n`;

    // Interests
    if (answers.interests) {
      doc += `## Interests\n${answers.interests}\n\n`;
    }

    // Goals
    if (answers.goals) {
      doc += `## Goals\n${answers.goals}\n\n`;
    }

    // Preferences
    doc += `## Preferences\n`;
    if (answers.learnStyle) doc += `- Learning style: ${answers.learnStyle}\n`;
    if (answers.pushOrEasy) doc += `- Feedback style: ${answers.pushOrEasy}\n`;
    doc += `\n`;
  }

  // Notes (shared)
  if (answers.anythingElse) {
    doc += `## Notes\n${answers.anythingElse}\n`;
  }

  return doc;
}

export default router;
