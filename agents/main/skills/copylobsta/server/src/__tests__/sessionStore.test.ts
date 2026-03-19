import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// We test the session store by importing it — it uses a module-level SESSIONS_DIR.
// To isolate tests, we set up and tear down the data/sessions directory.

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SESSIONS_DIR = resolve(__dirname, "..", "..", "..", "data", "sessions");

function cleanSessions() {
  if (existsSync(SESSIONS_DIR)) {
    const files = readdirSync(SESSIONS_DIR);
    for (const f of files) {
      if (f !== ".gitkeep") {
        rmSync(resolve(SESSIONS_DIR, f), { force: true });
      }
    }
  }
}

// Dynamic import to avoid module-level side effects caching
async function importStore() {
  // Use timestamp to bust module cache
  const mod = await import(`../lib/sessionStore.js?t=${Date.now()}`);
  return mod;
}

describe("sessionStore", () => {
  let store: typeof import("../lib/sessionStore.js");

  beforeEach(async () => {
    cleanSessions();
    store = await import("../lib/sessionStore.js");
  });

  afterEach(() => {
    cleanSessions();
  });

  it("creates a new session with getOrCreate", () => {
    const session = store.getOrCreate(111111, "testuser");
    expect(session.friendTelegramId).toBe(111111);
    expect(session.friendUsername).toBe("testuser");
    expect(session.state).toBe("WELCOME");
    expect(session.sessionId).toMatch(/^copy_/);
  });

  it("returns existing session on second getOrCreate", () => {
    const s1 = store.getOrCreate(222222, "user2");
    const s2 = store.getOrCreate(222222, "user2");
    expect(s1.sessionId).toBe(s2.sessionId);
  });

  it("get returns null for nonexistent user", () => {
    const result = store.get(999999);
    expect(result).toBeNull();
  });

  it("get returns session after creation", () => {
    store.getOrCreate(333333, "user3");
    const session = store.get(333333);
    expect(session).not.toBeNull();
    expect(session!.friendTelegramId).toBe(333333);
  });

  it("update merges partial patches", () => {
    store.getOrCreate(444444, "user4");
    const updated = store.update(444444, { state: "AWS_ACCOUNT_CHECK" as const });
    expect(updated.state).toBe("AWS_ACCOUNT_CHECK");
    expect(updated.friendTelegramId).toBe(444444);
  });

  it("deep-merges nested aws object", () => {
    store.getOrCreate(555555, "user5");
    const updated = store.update(555555, {
      aws: { hasAccount: true } as any,
    });
    expect(updated.aws.hasAccount).toBe(true);
    expect(updated.aws.region).toBe("us-east-1"); // preserved from default
  });

  it("deep-merges nested credentials object", () => {
    store.getOrCreate(666666, "user6");
    const updated = store.update(666666, {
      credentials: { anthropic: "valid" } as any,
    });
    expect(updated.credentials.anthropic).toBe("valid");
    expect(updated.credentials.gemini).toBe("unset"); // preserved
  });

  it("throws on update for nonexistent user", () => {
    expect(() => store.update(888888, { state: "DEPLOY" as const })).toThrow(
      "No session for user 888888"
    );
  });

  it("findBySetupToken finds matching session", () => {
    store.getOrCreate(777777, "user7");
    store.update(777777, { setupToken: "test-token-abc" });
    const found = store.findBySetupToken("test-token-abc");
    expect(found).not.toBeNull();
    expect(found!.friendTelegramId).toBe(777777);
  });

  it("findBySetupToken returns null for no match", () => {
    store.getOrCreate(777777, "user7");
    const found = store.findBySetupToken("nonexistent-token");
    expect(found).toBeNull();
  });

  it("sets updatedAt on update", () => {
    store.getOrCreate(123123, "user_ts");
    const s2 = store.update(123123, { state: "AWS_ACCOUNT_CHECK" as const });
    // updatedAt should be a valid ISO date
    expect(new Date(s2.updatedAt).getTime()).toBeGreaterThan(0);
    expect(s2.state).toBe("AWS_ACCOUNT_CHECK");
  });
});
