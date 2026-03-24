import type { Session, SessionState } from "../types.js";
import * as store from "./sessionStore.js";

/** Valid transitions: from → allowed destinations. */
const TRANSITIONS: Record<SessionState, SessionState[]> = {
  WELCOME: ["AWS_ACCOUNT_CHECK"],
  AWS_ACCOUNT_CHECK: ["AWS_SIGNUP_GUIDE", "AWS_LAUNCH"],
  AWS_SIGNUP_GUIDE: ["AWS_LAUNCH"],
  AWS_LAUNCH: ["INSTANCE_VERIFY"],
  INSTANCE_VERIFY: ["CRED_GITHUB"],
  CRED_GITHUB: ["CRED_ANTHROPIC"],
  CRED_ANTHROPIC: ["CRED_GEMINI"],
  CRED_GEMINI: ["CRED_OPENAI"],
  CRED_OPENAI: ["CRED_TELEGRAM"],
  CRED_TELEGRAM: ["SOUL_INTERVIEW"],
  SOUL_INTERVIEW: ["SOUL_REVIEW"],
  SOUL_REVIEW: ["SOUL_INTERVIEW", "USER_INTERVIEW"], // can restart interview or proceed to user interview
  USER_INTERVIEW: ["USER_REVIEW"],
  USER_REVIEW: ["USER_INTERVIEW", "DEPLOY"], // can restart interview or proceed to deploy
  DEPLOY: ["HANDSHAKE", "FAILED"],
  HANDSHAKE: ["COMPLETE"],
  COMPLETE: [],
  PAUSED: [], // dynamically set from previousState
  FAILED: [], // can retry from specific states
  ABANDONED: [],
};

/** The happy-path order of states. */
const HAPPY_PATH: SessionState[] = [
  "WELCOME",
  "AWS_ACCOUNT_CHECK",
  "AWS_LAUNCH",
  "INSTANCE_VERIFY",
  "CRED_GITHUB",
  "CRED_ANTHROPIC",
  "CRED_GEMINI",
  "CRED_OPENAI",
  "CRED_TELEGRAM",
  "SOUL_INTERVIEW",
  "SOUL_REVIEW",
  "USER_INTERVIEW",
  "USER_REVIEW",
  "DEPLOY",
  "HANDSHAKE",
  "COMPLETE",
];

/** Check if a transition from → to is valid. */
export function canTransition(from: SessionState, to: SessionState): boolean {
  // Any state can go to PAUSED, FAILED, or ABANDONED
  if (to === "PAUSED" || to === "FAILED" || to === "ABANDONED") return true;
  // PAUSED is handled in transition() which checks previousState
  return (TRANSITIONS[from] || []).includes(to);
}

/** Get the default next state in the happy path. */
export function getNextState(current: SessionState): SessionState | null {
  const idx = HAPPY_PATH.indexOf(current);
  if (idx === -1 || idx >= HAPPY_PATH.length - 1) return null;
  return HAPPY_PATH[idx + 1];
}

/** Transition a session to a new state. Validates the transition and persists. */
export function transition(session: Session, targetState: SessionState): Session {
  // PAUSED can only resume to its previous state
  if (session.state === "PAUSED") {
    if (targetState !== session.previousState) {
      throw new Error(
        `PAUSED sessions can only resume to previous state (${session.previousState}), not ${targetState}`
      );
    }
  } else if (!canTransition(session.state, targetState)) {
    throw new Error(
      `Invalid transition: ${session.state} → ${targetState}`
    );
  }

  const patch: Partial<Session> = {
    state: targetState,
  };

  // Track previous state for PAUSED resume
  if (targetState === "PAUSED") {
    patch.previousState = session.state;
  }

  return store.update(session.friendTelegramId, patch);
}

/** Get the step number (1-indexed) for display. */
export function getStepNumber(state: SessionState): number {
  const idx = HAPPY_PATH.indexOf(state);
  return idx === -1 ? 0 : idx + 1;
}

/** Total steps in the happy path. */
export const TOTAL_STEPS = HAPPY_PATH.length;
