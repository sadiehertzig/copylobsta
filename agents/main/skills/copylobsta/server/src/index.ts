import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";

import { PORT } from "./config.js";
import { containsSecrets, redactSecrets } from "./lib/security.js";
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

// CORS: allow local dev + temporary Cloudflare Quick Tunnel origins.
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
      return callback(null, true);
    }
    if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS"));
  },
}));

app.use(express.json());

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
app.use("/miniapp", express.static(resolve(__dirname, "..", "miniapp")));

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
  console.log(`CopyLobsta server running on http://127.0.0.1:${PORT}`);
  console.log(`Mini App local URL: http://127.0.0.1:${PORT}/miniapp/`);
});
