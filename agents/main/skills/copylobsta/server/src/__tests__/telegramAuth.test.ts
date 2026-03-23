import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { requireTelegramUser } from "../lib/telegramAuth.js";

const BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrsTUVwxyz-1234567";

function buildInitData(
  user: Record<string, unknown>,
  botToken: string,
  authDate?: number
): string {
  const now = authDate ?? Math.floor(Date.now() / 1000);
  const params = new URLSearchParams();
  params.set("user", JSON.stringify(user));
  params.set("auth_date", String(now));
  params.set("query_id", "test_query_123");

  // Build data-check-string (sorted, no hash)
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  // Compute HMAC
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const hash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  params.set("hash", hash);
  return params.toString();
}

describe("requireTelegramUser", () => {
  it("validates and returns user from valid initData", () => {
    const user = { id: 12345, first_name: "Test", username: "testuser" };
    const initData = buildInitData(user, BOT_TOKEN);
    const result = requireTelegramUser(initData, BOT_TOKEN);
    expect(result.id).toBe(12345);
    expect(result.first_name).toBe("Test");
    expect(result.username).toBe("testuser");
  });

  it("throws on empty initData", () => {
    expect(() => requireTelegramUser("", BOT_TOKEN)).toThrow("missing initData");
  });

  it("throws on empty bot token", () => {
    const initData = buildInitData({ id: 1, first_name: "X" }, BOT_TOKEN);
    expect(() => requireTelegramUser(initData, "")).toThrow("missing bot token");
  });

  it("throws on missing hash", () => {
    const params = new URLSearchParams();
    params.set("user", JSON.stringify({ id: 1, first_name: "X" }));
    params.set("auth_date", String(Math.floor(Date.now() / 1000)));
    expect(() => requireTelegramUser(params.toString(), BOT_TOKEN)).toThrow(
      "missing hash"
    );
  });

  it("throws on invalid signature", () => {
    const initData = buildInitData({ id: 1, first_name: "X" }, BOT_TOKEN);
    const wrongToken = "999999999:WRONGtokenWRONGtokenWRONGtokenWRON";
    expect(() => requireTelegramUser(initData, wrongToken)).toThrow(
      "invalid initData signature"
    );
  });

  it("throws on expired initData", () => {
    const oldDate = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
    const initData = buildInitData({ id: 1, first_name: "X" }, BOT_TOKEN, oldDate);
    expect(() => requireTelegramUser(initData, BOT_TOKEN)).toThrow("expired");
  });

  it("accepts initData within custom maxAge", () => {
    const recentDate = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
    const initData = buildInitData(
      { id: 99, first_name: "Recent" },
      BOT_TOKEN,
      recentDate
    );
    const result = requireTelegramUser(initData, BOT_TOKEN, {
      maxAgeSeconds: 120,
    });
    expect(result.id).toBe(99);
  });
});
