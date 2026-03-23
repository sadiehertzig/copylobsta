import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  CFN_TEMPLATE_URL,
  TEMPLATE_S3_BUCKET,
  TEMPLATE_S3_KEY,
  TEMPLATE_S3_REGION,
  TEMPLATE_URL_TTL_SECONDS,
} from "../config.js";

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;

function getPresignTtlSeconds(): number {
  if (!Number.isFinite(TEMPLATE_URL_TTL_SECONDS)) return 600;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(TEMPLATE_URL_TTL_SECONDS)));
}

/** Resolve CloudFormation template URL.
 *  Priority:
 *  1) S3 pre-signed URL when COPYLOBSTA_TEMPLATE_S3_BUCKET + COPYLOBSTA_TEMPLATE_S3_KEY are set
 *  2) Static CFN_TEMPLATE_URL fallback
 */
export async function resolveTemplateUrl(): Promise<string> {
  const hasBucket = !!TEMPLATE_S3_BUCKET;
  const hasKey = !!TEMPLATE_S3_KEY;

  if (hasBucket || hasKey) {
    if (!hasBucket || !hasKey) {
      throw new Error(
        "Template source misconfigured: set both COPYLOBSTA_TEMPLATE_S3_BUCKET and COPYLOBSTA_TEMPLATE_S3_KEY, or use CFN_TEMPLATE_URL fallback.",
      );
    }
    const s3 = new S3Client({ region: TEMPLATE_S3_REGION });
    const command = new GetObjectCommand({
      Bucket: TEMPLATE_S3_BUCKET,
      Key: TEMPLATE_S3_KEY,
    });
    return getSignedUrl(s3, command, { expiresIn: getPresignTtlSeconds() });
  }

  if (!CFN_TEMPLATE_URL) {
    throw new Error(
      "Template source is not configured. Set COPYLOBSTA_TEMPLATE_S3_BUCKET + COPYLOBSTA_TEMPLATE_S3_KEY (recommended), or CFN_TEMPLATE_URL.",
    );
  }
  return CFN_TEMPLATE_URL;
}
