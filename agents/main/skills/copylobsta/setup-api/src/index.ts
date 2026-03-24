/**
 * CopyLobsta Setup API — runs temporarily on the friend's new EC2 instance.
 *
 * Accepts API keys from the Mini App, validates them, and writes them
 * to this instance's own Secrets Manager. Keys never leave this server.
 *
 * Authenticated via a session token passed as a CFN parameter.
 * Auto-shuts down after 2 hours or when /setup/complete is called.
 */

import express from "express";
import cors from "cors";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateKey } from "./keyValidator.js";
import { readSecret, writeSecret } from "./secretsWriter.js";

const PORT = parseInt(process.env.SETUP_API_PORT || "8080", 10);
const BIND_ADDR = process.env.SETUP_BIND || "127.0.0.1";
const SESSION_TOKEN = process.env.SESSION_TOKEN || "";
const AUTO_SHUTDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_DIR = resolve(MODULE_DIR, "..", "..", "..", "..", "..", "..");

if (!SESSION_TOKEN) {
  console.error("SESSION_TOKEN environment variable is required");
  process.exit(1);
}

const app = express();
// CORS: only the CopyLobsta server (server-to-server proxy) calls this API.
app.use(cors({ origin: false }));
app.use(express.json());

function requireToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const token =
    req.headers["x-session-token"] as string ||
    (req.body as Record<string, unknown>)?.sessionToken as string ||
    "";
  if (token !== SESSION_TOKEN) {
    res.status(401).json({ error: "Invalid session token" });
    return;
  }
  next();
}

app.get("/setup/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.post("/setup/validate-key", requireToken, async (req, res) => {
  const { provider, key } = req.body as { provider?: string; key?: string };

  if (!provider || !key) {
    res.status(400).json({ error: "Missing provider or key" });
    return;
  }

  const result = await validateKey(provider, key);

  if (!result.valid) {
    res.json({ valid: false, error: result.error });
    return;
  }

  try {
    await writeSecret(provider, key);
    res.json({ valid: true, metadata: result.metadata || {} });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to write secret for ${provider}:`, message);
    res.json({
      valid: false,
      error: `Key is valid but we couldn't save it. Error: ${message}`,
    });
  }
});

type StepStatus = "pending" | "running" | "done" | "failed";
interface DeployStep { name: string; status: StepStatus; error?: string }
let deployProgress: DeployStep[] = [];

app.get("/setup/deploy-status", requireToken, (_req, res) => {
  res.json({ steps: deployProgress });
});

async function runDeployStep(name: string, fn: () => Promise<void>): Promise<void> {
  const step = deployProgress.find((s) => s.name === name);
  if (step) step.status = "running";
  try {
    await fn();
    if (step) step.status = "done";
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (step) { step.status = "failed"; step.error = message; }
    throw err;
  }
}

