import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateKey } from "../keyValidator.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  mockFetch.mockReset();
});

describe("validateKey", () => {
  describe("anthropic", () => {
    it("returns valid for 200 response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const result = await validateKey("anthropic", "sk-ant-test-key-12345678901234567890");
      expect(result.valid).toBe(true);
    });

    it("returns error for 401", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { message: "Invalid API Key" } }),
      });
      const result = await validateKey("anthropic", "bad-key");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid API key");
    });

    it("returns error for 403 (no billing)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: { message: "Forbidden" } }),
      });
      const result = await validateKey("anthropic", "sk-ant-no-billing");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("billing");
    });

    it("handles network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const result = await validateKey("anthropic", "sk-ant-test");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("internet connection");
    });
  });

  describe("gemini", () => {
    it("returns valid for 200 response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const result = await validateKey("gemini", "AIzaSyTestKey12345");
      expect(result.valid).toBe(true);
    });

    it("returns error for 403", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
      const result = await validateKey("gemini", "bad-key");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid API key");
    });

    it("handles network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("timeout"));
      const result = await validateKey("gemini", "test-key");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("internet connection");
    });
  });

  describe("openai", () => {
    it("returns valid for 200 response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const result = await validateKey("openai", "sk-proj-test");
      expect(result.valid).toBe(true);
    });

    it("returns error for 401", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      const result = await validateKey("openai", "bad-key");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid API key");
    });

    it("returns rate limit info for 429", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });
      const result = await validateKey("openai", "sk-proj-ratelimited");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("rate limit");
    });
  });

  describe("telegram", () => {
    it("returns valid with metadata for valid token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            result: { username: "MyBot", first_name: "My Bot" },
          }),
      });
      const result = await validateKey("telegram", "123456789:ABCdefToken");
      expect(result.valid).toBe(true);
      expect(result.metadata?.botUsername).toBe("MyBot");
      expect(result.metadata?.botName).toBe("My Bot");
    });

    it("returns error for invalid token", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });
      const result = await validateKey("telegram", "bad-token");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid bot token");
    });
  });

  describe("unknown provider", () => {
    it("returns error for unknown provider", async () => {
      const result = await validateKey("unknown", "some-key");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unknown provider");
    });
  });
});
