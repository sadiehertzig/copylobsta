import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { Router } from "express";
import { ALLOW_UNSIGNED_INSTANCE_CALLBACK, BOT_TOKEN } from "../config.js";
import { requireUser } from "../lib/telegramAuth.js";
import * as sessionStore from "../lib/sessionStore.js";
import { transition } from "../lib/stateMachine.js";
import { buildQuickCreateUrl, generateSessionToken } from "../lib/cfnUrl.js";
import { resolveTemplateUrl } from "../lib/templateUrl.js";
import { ensureOnDemandTunnel, refreshTunnelByUrl } from "../lib/tunnelManager.js";

const router = Router();
const ALLOWED_PROVIDERS = new Set(["anthropic", "gemini", "openai", "telegram"]);
type RawBodyRequest = Request & { rawBody?: string };

function isAllowedSetupHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".trycloudflare.com");
}

function normalizeSetupBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid setupBaseUrl");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("setupBaseUrl must use http or https");
  }
  if (!isAllowedSetupHost(parsed.hostname)) {
    throw new Error("setupBaseUrl host is not allowed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("setupBaseUrl must not contain embedded credentials");
  }
  parsed.hash = "";
  return parsed.origin;
}

function resolveRequestOrigin(req: Request): string | null {
  const host = (req.headers["x-forwarded-host"] as string || req.headers.host || "").split(",")[0]?.trim();
  if (!host) return null;
  const protoHeader = (req.headers["x-forwarded-proto"] as string || "").split(",")[0]?.trim();
  const proto = protoHeader || req.protocol || "http";
  const candidate = `${proto}://${host}`;
  try {
    return normalizeSetupBaseUrl(candidate);
  } catch {
    return null;
  }
}

function safeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function computeCallbackSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * POST /api/aws/check
 * Records whether the friend has an AWS account.
 * Body: { hasAccount: boolean }
 */
