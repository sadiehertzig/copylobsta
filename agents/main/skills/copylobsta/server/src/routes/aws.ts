import { Router } from "express";
import { BOT_TOKEN } from "../config.js";
import { requireTelegramUser } from "../lib/telegramAuth.js";
import * as sessionStore from "../lib/sessionStore.js";
import { transition } from "../lib/stateMachine.js";
import { buildQuickCreateUrl, generateSessionToken } from "../lib/cfnUrl.js";

const router = Router();

/**
 * POST /api/aws/check
 * Records whether the friend has an AWS account.
 * Body: { hasAccount: boolean }
 */
router.post("/api/aws/check", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const user = requireTelegramUser(initData, BOT_TOKEN);

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
 * GET /api/aws/quick-create-url
 * Generates a CloudFormation quick-create URL with a unique session token.
 */
router.get("/api/aws/quick-create-url", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const user = requireTelegramUser(initData, BOT_TOKEN);

    const session = sessionStore.get(user.id);
    if (!session) {
      res.status(404).json({ error: "no session found" });
      return;
    }

    const callbackBase = session.sharingSession?.launchUrl;
    if (!callbackBase) {
      res.status(400).json({
        error: "Sharing session is not active. Relaunch /copylobsta to start a new onboarding session.",
      });
      return;
    }

    const token = generateSessionToken();
    sessionStore.update(user.id, { setupToken: token });

    const url = buildQuickCreateUrl({
      sessionToken: token,
      callbackUrl: `${callbackBase}/api/aws/instance-callback`,
    });

    res.json({ url, setupToken: token });
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

    const updated = sessionStore.update(session.friendTelegramId, {
      aws: {
        ...session.aws,
        instanceId,
        instanceIp: instanceIp || null,
        setupBaseUrl,
        ssmVerified: true,
      },
      sharingSession: session.sharingSession
        ? { ...session.sharingSession, setupBaseUrl }
        : session.sharingSession,
    });

    if (updated.state === "AWS_LAUNCH") {
      transition(updated, "INSTANCE_VERIFY");
    }

    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Instance callback error:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/aws/poll-callback
 * Mini App polls this to check if the instance callback has been received.
 */
router.get("/api/aws/poll-callback", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] as string || "";
    const user = requireTelegramUser(initData, BOT_TOKEN);

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
      setupToken: session.setupToken,
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
    const user = requireTelegramUser(initData, BOT_TOKEN);

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

    const setupUrl = `${session.aws.setupBaseUrl}/setup/validate-key`;
    const upstream = await fetch(setupUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": session.setupToken,
      },
      body: JSON.stringify({ provider, key, sessionToken: session.setupToken }),
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
  try {
    requireTelegramUser(initData, BOT_TOKEN);
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
    friendly = `AWS returned an error: ${msg || code || "unknown error"}. Check the CloudFormation Events tab for details.`;
  }

  res.json({ friendlyError: friendly, rawError: msg || code });
});

export default router;
