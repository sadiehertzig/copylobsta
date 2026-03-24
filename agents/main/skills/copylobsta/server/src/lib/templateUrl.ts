import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  CFN_TEMPLATE_URL,
  TEMPLATE_MODE_RAW,
  TEMPLATE_S3_BUCKET,
  TEMPLATE_S3_KEY,
  TEMPLATE_S3_REGION,
  TEMPLATE_URL_TTL_SECONDS,
} from "../config.js";

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;

export type TemplateMode = "presigned" | "static";

export interface ResolvedTemplateUrl {
  url: string;
  mode: TemplateMode;
  issuedAt: string;
  expiresAt: string | null;
}

function getPresignTtlSeconds(): number {
  if (!Number.isFinite(TEMPLATE_URL_TTL_SECONDS)) return 600;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(TEMPLATE_URL_TTL_SECONDS)));
}

function hasPresignSource(): boolean {
  return !!TEMPLATE_S3_BUCKET && !!TEMPLATE_S3_KEY;
}

function hasStaticSource(): boolean {
  return !!CFN_TEMPLATE_URL;
}

function getExplicitTemplateMode(): TemplateMode | null {
  if (!TEMPLATE_MODE_RAW) return null;
  if (TEMPLATE_MODE_RAW === "presigned" || TEMPLATE_MODE_RAW === "static") {
    return TEMPLATE_MODE_RAW;
  }
  throw new Error(
    "Invalid COPYLOBSTA_TEMPLATE_MODE. Use 'presigned' or 'static'.",
  );
}

export function getTemplateMode(): TemplateMode {
  const explicit = getExplicitTemplateMode();
  if (explicit) return explicit;
  if (hasPresignSource()) return "presigned";
  return "static";
}

export function validateTemplateSourceConfig(): void {
  const mode = getTemplateMode();
  if (mode === "presigned") {
    if (!hasPresignSource()) {
      throw new Error(
        "Template source misconfigured for presigned mode: set both COPYLOBSTA_TEMPLATE_S3_BUCKET and COPYLOBSTA_TEMPLATE_S3_KEY.",
      );
    }
    return;
  }

  if (!hasStaticSource()) {
    throw new Error(
      "Template source misconfigured for static mode: set CFN_TEMPLATE_URL to a CloudFormation-readable S3 HTTPS URL.",
    );
  }
}

/** Resolve CloudFormation template URL using the configured template mode. */
export async function resolveTemplateUrl(): Promise<ResolvedTemplateUrl> {
  validateTemplateSourceConfig();

  const issuedAt = new Date().toISOString();
  const mode = getTemplateMode();
  if (mode === "presigned") {
    const ttlSeconds = getPresignTtlSeconds();
    const s3 = new S3Client({ region: TEMPLATE_S3_REGION });
    const command = new GetObjectCommand({
      Bucket: TEMPLATE_S3_BUCKET,
      Key: TEMPLATE_S3_KEY,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: ttlSeconds });
    return {
      url,
      mode,
      issuedAt,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  return {
    url: CFN_TEMPLATE_URL,
    mode,
    issuedAt,
    expiresAt: null,
  };
}
