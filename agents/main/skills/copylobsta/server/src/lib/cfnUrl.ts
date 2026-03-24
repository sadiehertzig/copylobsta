/**
 * Builds a CloudFormation quick-create URL with pre-filled parameters.
 * The friend clicks this URL to launch the stack in their own AWS Console.
 */

import { randomBytes } from "node:crypto";
import { CFN_TEMPLATE_URL, AWS_REGION, RELEASE_TAG } from "../config.js";

export interface QuickCreateParams {
  region?: string;
  templateUrl?: string;
  callbackUrl: string;
  sessionToken: string;
  callbackSecret: string;
  budgetEmail?: string;
  instanceType?: string;
}

function isSupportedCloudFormationTemplateUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith(".amazonaws.com") && host !== "amazonaws.com") return false;
    return host === "s3.amazonaws.com" || host.startsWith("s3.") || host.includes(".s3.") || host.includes(".s3-");
  } catch {
    return false;
  }
}

/**
 * Generate a CloudFormation quick-create URL.
 * Opens the AWS Console with the stack pre-configured and ready to launch.
 */
export function buildQuickCreateUrl(params: QuickCreateParams): string {
  const region = params.region || AWS_REGION;
  const templateUrl = params.templateUrl || CFN_TEMPLATE_URL;

  if (!templateUrl) {
    throw new Error("Template URL is not configured.");
  }
  if (!isSupportedCloudFormationTemplateUrl(templateUrl)) {
    throw new Error(
      "Template URL must be an HTTPS Amazon S3 URL (for example: https://<bucket>.s3.<region>.amazonaws.com/openclaw-runtime.yaml).",
    );
  }

  const stackSuffix = randomBytes(4).toString("hex");
  const stackName = `openclaw-${stackSuffix}`;

  const qs = new URLSearchParams();
  qs.set("templateURL", templateUrl);
  qs.set("stackName", stackName);
  qs.set("param_CallbackUrl", params.callbackUrl);
  qs.set("param_SessionToken", params.sessionToken);
  qs.set("param_CallbackSecret", params.callbackSecret);
  qs.set("param_RepoRef", RELEASE_TAG);
  qs.set("param_SetupApiRepoRef", RELEASE_TAG);

  if (params.budgetEmail) {
    qs.set("param_BudgetAlertEmail", params.budgetEmail);
  }
  if (params.instanceType) {
    qs.set("param_InstanceType", params.instanceType);
  }

  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${qs.toString()}`;
}

/** Generate a random session token for setup API auth. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}
