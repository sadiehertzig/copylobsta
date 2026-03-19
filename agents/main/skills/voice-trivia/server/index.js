import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";

// Load env from ~/.openclaw/.env
import dotenv from "dotenv";
dotenv.config({ path: resolve(process.env.HOME, ".openclaw", ".env") });

import { requireTelegramUser } from "./lib/telegramAuth.js";
import { sendLauncherButton } from "./lib/telegramBotApi.js";
import { createSession } from "./lib/openaiSession.js";
import { getOrCreateGame, removeGame } from "./lib/trivia.js";
import { CATEGORY_NAMES, DIFFICULTIES } from "./lib/categories.js";
import { sendStartupButton, sendNewRoundButton } from "./lib/telegramPoller.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.TRIVIA_PORT || 3456;
const BOT_TOKEN = process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;

const app = express();
app.use(cors());
app.use(express.json());

// --- Static: Mini App frontend ---
app.use("/miniapp", express.static(resolve(__dirname, "miniapp")));

// --- Health check ---
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// --- Categories list (Mini App fetches on load) ---
app.get("/api/categories", (_req, res) => {
  res.json({ categories: CATEGORY_NAMES, difficulties: DIFFICULTIES });
});

// --- Launch: send Mini App button to a chat (called via tunnel URL) ---
app.post("/api/launch", async (req, res) => {
  try {
    const chatId = req.body?.chat_id || process.env.OPENCLAW_TELEGRAM_CHAT_ID;
    if (!chatId) return res.status(400).json({ error: "missing chat_id" });
    await sendLauncherButton(chatId);
    res.json({ ok: true });
  } catch (err) {
    console.error("Launch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Spend tracker helper ---
const SPEND_TRACKER_URL = process.env.SPEND_TRACKER_URL || "http://127.0.0.1:9147/log";

function logSpend(model, inputTokens, outputTokens, meta) {
  fetch(SPEND_TRACKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "openai",
      api_key_label: "trivia-voice",
      model,
      input_tokens: inputTokens || 0,
      output_tokens: outputTokens || 0,
      metadata: meta,
    }),
  }).catch(() => {}); // fire-and-forget
}

// --- Session: Mini App calls this to get an ephemeral OpenAI Realtime key ---
app.post("/api/session", async (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] || "";
    const user = requireTelegramUser(initData, BOT_TOKEN);
    const { category, difficulty } = req.body || {};

    // Set preferences on the game instance before creating the session
    const game = getOrCreateGame(String(user.id));
    if (category || difficulty) {
      game.setPreferences({ category, difficulty });
    }

    const session = await createSession(user.first_name || "Player");

    res.json({ client_secret: session.client_secret, user_id: String(user.id) });
  } catch (err) {
    console.error("Session error:", err.message);
    res.status(401).json({ error: err.message });
  }
});

// --- Usage logging: Mini App reports Realtime API token usage ---
app.post("/api/log-usage", (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] || "";
    requireTelegramUser(initData, BOT_TOKEN);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  const clamp = (v) => Math.max(0, Math.min(parseInt(v) || 0, 10_000_000));
  const { input_tokens, output_tokens } = req.body || {};
  logSpend("gpt-4o-realtime-preview", clamp(input_tokens), clamp(output_tokens), { event: "session_usage" });
  res.json({ ok: true });
});

// --- Tool execution: Mini App proxies Realtime tool calls here ---
app.post("/api/tool", async (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] || "";
    const user = requireTelegramUser(initData, BOT_TOKEN);
    const { tool_name, arguments: args } = req.body;
    const game = getOrCreateGame(String(user.id));

    let result;
    switch (tool_name) {
      case "ask_question":
        result = await game.askQuestion();
        break;
      case "grade_answer":
        result = game.gradeAnswer(args?.user_answer || "");
        break;
      case "get_status":
        result = game.getStatus();
        break;
      case "set_preferences":
        result = game.setPreferences(args || {});
        break;
      case "stop_game":
        result = game.stop();
        removeGame(String(user.id));
        // Send a new callback button for the next round
        sendNewRoundButton().catch((e) => console.error("New round button error:", e.message));
        break;
      default:
        return res.status(400).json({ error: `unknown tool: ${tool_name}` });
    }

    res.json(result);
  } catch (err) {
    console.error("Tool error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Trivia Voice server running on http://0.0.0.0:${PORT}`);
  console.log(`Mini App: http://localhost:${PORT}/miniapp/`);

  // Send Mini App launcher button on startup (if chat ID is configured)
  if (process.env.OPENCLAW_TELEGRAM_CHAT_ID) {
    sendStartupButton();
  }
});
