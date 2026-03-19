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
  budgetEmail?: string;
  instanceType?: string;
}

/**
 * Generate a CloudFormation quick-create URL.
 * Opens the AWS Console with the stack pre-configured and ready to launch.
 */
export function buildQuickCreateUrl(params: QuickCreateParams): string {
  const region = params.region || AWS_REGION;
  const templateUrl = params.templateUrl || CFN_TEMPLATE_URL;

  if (!templateUrl) {
    throw new Error("CFN_TEMPLATE_URL is not configured. Set it in your environment.");
  }

  const stackSuffix = randomBytes(4).toString("hex");
  const stackName = `openclaw-${stackSuffix}`;

  const qs = new URLSearchParams();
  qs.set("templateURL", templateUrl);
  qs.set("stackName", stackName);
  qs.set("param_CallbackUrl", params.callbackUrl);
  qs.set("param_SessionToken", params.sessionToken);
  qs.set("param_RepoRef", RELEASE_TAG);

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
