import { describe, it, expect } from "vitest";
import { canTransition, getNextState, getStepNumber, TOTAL_STEPS } from "../lib/stateMachine.js";

describe("canTransition", () => {
  it("allows WELCOME → AWS_ACCOUNT_CHECK", () => {
    expect(canTransition("WELCOME", "AWS_ACCOUNT_CHECK")).toBe(true);
  });

  it("allows AWS_ACCOUNT_CHECK → AWS_SIGNUP_GUIDE", () => {
    expect(canTransition("AWS_ACCOUNT_CHECK", "AWS_SIGNUP_GUIDE")).toBe(true);
  });

  it("allows AWS_ACCOUNT_CHECK → AWS_LAUNCH (has account)", () => {
    expect(canTransition("AWS_ACCOUNT_CHECK", "AWS_LAUNCH")).toBe(true);
  });

  it("allows SOUL_REVIEW → SOUL_INTERVIEW (redo)", () => {
    expect(canTransition("SOUL_REVIEW", "SOUL_INTERVIEW")).toBe(true);
  });

  it("allows SOUL_REVIEW → USER_INTERVIEW (proceed)", () => {
    expect(canTransition("SOUL_REVIEW", "USER_INTERVIEW")).toBe(true);
  });

  it("allows USER_REVIEW → USER_INTERVIEW (redo)", () => {
    expect(canTransition("USER_REVIEW", "USER_INTERVIEW")).toBe(true);
  });

  it("allows USER_REVIEW → DEPLOY (proceed)", () => {
    expect(canTransition("USER_REVIEW", "DEPLOY")).toBe(true);
  });

  it("allows DEPLOY → HANDSHAKE (success)", () => {
    expect(canTransition("DEPLOY", "HANDSHAKE")).toBe(true);
  });

  it("allows DEPLOY → FAILED", () => {
    expect(canTransition("DEPLOY", "FAILED")).toBe(true);
  });

  it("allows HANDSHAKE → COMPLETE", () => {
    expect(canTransition("HANDSHAKE", "COMPLETE")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(canTransition("WELCOME", "DEPLOY")).toBe(false);
    expect(canTransition("CRED_ANTHROPIC", "SOUL_INTERVIEW")).toBe(false);
    expect(canTransition("COMPLETE", "WELCOME")).toBe(false);
  });

  it("allows any state → PAUSED", () => {
    expect(canTransition("WELCOME", "PAUSED")).toBe(true);
    expect(canTransition("SOUL_INTERVIEW", "PAUSED")).toBe(true);
    expect(canTransition("DEPLOY", "PAUSED")).toBe(true);
  });

  it("allows any state → FAILED", () => {
    expect(canTransition("INSTANCE_VERIFY", "FAILED")).toBe(true);
    expect(canTransition("CRED_ANTHROPIC", "FAILED")).toBe(true);
  });

  it("allows any state → ABANDONED", () => {
    expect(canTransition("AWS_LAUNCH", "ABANDONED")).toBe(true);
    expect(canTransition("USER_INTERVIEW", "ABANDONED")).toBe(true);
  });

  it("walks the full happy path", () => {
    const happyPath = [
      "WELCOME", "AWS_ACCOUNT_CHECK", "AWS_LAUNCH", "INSTANCE_VERIFY",
      "CRED_GITHUB", "CRED_ANTHROPIC", "CRED_TELEGRAM", "SOUL_INTERVIEW", "SOUL_REVIEW", "USER_INTERVIEW",
      "USER_REVIEW", "DEPLOY", "HANDSHAKE", "COMPLETE",
    ] as const;

    for (let i = 0; i < happyPath.length - 1; i++) {
      expect(
        canTransition(happyPath[i], happyPath[i + 1]),
        `${happyPath[i]} → ${happyPath[i + 1]} should be valid`
      ).toBe(true);
    }
  });
});

describe("getNextState", () => {
  it("returns AWS_ACCOUNT_CHECK after WELCOME", () => {
    expect(getNextState("WELCOME")).toBe("AWS_ACCOUNT_CHECK");
  });

  it("returns null after COMPLETE", () => {
    expect(getNextState("COMPLETE")).toBeNull();
  });

  it("returns null for lateral states", () => {
    expect(getNextState("PAUSED")).toBeNull();
    expect(getNextState("FAILED")).toBeNull();
    expect(getNextState("ABANDONED")).toBeNull();
  });

  it("skips AWS_SIGNUP_GUIDE in happy path (it's an alternative branch)", () => {
    expect(getNextState("AWS_ACCOUNT_CHECK")).toBe("AWS_LAUNCH");
  });
});

describe("getStepNumber", () => {
  it("returns 1 for WELCOME", () => {
    expect(getStepNumber("WELCOME")).toBe(1);
  });

  it("returns correct step for SOUL_INTERVIEW", () => {
    expect(getStepNumber("SOUL_INTERVIEW")).toBe(8);
  });

  it("returns 0 for lateral states", () => {
    expect(getStepNumber("PAUSED")).toBe(0);
    expect(getStepNumber("FAILED")).toBe(0);
    expect(getStepNumber("ABANDONED")).toBe(0);
  });
});

describe("TOTAL_STEPS", () => {
  it("equals 14 (happy path states)", () => {
    expect(TOTAL_STEPS).toBe(14);
  });
});
