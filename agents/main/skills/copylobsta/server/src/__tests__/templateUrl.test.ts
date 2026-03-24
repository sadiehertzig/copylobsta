import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("resolveTemplateUrl", () => {
  it("defaults to presigned mode when S3 signing config is present", async () => {
    const getSignedUrl = vi.fn(async () => "https://signed.example/template.yaml?X-Amz-Algorithm=AWS4-HMAC-SHA256");
    vi.doMock("../config.js", () => ({
      CFN_TEMPLATE_URL: "https://s3.us-east-1.amazonaws.com/public-bucket/openclaw-runtime.yaml",
      TEMPLATE_MODE_RAW: "",
      TEMPLATE_S3_BUCKET: "private-bucket",
      TEMPLATE_S3_KEY: "openclaw-runtime.yaml",
      TEMPLATE_S3_REGION: "us-east-1",
      TEMPLATE_URL_TTL_SECONDS: 600,
    }));
    vi.doMock("@aws-sdk/client-s3", () => ({
      GetObjectCommand: class GetObjectCommand {
        input: unknown;
        constructor(input: unknown) {
          this.input = input;
        }
      },
      S3Client: class S3Client {
        config: unknown;
        constructor(config: unknown) {
          this.config = config;
        }
      },
    }));
    vi.doMock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl }));

    const { resolveTemplateUrl } = await import("../lib/templateUrl.js");
    const resolved = await resolveTemplateUrl();

    expect(resolved.mode).toBe("presigned");
    expect(resolved.url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(resolved.expiresAt).not.toBeNull();
    expect(getSignedUrl).toHaveBeenCalledOnce();
  });

  it("uses static mode when explicitly configured", async () => {
    vi.doMock("../config.js", () => ({
      CFN_TEMPLATE_URL: "https://s3.us-east-1.amazonaws.com/public-bucket/openclaw-runtime.yaml",
      TEMPLATE_MODE_RAW: "static",
      TEMPLATE_S3_BUCKET: "private-bucket",
      TEMPLATE_S3_KEY: "openclaw-runtime.yaml",
      TEMPLATE_S3_REGION: "us-east-1",
      TEMPLATE_URL_TTL_SECONDS: 600,
    }));
    vi.doMock("@aws-sdk/client-s3", () => ({
      GetObjectCommand: class {},
      S3Client: class {},
    }));
    vi.doMock("@aws-sdk/s3-request-presigner", () => ({
      getSignedUrl: vi.fn(async () => "https://signed.example/template.yaml"),
    }));

    const { resolveTemplateUrl } = await import("../lib/templateUrl.js");
    const resolved = await resolveTemplateUrl();

    expect(resolved.mode).toBe("static");
    expect(resolved.url).toBe("https://s3.us-east-1.amazonaws.com/public-bucket/openclaw-runtime.yaml");
    expect(resolved.expiresAt).toBeNull();
  });
});
