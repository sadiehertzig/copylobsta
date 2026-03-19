import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, openSync, closeSync, unlinkSync, constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { Session } from "../types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SESSIONS_DIR = resolve(__dirname, "..", "..", "..", "data", "sessions");

// Ensure sessions directory exists
if (!existsSync(SESSIONS_DIR)) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(userId: string): string {
  return resolve(SESSIONS_DIR, `${userId}.json`);
}

function lockPath(userId: string): string {
  return resolve(SESSIONS_DIR, `${userId}.lock`);
}

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;

/** Acquire a file lock for a user session. Spins until acquired or timeout. */
function acquireLock(userId: string): void {
  const lock = lockPath(userId);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      closeSync(fd);
      return;
    } catch {
      if (Date.now() > deadline) {
        // Stale lock — force remove and retry once
        try { unlinkSync(lock); } catch { /* ignore */ }
        try {
          const fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
          closeSync(fd);
          return;
        } catch {
          throw new Error(`Could not acquire session lock for user ${userId}`);
        }
      }
      // Busy-wait briefly
      const start = Date.now();
      while (Date.now() - start < LOCK_RETRY_MS) { /* spin */ }
    }
  }
}

/** Release the file lock for a user session. */
function releaseLock(userId: string): void {
  try { unlinkSync(lockPath(userId)); } catch { /* ignore */ }
}

/** Execute a function while holding the session lock. */
function withLock<T>(userId: string, fn: () => T): T {
  acquireLock(userId);
  try {
    return fn();
  } finally {
    releaseLock(userId);
  }
}

function normalizeSession(session: Session): Session {
  return {
    ...session,
    aws: {
      ...session.aws,
      setupBaseUrl: session.aws.setupBaseUrl || null,
    },
    sharingEnabled: !!session.sharingEnabled,
    sharingSession: session.sharingSession || null,
  };
}

function createDefaultSession(userId: number, username: string | null): Session {
  const now = new Date().toISOString();
  return {
    sessionId: `copy_${Date.now()}_${randomBytes(4).toString("hex")}`,
    referrerTelegramId: null,
    friendTelegramId: userId,
    friendUsername: username,
    groupChatId: null,
    state: "WELCOME",
    previousState: null,
    createdAt: now,
    updatedAt: now,
    aws: {
      hasAccount: null,
      stackId: null,
      instanceId: null,
      instanceIp: null,
      setupBaseUrl: null,
      ssmVerified: false,
      region: "us-east-1",
    },
    sharingEnabled: false,
    sharingSession: null,
    credentials: {
      githubUsername: null,
      anthropic: "unset",
      gemini: "unset",
      openai: "unset",
      telegramToken: "unset",
      botUsername: null,
    },
    setupToken: null,
    user: {
      answers: {},
      draftMarkdown: null,
      approved: false,
    },
    soul: {
      answers: {},
      draftMarkdown: null,
      approved: false,
    },
    deploy: {
      startedAt: null,
      completedAt: null,
      stepsCompleted: [],
      error: null,
    },
  };
}

/** Get an existing session or create a new one for this user. */
export function getOrCreate(userId: number, username: string | null = null): Session {
  return withLock(String(userId), () => {
    const path = sessionPath(String(userId));
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      const normalized = normalizeSession(JSON.parse(raw) as Session);
      writeFileSync(path, JSON.stringify(normalized, null, 2));
      return normalized;
    }
    const session = createDefaultSession(userId, username);
    writeFileSync(path, JSON.stringify(session, null, 2));
    return session;
  });
}

/** Get a session by user ID. Returns null if not found. */
export function get(userId: number): Session | null {
  const path = sessionPath(String(userId));
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  return normalizeSession(JSON.parse(raw) as Session);
}

/** Find a session by its setup token (for instance callback auth). */
export function findBySetupToken(token: string): Session | null {
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
  for (const file of files) {
    const raw = readFileSync(resolve(SESSIONS_DIR, file), "utf-8");
    const session = normalizeSession(JSON.parse(raw) as Session);
    if (session.setupToken === token) {
      return session;
    }
  }
  return null;
}

/** Find all active sessions (not COMPLETE, ABANDONED, or FAILED). */
export function findActiveSessions(): Session[] {
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
  const active: Session[] = [];
  for (const file of files) {
    const raw = readFileSync(resolve(SESSIONS_DIR, file), "utf-8");
    const session = normalizeSession(JSON.parse(raw) as Session);
    if (!["COMPLETE", "ABANDONED", "FAILED"].includes(session.state)) {
      active.push(session);
    }
  }
  return active;
}

/** Find an active session for a specific friend (by Telegram ID). */
export function findActiveByFriendId(friendId: number): Session | null {
  const path = sessionPath(String(friendId));
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const session = normalizeSession(JSON.parse(raw) as Session);
  if (["COMPLETE", "ABANDONED", "FAILED"].includes(session.state)) return null;
  return session;
}

const ABANDONED_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** Check if a session should be marked as abandoned. */
export function isStale(session: Session): boolean {
  const updated = new Date(session.updatedAt).getTime();
  return Date.now() - updated > ABANDONED_AFTER_MS;
}

/** Update a session with a partial patch. Returns the updated session. */
export function update(userId: number, patch: Partial<Session>): Session {
  return withLock(String(userId), () => {
    const session = get(userId);
    if (!session) throw new Error(`No session for user ${userId}`);

    const updated: Session = {
      ...session,
      ...patch,
      updatedAt: new Date().toISOString(),
      // Deep-merge nested objects
      aws: { ...session.aws, ...(patch.aws || {}) },
      credentials: { ...session.credentials, ...(patch.credentials || {}) },
      soul: { ...session.soul, ...(patch.soul || {}) },
      user: { ...session.user, ...(patch.user || {}) },
      deploy: { ...session.deploy, ...(patch.deploy || {}) },
    };

    const normalized = normalizeSession(updated);
    writeFileSync(sessionPath(String(userId)), JSON.stringify(normalized, null, 2));
    return normalized;
  });
}