app.post("/setup/deploy", requireToken, async (req, res) => {
  const { soulMarkdown, userMarkdown, botUsername, chatId } = req.body as {
    soulMarkdown?: string;
    userMarkdown?: string;
    githubUsername?: string;
    botUsername?: string;
    chatId?: string;
  };

  if (!soulMarkdown) {
    res.status(400).json({ ok: false, error: "Missing soulMarkdown" });
    return;
  }

  deployProgress = [
    { name: "clone_repo", status: "pending" },
    { name: "install_deps", status: "pending" },
    { name: "write_soul", status: "pending" },
    { name: "write_user", status: "pending" },
    { name: "configure", status: "pending" },
    { name: "start_pm2", status: "pending" },
    { name: "health_check", status: "pending" },
    { name: "auto_restart", status: "pending" },
  ];

  const deployAsync = async () => {
    const { writeFile } = await import("node:fs/promises");

    const homeDir = process.env.HOME || homedir();
    const npmGlobalBin = process.env.NPM_GLOBAL_BIN || resolve(homeDir, ".npm-global", "bin");
    const repoDir = resolve(process.env.COPYLOBSTA_REPO_DIR || DEFAULT_REPO_DIR);
    const allowedRepoRoots = Array.from(new Set([
      DEFAULT_REPO_DIR,
      resolve(homeDir, "copylobsta"),
    ]));

    // Step 1: Verify repo exists (no git pull from moving HEAD)
    await runDeployStep("clone_repo", async () => {
      if (!existsSync(repoDir)) {
        throw new Error(`CopyLobsta repo not found at ${repoDir}`);
      }
      // Restrict deploy writes to expected install paths.
      const isAllowedRepo = allowedRepoRoots.some(
        (root) => repoDir === root || repoDir.startsWith(`${root}/`),
      );
      if (!isAllowedRepo) {
        throw new Error(`COPYLOBSTA_REPO_DIR must be inside: ${allowedRepoRoots.join(", ")}`);
      }
    });

    // Step 2: Install dependencies
    await runDeployStep("install_deps", async () => {
      const installScriptCandidates = [resolve(repoDir, "setup", "install.sh")];
      const installScript = installScriptCandidates.find((p) => existsSync(p));

      if (!installScript) {
        throw new Error(
          `Missing install script. Expected one of: ${installScriptCandidates.join(", ")}`,
        );
      }

      execFileSync("bash", [installScript], {
        cwd: repoDir,
        timeout: 180_000,
        stdio: "pipe",
      });
    });

    // Step 3: Write SOUL.md
    await runDeployStep("write_soul", async () => {
      await writeFile(resolve(repoDir, "agents", "main", "SOUL.md"), soulMarkdown, "utf-8");
    });

    // Step 4: Write USER.md
    await runDeployStep("write_user", async () => {
      if (userMarkdown) {
        await writeFile(resolve(repoDir, "agents", "main", "USER.md"), userMarkdown, "utf-8");
      }
    });

    await runDeployStep("configure", async () => {
      const { readFile } = await import("node:fs/promises");
      const envPath = resolve(homeDir, ".openclaw", ".env");

      // Read validated keys from Secrets Manager and write them to .env
      const [telegramToken, anthropicKey, geminiKey, openaiKey] =
        await Promise.all([
          readSecret("telegram"),
          readSecret("anthropic"),
          readSecret("gemini"),
          readSecret("openai"),
        ]);

      if (!telegramToken) {
        throw new Error(
          "Telegram bot token not found in Secrets Manager. " +
          "Make sure you entered the token from BotFather during setup.",
        );
      }

      let envContent = await readFile(envPath, "utf-8");

      // Helper: set an env var value in the .env file content.
      // Updates existing key or appends if missing.
      const setEnvVar = (key: string, value: string) => {
        const pattern = new RegExp(`^${key}=.*$`, "m");
        if (pattern.test(envContent)) {
          envContent = envContent.replace(pattern, `${key}=${value}`);
        } else {
          envContent += `\n${key}=${value}`;
        }
      };

      setEnvVar("OPENCLAW_TELEGRAM_BOT_TOKEN", telegramToken);
      setEnvVar("TELEGRAM_BOT_TOKEN", telegramToken);
      // Set the default chat ID only if not already configured.
      // This is the friend's DM — the bot's initial "home" conversation.
      if (chatId) {
        const existingChatId = envContent.match(/^OPENCLAW_TELEGRAM_CHAT_ID=(.+)$/m)?.[1]?.trim();
        if (!existingChatId) {
          setEnvVar("OPENCLAW_TELEGRAM_CHAT_ID", chatId);
        }
      }
      if (anthropicKey) setEnvVar("ANTHROPIC_API_KEY", anthropicKey);
      if (geminiKey) setEnvVar("GEMINI_API_KEY", geminiKey);
      if (openaiKey) setEnvVar("OPENAI_API_KEY", openaiKey);
      setEnvVar("USE_AWS_SECRETS", "true");

      await writeFile(envPath, envContent, "utf-8");
      console.log("Configured .env with API keys from Secrets Manager");

      const extraSkillsDir = resolve(repoDir, "agents", "main", "skills");
      if (!existsSync(extraSkillsDir)) {
        throw new Error(`Skills directory not found at ${extraSkillsDir}`);
      }

      const cfgEnv = {
        ...process.env,
        PATH: `${npmGlobalBin}:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
      };

      let existingExtraDirs: string[] = [];
      try {
        const raw = execFileSync(
          "openclaw",
          ["config", "get", "skills.load.extraDirs"],
          { timeout: 5_000, stdio: "pipe", env: cfgEnv },
        ).toString().trim();

        if (raw) {
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (Array.isArray(parsed)) {
              existingExtraDirs = parsed.filter((v): v is string => typeof v === "string");
            } else if (typeof parsed === "string") {
              existingExtraDirs = [parsed];
            }
          } catch {
            existingExtraDirs = [raw];
          }
        }
      } catch {
        // Missing path is fine; we'll write it below.
      }

      const mergedExtraDirs = Array.from(new Set([...existingExtraDirs, extraSkillsDir]));
      execFileSync(
        "openclaw",
        ["config", "set", "skills.load.extraDirs", JSON.stringify(mergedExtraDirs)],
        { timeout: 10_000, stdio: "pipe", env: cfgEnv },
      );
      console.log(`Configured skills.load.extraDirs with ${extraSkillsDir}`);

      // Avoid manual pairing prompts after deploy by pre-authorizing the
      // onboarding user's Telegram DM in allowlist mode.
      if (chatId) {
        const ownerChatId = String(chatId).trim();
        if (ownerChatId) {
          const readAllowFrom = (path: string): string[] => {
            try {
              const raw = execFileSync(
                "openclaw",
                ["config", "get", path],
                { timeout: 5_000, stdio: "pipe", env: cfgEnv },
              ).toString().trim();
              if (!raw) return [];
              try {
                const parsed = JSON.parse(raw) as unknown;
                if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
                return [String(parsed).trim()].filter(Boolean);
              } catch {
                return [raw].map((v) => String(v).trim()).filter(Boolean);
              }
            } catch {
              return [];
            }
          };

          const mergedAllowFrom = Array.from(new Set([
            ...readAllowFrom("channels.telegram.allowFrom"),
            ...readAllowFrom("channels.telegram.accounts.default.allowFrom"),
            ownerChatId,
          ]));

          execFileSync(
            "openclaw",
            ["config", "set", "channels.telegram.allowFrom", JSON.stringify(mergedAllowFrom)],
            { timeout: 10_000, stdio: "pipe", env: cfgEnv },
          );
          execFileSync(
            "openclaw",
            ["config", "set", "channels.telegram.accounts.default.allowFrom", JSON.stringify(mergedAllowFrom)],
            { timeout: 10_000, stdio: "pipe", env: cfgEnv },
          );
          execFileSync(
            "openclaw",
            ["config", "set", "channels.telegram.dmPolicy", "allowlist"],
            { timeout: 10_000, stdio: "pipe", env: cfgEnv },
          );
          execFileSync(
            "openclaw",
            ["config", "set", "channels.telegram.accounts.default.dmPolicy", "allowlist"],
            { timeout: 10_000, stdio: "pipe", env: cfgEnv },
          );
          console.log(`Configured Telegram DM allowlist for owner chat ${ownerChatId}`);
        }
      }
    });

    await runDeployStep("start_pm2", async () => {
      const uid = execFileSync("id", ["-u"], { stdio: "pipe" }).toString().trim();
      const env = {
        ...process.env,
        PATH: `${npmGlobalBin}:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
        XDG_RUNTIME_DIR: `/run/user/${uid}`,
      };
      const nodeMajor = Number(
        execFileSync("node", ["-p", "process.versions.node.split('.')[0]"], {
          timeout: 5_000,
          stdio: "pipe",
          env,
        }).toString().trim(),
      );
      if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
        throw new Error(
          `Node.js 22+ is required for OpenClaw. This instance has Node ${nodeMajor || "unknown"}. Delete the CloudFormation stack and relaunch to provision a fresh instance.`,
        );
      }

      // New OpenClaw versions block gateway start when mode is unset.
      // Force local mode for single-host CopyLobsta deployments.
      execFileSync(
        "openclaw",
        ["config", "set", "gateway.mode", "local"],
        { timeout: 10_000, stdio: "pipe", env },
      );

      execFileSync(
        "openclaw",
        ["gateway", "install", "--force", "--runtime", "node", "--port", "18789"],
        { timeout: 30_000, stdio: "pipe", env },
      );

      // Start the gateway (install only creates/enables the unit file).
      execFileSync(
        "systemctl", ["--user", "start", "openclaw-gateway"],
        { timeout: 15_000, stdio: "pipe", env },
      );

      // Give the gateway a moment to start, then verify it's running.
      await new Promise((r) => setTimeout(r, 2000));
      let status = "unknown";
      try {
        status = execFileSync(
          "systemctl", ["--user", "is-active", "openclaw-gateway"],
          { timeout: 5_000, stdio: "pipe", env },
        ).toString().trim();
      } catch (isActiveErr: unknown) {
        // is-active exits non-zero for inactive/failed — read stdout from the error.
        const stderr = (isActiveErr as { stdout?: Buffer }).stdout?.toString().trim() || "";
        status = stderr || "failed";
      }
      if (status !== "active") {
        let logs = "";
        try {
          logs = execFileSync(
            "journalctl", ["--user", "-u", "openclaw-gateway", "-n", "30", "--no-pager"],
            { timeout: 5_000, stdio: "pipe", env },
          ).toString();
        } catch { /* best effort */ }
        throw new Error(`openclaw-gateway is '${status}'. Recent logs:\n${logs}`);
      }
    });

    await runDeployStep("health_check", async () => {
      await new Promise((r) => setTimeout(r, 3000));
      let healthOk = false;
      let lastCurlError = "";
      for (let attempt = 1; attempt <= 30; attempt += 1) {
        try {
          execFileSync(
            "curl",
            ["-sf", "--max-time", "2", "http://localhost:18789/healthz"],
            { timeout: 5_000, stdio: "pipe" },
          );
          healthOk = true;
          break;
        } catch (curlErr: unknown) {
          const out = (curlErr as { stderr?: Buffer; stdout?: Buffer }).stderr?.toString().trim()
            || (curlErr as { stdout?: Buffer }).stdout?.toString().trim()
            || "curl exited non-zero";
          lastCurlError = out;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (!healthOk) {
        const uid = execFileSync("id", ["-u"], { stdio: "pipe" }).toString().trim();
        const env = {
          ...process.env,
          PATH: `${npmGlobalBin}:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
          XDG_RUNTIME_DIR: `/run/user/${uid}`,
        };
        let status = "unknown";
        let logs = "";
        try {
          status = execFileSync(
            "systemctl", ["--user", "is-active", "openclaw-gateway"],
            { timeout: 5_000, stdio: "pipe", env },
          ).toString().trim();
        } catch (statusErr: unknown) {
          status = (statusErr as { stdout?: Buffer }).stdout?.toString().trim() || "failed";
        }
        try {
          logs = execFileSync(
            "journalctl", ["--user", "-u", "openclaw-gateway", "-n", "50", "--no-pager"],
            { timeout: 8_000, stdio: "pipe", env },
          ).toString();
        } catch {
          logs = "(unable to read openclaw-gateway logs)";
        }
        throw new Error(
          `Gateway health check failed after 60s on http://localhost:18789/healthz. `
          + `Last curl error: ${lastCurlError || "unknown"}. `
          + `Service status: ${status}. Recent logs:\n${logs}`,
        );
      }

      // Verify the bot token actually works against Telegram's API.
      const token = await readSecret("telegram");
      if (!token) {
        throw new Error("Telegram bot token not found in Secrets Manager after configure step");
      }
      const getMeRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      if (!getMeRes.ok) {
        throw new Error(`Telegram bot token failed getMe check (HTTP ${getMeRes.status})`);
      }
      const getMeData = (await getMeRes.json()) as {
        ok?: boolean;
        result?: { username?: string };
      };
      if (!getMeData.ok) {
        throw new Error("Telegram getMe returned ok=false — token may be revoked");
      }
      const liveUsername = getMeData.result?.username?.toLowerCase() || "";
      const expectedBot = (botUsername || "").replace(/^@/, "").trim().toLowerCase();
      if (expectedBot && liveUsername && liveUsername !== expectedBot) {
        throw new Error(
          `Telegram bot mismatch: expected @${expectedBot}, got @${liveUsername}`,
        );
      }

      // Verify the full OpenClaw channel wiring is healthy (not just token validity).
      const hcUid = execFileSync("id", ["-u"], { stdio: "pipe" }).toString().trim();
      const hcEnv = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${hcUid}` };
      const healthJson = execFileSync("bash", ["-lc", "openclaw health --json"], {
        timeout: 20_000,
        stdio: "pipe",
        env: hcEnv,
      }).toString("utf8");
      const parsed = JSON.parse(healthJson) as {
        ok?: boolean;
        channels?: {
          telegram?: {
            configured?: boolean;
            probe?: { ok?: boolean; bot?: { username?: string } };
            accounts?: Record<string, { probe?: { ok?: boolean; bot?: { username?: string } } }>;
          };
        };
      };
      const tg = parsed.channels?.telegram;
      const probe = tg?.accounts?.default?.probe || tg?.probe;
      if (!parsed.ok || !tg?.configured || !probe?.ok) {
        throw new Error("openclaw health check failed: Telegram channel is not ready");
      }
    });

    await runDeployStep("auto_restart", async () => {
      try {
        const arUid = execFileSync("id", ["-u"], { stdio: "pipe" }).toString().trim();
        const arEnv = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${arUid}` };
        execFileSync(
          "systemctl", ["--user", "enable", "openclaw-gateway"],
          { timeout: 10_000, stdio: "pipe", env: arEnv }
        );
      } catch {
        // Best effort
      }
    });
  };

  try {
    await deployAsync();
    res.json({ ok: true, botUsername: botUsername || null });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Deploy error:", message);
    res.json({ ok: false, error: message });
  }
});

app.post("/setup/complete", requireToken, (_req, res) => {
  res.json({ ok: true, message: "Setup complete. Shutting down setup API." });
  console.log("Setup complete. Shutting down in 5 seconds...");

  // Stop temporary setup tunnel if it exists.
  try {
    execFileSync("pkill", ["-f", "cloudflared tunnel --url http://localhost:8080"], { stdio: "pipe" });
  } catch {
    // Best effort
  }

  setTimeout(() => process.exit(0), 5000);
});

const server = app.listen(PORT, BIND_ADDR, () => {
  console.log(`CopyLobsta Setup API running on http://${BIND_ADDR}:${PORT}`);
  console.log(`Auto-shutdown in ${AUTO_SHUTDOWN_MS / 1000 / 60} minutes`);
});

setTimeout(() => {
  console.log("Auto-shutdown timeout reached. Exiting.");
  server.close();
  process.exit(0);
}, AUTO_SHUTDOWN_MS);