router.post("/api/aws/check", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const sessionToken = req.headers["x-session-token"] as string || "";
    const user = requireUser(initData, sessionToken, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    const { hasAccount } = req.body as { hasAccount?: boolean };
    if (typeof hasAccount !== "boolean") {
      res.status(400).json({ error: "hasAccount must be a boolean" });
      return;
    }

    sessionStore.update(user.id, { aws: { ...session.aws, hasAccount } });

    const target = hasAccount ? "AWS_LAUNCH" : "AWS_SIGNUP_GUIDE";
    const updated = transition(session, target);

    res.json({ session: { state: updated.state } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/aws/quick-create-url
 * Generates a one-shot CloudFormation quick-create URL with a unique session token.
 */
router.post("/api/aws/quick-create-url", async (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const sessionToken = req.headers["x-session-token"] as string || "";
    const user = requireUser(initData, sessionToken, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    const sharing = session.sharingSession;
    if (!sharing) {
      res.status(400).json({
        error: "Sharing session is not active. Relaunch /copylobsta to start a new onboarding session.",
      });
      return;
    }

    const requestOrigin = resolveRequestOrigin(req);
    const launchOrigin = (() => {
      try {
        return normalizeSetupBaseUrl(sharing.launchUrl);
      } catch {
        return null;
      }
    })();

    let callbackBase = launchOrigin || requestOrigin || "";
    let refreshed = callbackBase ? refreshTunnelByUrl(callbackBase) : null;

    // If the current session launch URL no longer maps to an active tunnel, try the current request origin.
    if (!refreshed && requestOrigin && requestOrigin !== callbackBase) {
      callbackBase = requestOrigin;
      refreshed = refreshTunnelByUrl(callbackBase);
    }

    // Last resort: recreate/verify tunnel by chat key.
    if (!refreshed) {
      const chatKey = String(session.groupChatId ?? session.friendTelegramId);
      const tunnel = await ensureOnDemandTunnel(chatKey);
      callbackBase = tunnel.url;
      refreshed = tunnel;
    }

    if (
      sharing.launchUrl !== callbackBase ||
      sharing.expiresAt !== refreshed.expiresAt ||
      sharing.tunnelPid !== refreshed.pid ||
      sharing.status !== "active"
    ) {
      sessionStore.update(user.id, {
        sharingSession: {
          ...sharing,
          launchUrl: callbackBase,
          expiresAt: refreshed.expiresAt,
          tunnelPid: refreshed.pid,
          status: "active",
        },
      });
    }

    const token = generateSessionToken();
    const callbackSecret = generateSessionToken();
    sessionStore.update(user.id, { setupToken: token, callbackSecret });
    const template = await resolveTemplateUrl();

    const url = buildQuickCreateUrl({
      templateUrl: template.url,
      sessionToken: token,
      callbackSecret,
      callbackUrl: `${callbackBase}/api/aws/instance-callback`,
    });

    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.json({
      url,
      mode: template.mode,
      issuedAt: template.issuedAt,
      expiresAt: template.expiresAt,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/aws/instance-callback
 * Called by the friend's instance UserData when bootstrap completes.
 * Body: { sessionToken, instanceId, instanceIp, setupBaseUrl }
 */
router.post("/api/aws/instance-callback", (req, res) => {
  try {
    const signatureHeader = req.headers["x-callback-signature"];
    const providedSignature = Array.isArray(signatureHeader) ? signatureHeader[0] : (signatureHeader || "");
    const { sessionToken, instanceId, instanceIp, setupBaseUrl } = req.body as {
      sessionToken?: string;
      instanceId?: string;
      instanceIp?: string;
      setupBaseUrl?: string;
    };

    if (!sessionToken || !instanceId || !setupBaseUrl) {
      res.status(400).json({ error: "Missing sessionToken, instanceId, or setupBaseUrl" });
      return;
    }
    const session = sessionStore.findBySetupToken(sessionToken);
    if (!session) {
      res.status(401).json({ error: "Invalid session token" });
      return;
    }

    if (providedSignature) {
      if (!session.callbackSecret) {
        res.status(401).json({ error: "Callback signature is not configured for this session" });
        return;
      }
      const rawPayload = (req as RawBodyRequest).rawBody ?? JSON.stringify(req.body || {});
      const expectedSignature = computeCallbackSignature(session.callbackSecret, rawPayload);
      if (!safeEquals(providedSignature, expectedSignature)) {
        res.status(401).json({ error: "Invalid callback signature" });
        return;
      }
    } else if (session.callbackSecret && !ALLOW_UNSIGNED_INSTANCE_CALLBACK) {
      res.status(401).json({ error: "Missing callback signature" });
      return;
    } else if (session.callbackSecret && ALLOW_UNSIGNED_INSTANCE_CALLBACK) {
      console.warn("Accepting unsigned instance callback for compatibility", {
        friendTelegramId: session.friendTelegramId,
      });
    }
    const safeSetupBaseUrl = normalizeSetupBaseUrl(setupBaseUrl);

    const updated = sessionStore.update(session.friendTelegramId, {
      aws: {
        ...session.aws,
        instanceId,
        instanceIp: instanceIp || null,
        setupBaseUrl: safeSetupBaseUrl,
        ssmVerified: true,
      },
      sharingSession: session.sharingSession
        ? { ...session.sharingSession, setupBaseUrl: safeSetupBaseUrl }
        : session.sharingSession,
    });

    if (updated.state === "AWS_LAUNCH") {
      transition(updated, "INSTANCE_VERIFY");
    }

    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Instance callback error:", message);
    res.status(500).json({ error: "Instance callback failed. Please retry launch if this continues." });
  }
});

/**
 * GET /api/aws/poll-callback
 * Mini App polls this to check if the instance callback has been received.
 */
router.get("/api/aws/poll-callback", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const sessionToken = req.headers["x-session-token"] as string || "";
    const user = requireUser(initData, sessionToken, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    const ready = !!session.aws.instanceId && !!session.aws.setupBaseUrl;
    res.json({
      ready,
      instanceIp: session.aws.instanceIp,
      instanceId: session.aws.instanceId,
      setupBaseUrl: session.aws.setupBaseUrl,
      state: session.state,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/aws/proxy-validate
 * Proxies key validation to the friend's Setup API over HTTPS setup tunnel.
 */
router.post("/api/aws/proxy-validate", async (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const sessionToken = req.headers["x-session-token"] as string || "";
    const user = requireUser(initData, sessionToken, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    if (!session.aws.setupBaseUrl || !session.setupToken) {
      res.status(400).json({ error: "Instance setup endpoint is not ready yet" });
      return;
    }

    const { provider, key } = req.body as { provider?: string; key?: string };
    if (!provider || !key) {
      res.status(400).json({ error: "Missing provider or key" });
      return;
    }
    if (!ALLOWED_PROVIDERS.has(provider)) {
      res.status(400).json({ error: "Unsupported provider" });
      return;
    }

    const setupUrl = new URL("/setup/validate-key", session.aws.setupBaseUrl).toString();
    const upstream = await fetch(setupUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": session.setupToken,
      },
      body: JSON.stringify({ provider, key }),
    });

    const data = await upstream.json();
    res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Proxy validate error:", message);
    res.status(502).json({
      error: "Could not reach your temporary setup endpoint. Relaunch /copylobsta if this session expired.",
    });
  }
});

/**
 * POST /api/aws/cfn-error
 * Translates a CloudFormation error into plain English.
 */
router.post("/api/aws/cfn-error", (req, res) => {
  const initData = req.headers["x-telegram-init-data"] as string || "";
  const sessionToken = req.headers["x-session-token"] as string || "";
  try {
    requireUser(initData, sessionToken, BOT_TOKEN);
  } catch {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const { errorCode, errorMessage } = req.body as { errorCode?: string; errorMessage?: string };
  const code = errorCode || "";
  const msg = errorMessage || "";

  let friendly: string;
  if (code.includes("LimitExceeded") || msg.includes("limit")) {
    friendly = "Your AWS account has hit a resource limit. This usually means you need to request a limit increase for EC2 instances. Go to AWS Console -> Service Quotas -> EC2.";
  } else if (code.includes("InsufficientCapacity") || msg.includes("capacity")) {
    friendly = "AWS doesn't have enough capacity in this region right now. Try again in a few minutes, or try a different region.";
  } else if (code.includes("AccessDenied") || msg.includes("not authorized")) {
    friendly = "Your AWS account doesn't have permission to create these resources. Make sure you're logged in as a user with admin access (not a restricted IAM user).";
  } else if (msg.includes("ROLLBACK") || code.includes("ROLLBACK")) {
    friendly = "The stack creation failed and rolled back. Check the Events tab in CloudFormation for the specific error. Common causes: missing permissions, region doesn't support the instance type, or a resource limit.";
  } else if (msg.includes("already exists")) {
    friendly = "A stack with this name already exists. Either delete the old stack first (CloudFormation -> select stack -> Delete), or use a different name.";
  } else {
    friendly = "AWS returned an error. Check the CloudFormation Events tab for details, then try again.";
  }

  res.json({ friendlyError: friendly });
});

export default router;
