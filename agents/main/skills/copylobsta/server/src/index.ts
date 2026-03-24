import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { CFN_TEMPLATE_URL, PORT, SHARING_ENABLED, TEMPLATE_S3_BUCKET, TEMPLATE_S3_KEY } from "./config.js";
import { getRuntimeGitSha } from "./lib/runtimeInfo.js";
import { containsSecrets, redactSecrets } from "./lib/security.js";
import { getTemplateMode, validateTemplateSourceConfig } from "./lib/templateUrl.js";
import healthRouter from "./routes/health.js";
import launchRouter from "./routes/launch.js";
import sessionRouter from "./routes/session.js";
import stepRouter from "./routes/step.js";
import awsRouter from "./routes/aws.js";
import credentialsRouter from "./routes/credentials.js";
import soulRouter from "./routes/soul.js";
import userRouter from "./routes/user.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const app = express();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const LAUNCH_RATE_MAX = 12;

type RateBucket = { resetAt: number; count: number };
const globalRate = new Map<string, RateBucket>();
const launchRate = new Map<string, RateBucket>();

function getClientKey(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function checkRateLimit(
  map: Map<string, RateBucket>,
  key: string,
  now: number,
  max: number,
): { ok: boolean; retryAfterSec: number } {
  const existing = map.get(key);
  if (!existing || now >= existing.resetAt) {
    map.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, retryAfterSec: Math.ceil(RATE_WINDOW_MS / 1000) };
  }
  existing.count += 1;
  if (existing.count > max) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
}

// Basic security headers.
app.use((req, res, next) => {
  const isMiniApp = req.path.startsWith("/miniapp");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (isMiniApp) {
    // Telegram Mini Apps are embedded; do not send X-Frame-Options: DENY here.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org https://t.me; base-uri 'self'; form-action 'self'",
    );
  } else {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  }
  next();
});

if (SHARING_ENABLED) {
  try {
    validateTemplateSourceConfig();
  } catch (err) {
    console.error(
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

// CORS: only allow same-origin requests (or localhost dev origins).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) {
    next();
    return;
  }
  const host = req.headers.host || "";
  const expectedHttp = `http://${host}`;
  const expectedHttps = `https://${host}`;
  const isLocalDev = origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1");
  const isSameOrigin = origin === expectedHttp || origin === expectedHttps;
  if (!isLocalDev && !isSameOrigin) {
    res.status(403).json({ error: "Origin not allowed by CORS" });
    return;
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-telegram-init-data, x-session-token, x-launch-secret");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({
  limit: "32kb",
  verify(req, _res, buf) {
    // Preserve raw payload for callback HMAC verification.
    (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
  },
}));

// Baseline rate limiting.
app.use((req, res, next) => {
  if (req.path === "/api/health") {
    next();
    return;
  }
  const now = Date.now();
  const key = `g:${getClientKey(req)}`;
  const result = checkRateLimit(globalRate, key, now, RATE_MAX);
  if (!result.ok) {
    res.setHeader("Retry-After", String(result.retryAfterSec));
    res.status(429).json({ error: "Too many requests. Please retry shortly." });
    return;
  }
  if (req.path === "/api/launch") {
    const launchKey = `l:${getClientKey(req)}`;
    const launchResult = checkRateLimit(launchRate, launchKey, now, LAUNCH_RATE_MAX);
    if (!launchResult.ok) {
      res.setHeader("Retry-After", String(launchResult.retryAfterSec));
      res.status(429).json({ error: "Launch rate limit exceeded. Please retry shortly." });
      return;
    }
  }
  next();
});

// Security middleware: reject requests that contain secrets in unexpected fields.
// The only route that legitimately carries a key is /api/aws/proxy-validate.
app.use((req, res, next) => {
  if (req.path === "/api/aws/proxy-validate") {
    next();
    return;
  }
  const bodyStr = JSON.stringify(req.body || {});
  if (containsSecrets(bodyStr)) {
    console.warn(`Blocked request with secret in body: ${req.method} ${req.path} — body redacted: ${redactSecrets(bodyStr)}`);
    res.status(400).json({ error: "Request appears to contain an API key. Keys should only be entered in the credential fields." });
    return;
  }
  next();
});

// Static: Mini App frontend
app.use("/miniapp", express.static(resolve(__dirname, "..", "miniapp"), {
  setHeaders(res) {
    // Telegram webviews can cache aggressively; force fresh miniapp assets.
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  },
}));

// API routes
app.use(healthRouter);
app.use(launchRouter);
app.use(sessionRouter);
app.use(stepRouter);
app.use(awsRouter);
app.use(credentialsRouter);
app.use(soulRouter);
app.use(userRouter);

app.listen(PORT, "127.0.0.1", () => {
  const templateMode = SHARING_ENABLED ? getTemplateMode() : "disabled";
  const templateSources = [
    CFN_TEMPLATE_URL ? "static" : null,
    TEMPLATE_S3_BUCKET && TEMPLATE_S3_KEY ? "presigned" : null,
  ].filter(Boolean).join(",");
  console.log(`CopyLobsta server running on http://127.0.0.1:${PORT}`);
  console.log(`Mini App local URL: http://127.0.0.1:${PORT}/miniapp/`);
  console.log(`Runtime build: git=${getRuntimeGitSha()} templateMode=${templateMode} sources=${templateSources || "none"}`);
});
