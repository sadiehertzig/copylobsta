import { describe, it, expect } from "vitest";
import { scanForSecrets, containsSecrets, redactSecrets } from "../lib/security.js";

describe("scanForSecrets", () => {
  it("detects Anthropic API keys", () => {
    const matches = scanForSecrets("my key is sk-ant-api03-abcdefghijklmnopqrstu");
    expect(matches).toContain("Anthropic API key");
  });

  it("detects OpenAI project keys", () => {
    const matches = scanForSecrets("key: sk-proj-abcdefghijklmnopqrstuv");
    expect(matches).toContain("OpenAI API key");
  });

  it("detects OpenAI legacy keys", () => {
    const matches = scanForSecrets("sk-abcdefghijklmnopqrstuv");
    expect(matches).toContain("OpenAI legacy key");
  });

  it("detects Google API keys", () => {
    const matches = scanForSecrets("AIzaSyCabcdefghijklmnopqrstuvwxyz12345");
    expect(matches).toContain("Google API key");
  });

  it("detects AWS access keys", () => {
    const matches = scanForSecrets("AKIAIOSFODNN7EXAMPLE");
    expect(matches).toContain("AWS access key");
  });

  it("detects Telegram bot tokens", () => {
    const matches = scanForSecrets("123456789:ABCdefGHIjklMNOpqrsTUVwxyz_12345678");
    expect(matches).toContain("Telegram bot token");
  });

  it("returns empty array for clean text", () => {
    const matches = scanForSecrets("This is a normal message with no secrets.");
    expect(matches).toEqual([]);
  });

  it("detects multiple secrets in one string", () => {
    const text = "anthropic: sk-ant-api03-abcdefghijklmnopqrstu, aws: AKIAIOSFODNN7EXAMPLE";
    const matches = scanForSecrets(text);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches).toContain("Anthropic API key");
    expect(matches).toContain("AWS access key");
  });
});

describe("containsSecrets", () => {
  it("returns true when secrets present", () => {
    expect(containsSecrets("sk-ant-api03-abcdefghijklmnopqrstu")).toBe(true);
  });

  it("returns false for clean text", () => {
    expect(containsSecrets("just a normal message")).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("replaces Anthropic key with [REDACTED]", () => {
    const result = redactSecrets("key: sk-ant-api03-abcdefghijklmnopqrstu end");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-ant-api03");
  });

  it("replaces Telegram token with [REDACTED]", () => {
    const result = redactSecrets("token: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz_12345678");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("123456789:");
  });

  it("preserves clean text", () => {
    const text = "This has no secrets at all.";
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts multiple secrets", () => {
    const text = "a: sk-ant-api03-abcdefghijklmnopqrstu b: AKIAIOSFODNN7EXAMPLE";
    const result = redactSecrets(text);
    expect(result).toBe("a: [REDACTED] b: [REDACTED]");
  });
});
