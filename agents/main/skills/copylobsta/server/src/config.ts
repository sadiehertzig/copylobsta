import { resolve } from "node:path";
import dotenv from "dotenv";

// Load env from ~/.openclaw/.env (same as trivia_voice)
dotenv.config({ path: resolve(process.env.HOME!, ".openclaw", ".env") });

export const PORT = parseInt(process.env.COPYLOBSTA_PORT || "3457", 10);
export const BOT_TOKEN = process.env.OPENCLAW_TELEGRAM_BOT_TOKEN || "";
export const DEFAULT_CHAT_ID = process.env.OPENCLAW_TELEGRAM_CHAT_ID || "";

// Owner-controlled mode switch. Disabled by default for safer installs.
export const SHARING_MODE = process.env.COPYLOBSTA_SHARING_MODE || "disabled";
export const SHARING_ENABLED = SHARING_MODE === "on_demand";
export const SHARING_TTL_MINUTES = parseInt(process.env.COPYLOBSTA_SHARING_TTL_MINUTES || "45", 10);

// Internal auth: shared secret for host bot -> CopyLobsta calls (e.g. /api/launch)
export const LAUNCH_SECRET = process.env.COPYLOBSTA_LAUNCH_SECRET || "";

// AWS / CloudFormation
export const AWS_REGION = process.env.AWS_REGION || "us-east-1";
export const CFN_TEMPLATE_URL = process.env.CFN_TEMPLATE_URL || "";
export const RELEASE_TAG = process.env.COPYLOBSTA_RELEASE_TAG || "main";
export const SETUP_API_PORT = 8080;
