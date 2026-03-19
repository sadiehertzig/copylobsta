import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-secrets-manager", async () => {
  return {
    SecretsManagerClient: class {
      send(...args: any[]) { return sendMock(...args); }
    },
    CreateSecretCommand: class { input: any; _type = "Create"; constructor(input: any) { this.input = input; } },
    PutSecretValueCommand: class { input: any; _type = "Put"; constructor(input: any) { this.input = input; } },
    GetSecretValueCommand: class { input: any; _type = "Get"; constructor(input: any) { this.input = input; } },
  };
});

import { writeSecret } from "../secretsWriter.js";

beforeEach(() => {
  sendMock.mockReset();
});

describe("writeSecret", () => {
  it("updates existing secret", async () => {
    sendMock
      .mockResolvedValueOnce({ SecretString: "old-value" }) // Get
      .mockResolvedValueOnce({}); // Put

    await writeSecret("anthropic", "sk-ant-new-key");

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0]._type).toBe("Get");
    expect(sendMock.mock.calls[1][0]._type).toBe("Put");
  });

  it("creates new secret when not found", async () => {
    const notFoundError = new Error("not found");
    (notFoundError as any).name = "ResourceNotFoundException";
    sendMock
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce({});

    await writeSecret("openai", "sk-proj-new-key");

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0]._type).toBe("Create");
  });

  it("throws on unknown provider", async () => {
    await expect(writeSecret("unknown", "key")).rejects.toThrow("Unknown provider");
  });

  it("re-throws non-NotFound AWS errors", async () => {
    const accessError = new Error("access denied");
    (accessError as any).name = "AccessDeniedException";
    sendMock.mockRejectedValueOnce(accessError);

    await expect(writeSecret("gemini", "key")).rejects.toThrow("access denied");
  });

  it("uses correct secret names for each provider", async () => {
    sendMock
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await writeSecret("telegram", "123:token");

    const getCall = sendMock.mock.calls[0][0];
    expect(getCall.input.SecretId).toBe("openclaw/telegram-bot-token");
  });
});
