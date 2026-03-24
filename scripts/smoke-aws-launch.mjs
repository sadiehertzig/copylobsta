import process from "node:process";
import { resolveTemplateUrl } from "../agents/main/skills/copylobsta/server/dist/lib/templateUrl.js";
import { buildQuickCreateUrl } from "../agents/main/skills/copylobsta/server/dist/lib/cfnUrl.js";

const expectedMode = process.env.COPYLOBSTA_EXPECT_TEMPLATE_MODE || null;
const callbackUrl = process.env.COPYLOBSTA_SMOKE_CALLBACK_URL || "https://example.com/api/aws/instance-callback";

const resolved = await resolveTemplateUrl();
if (expectedMode && resolved.mode !== expectedMode) {
  throw new Error(`Expected template mode ${expectedMode}, got ${resolved.mode}`);
}

const quickCreateUrl = buildQuickCreateUrl({
  templateUrl: resolved.url,
  callbackUrl,
  sessionToken: "smoke-session-token",
  callbackSecret: "smoke-callback-secret",
});

const parsed = new URL(quickCreateUrl);
const hashQuery = parsed.hash.split("?")[1] || "";
const hashParams = new URLSearchParams(hashQuery);
const templateUrl = hashParams.get("templateURL");
if (!templateUrl) {
  throw new Error("Quick-create URL is missing templateURL.");
}

const signed = templateUrl.includes("X-Amz-Algorithm=");
if (resolved.mode === "presigned" && !signed) {
  throw new Error("Expected a presigned template URL but did not find signing parameters.");
}
if (resolved.mode === "static" && signed) {
  throw new Error("Expected a static template URL but found signing parameters.");
}

console.log(JSON.stringify({
  mode: resolved.mode,
  issuedAt: resolved.issuedAt,
  expiresAt: resolved.expiresAt,
  templateUrl,
}, null, 2));
