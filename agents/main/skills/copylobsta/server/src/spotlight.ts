#!/usr/bin/env node
/**
 * Daily Skill Spotlight — sends one skill teaching message per day via Telegram.
 * Rotates through all available skills with no repeats until the full cycle completes.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CHAT_ID, BOT_TOKEN } from "./config.js";
import { sendMessage } from "./lib/telegramBotApi.js";

// ── Paths ──────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Auto-discover the skills directory by walking up to find the parent `skills/` folder. */
function findSkillsDir(): string {
  // env override for portability
  if (process.env.SPOTLIGHT_SKILLS_DIR) {
    return process.env.SPOTLIGHT_SKILLS_DIR;
  }
  // From dist/ → server/ → copylobsta/ → skills/
  const candidate = resolve(__dirname, "..", "..", "..");
  if (existsSync(candidate) && readdirSync(candidate).some(f => {
    const skillMd = resolve(candidate, f, "SKILL.md");
    return existsSync(skillMd);
  })) {
    return candidate;
  }
  throw new Error(`Could not auto-discover skills directory from ${__dirname}. Set SPOTLIGHT_SKILLS_DIR.`);
}

/** Resolve the history JSON path next to the data/ dir in copylobsta. */
function historyPath(): string {
  // server/ → copylobsta/ → data/
  return resolve(__dirname, "..", "..", "data", "spotlight-history.json");
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  capabilities: string[];   // extracted modes / features
  trySaying: string[];       // example prompts
}

interface HistoryEntry {
  skill: string;
  sentAt: string;
}

interface SpotlightHistory {
  history: HistoryEntry[];
  cycleStartedAt: string | null;
}

// ── Infrastructure skills to skip ──────────────────────────────────────────────

const EXCLUDED_SKILLS = new Set([
  "copylobsta",
  "api-spend-tracker",
]);

// ── SKILL.md parsing ───────────────────────────────────────────────────────────

function parseFrontmatter(content: string): { name: string; description: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { name: "", description: "", body: content };

  const yaml = match[1];
  const body = match[2];

  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  const descMatch = yaml.match(/^description:\s*(.+)$/m);

  return {
    name: nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : "",
    description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : "",
    body,
  };
}

function extractCapabilities(body: string): string[] {
  const capabilities: string[] = [];
  const lines = body.split("\n");

  // Look for H3 headings that represent modes/features
  // Scan for sections like "## Modes", "## Usage", "## Features" and grab their H3 children
  let inModesSection = false;

  for (const line of lines) {
    // Detect mode-like H2 sections
    if (/^##\s+(Modes|Features|What it does|Usage|Capabilities)/i.test(line)) {
      inModesSection = true;
      continue;
    }
    // New H2 ends the modes section
    if (/^##\s+/.test(line) && inModesSection) {
      inModesSection = false;
    }
    // Collect H3 headings within modes sections
    if (inModesSection && /^###\s+/.test(line)) {
      const heading = line.replace(/^###\s+/, "").trim();
      if (heading) capabilities.push(heading);
    }
  }

  // If no modes section found, grab top-level H2 headings as capabilities (skip generic ones)
  if (capabilities.length === 0) {
    const genericH2 = new Set(["startup", "loop", "end output", "tone", "configuration",
      "setup", "install", "requirements", "models", "output structure",
      "wrong answer protocol", "voice preservation", "adaptive rules",
      "quick start", "model + keys", "useful flags", "config", "cli",
      "python", "dependencies", "environment", "notes", "examples",
      "troubleshooting", "overview", "about", "license", "credits",
      "evaluation mode", "output", "input"]);
    for (const line of lines) {
      if (/^##\s+/.test(line)) {
        const heading = line.replace(/^##\s+/, "").trim();
        if (heading && !genericH2.has(heading.toLowerCase())) {
          capabilities.push(heading);
        }
      }
    }
  }

  return capabilities.slice(0, 5); // cap at 5
}

function extractTrySaying(body: string, name: string, description: string): string[] {
  const examples: string[] = [];

  // Look for code blocks with CLI usage
  const cliMatches = body.matchAll(/```(?:bash|sh)\n([\s\S]+?)\n```/g);
  for (const m of cliMatches) {
    const lines = m[1].trim().split("\n");
    for (const line of lines) {
      const cmd = line.trim();
      if (cmd && !cmd.startsWith("#") && !cmd.includes("pip") &&
          !cmd.includes("npm") && !cmd.includes("install") &&
          !cmd.includes("cd ") && !cmd.includes("export ")) {
        examples.push(cmd);
        if (examples.length >= 2) break;
      }
    }
    if (examples.length >= 2) break;
  }

  // Look for Python usage examples
  if (examples.length === 0) {
    const pyMatch = body.match(/```python\n([\s\S]+?)\n```/);
    if (pyMatch) {
      const firstLine = pyMatch[1].trim().split("\n")[0];
      if (firstLine && !firstLine.startsWith("from") && !firstLine.startsWith("import")) {
        examples.push(firstLine);
      }
    }
  }

  // Look for "Ask:" or "Startup" sections with bullet points for conversation starters
  const startupMatch = body.match(/##\s*Startup[\s\S]*?(?=\n##|\n$)/);
  if (startupMatch) {
    const bullets = startupMatch[0].match(/^-\s+(.+)$/gm);
    if (bullets && bullets.length > 0) {
      const topics = bullets.map(b => b.replace(/^-\s+/, "").replace(/\(.*?\)/, "").trim());
      if (topics.length > 0) {
        examples.push(`Tell the bot your ${topics.join(", ").toLowerCase()}`);
      }
    }
  }

  // Generate natural-language prompt based on name
  const slug = name.replace(/_/g, " ").replace(/-/g, " ");
  if (examples.length === 0) {
    // Keep it short — just tell them how to invoke it
    examples.push(`Say "/${name}" or ask your bot about ${slug}`);
  }

  return examples.slice(0, 3);
}

function loadSkills(skillsDir: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const entries = readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (EXCLUDED_SKILLS.has(entry.name)) continue;

    const skillMdPath = resolve(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    try {
      const content = readFileSync(skillMdPath, "utf-8");
      const { name, description, body } = parseFrontmatter(content);

      if (!name && !description) continue; // skip malformed

      const capabilities = extractCapabilities(body);
      const trySaying = extractTrySaying(body, name || entry.name, description);

      skills.push({
        slug: entry.name,
        name: name || entry.name,
        description,
        capabilities,
        trySaying,
      });
    } catch {
      console.warn(`Skipping ${entry.name}: could not parse SKILL.md`);
    }
  }

  return skills;
}

// ── History management ─────────────────────────────────────────────────────────

function loadHistory(path: string): SpotlightHistory {
  if (!existsSync(path)) {
    return { history: [], cycleStartedAt: null };
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { history: [], cycleStartedAt: null };
  }
}

function saveHistory(path: string, history: SpotlightHistory): void {
  writeFileSync(path, JSON.stringify(history, null, 2) + "\n");
}

// ── Message formatting ─────────────────────────────────────────────────────────

function formatMessage(skill: SkillInfo, spotlightedCount: number, totalCount: number): string {
  const lines: string[] = [];

  lines.push("--- Daily Skill Spotlight ---");
  lines.push("");
  lines.push(skill.name.replace(/[_-]/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
  if (skill.description) {
    lines.push(skill.description);
  }

  if (skill.capabilities.length > 0) {
    lines.push("");
    lines.push("What it can do:");
    for (const cap of skill.capabilities) {
      lines.push(`  - ${cap}`);
    }
  }

  if (skill.trySaying.length > 0) {
    lines.push("");
    lines.push("Try saying:");
    for (const example of skill.trySaying) {
      lines.push(`  - "${example}"`);
    }
  }

  lines.push("");
  lines.push(`(${spotlightedCount} of ${totalCount} skills spotlighted this cycle)`);

  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!BOT_TOKEN || !DEFAULT_CHAT_ID) {
    console.error("Missing OPENCLAW_TELEGRAM_BOT_TOKEN or OPENCLAW_TELEGRAM_CHAT_ID");
    process.exit(1);
  }

  const skillsDir = findSkillsDir();
  const skills = loadSkills(skillsDir);

  if (skills.length === 0) {
    console.error("No skills found to spotlight");
    process.exit(1);
  }

  const hPath = historyPath();
  let history = loadHistory(hPath);

  // Determine which skills haven't been spotlighted yet this cycle
  const sentSlugs = new Set(history.history.map(h => h.skill));
  let remaining = skills.filter(s => !sentSlugs.has(s.slug));

  // If all skills have been covered, reset the cycle
  if (remaining.length === 0) {
    console.log("All skills spotlighted — starting new cycle");
    history = { history: [], cycleStartedAt: new Date().toISOString() };
    remaining = skills;
  }

  // Set cycle start if this is the first spotlight
  if (!history.cycleStartedAt) {
    history.cycleStartedAt = new Date().toISOString();
  }

  // Pick a random skill from remaining
  const pick = remaining[Math.floor(Math.random() * remaining.length)];
  const spotlightedCount = history.history.length + 1;
  const totalCount = skills.length;

  const message = formatMessage(pick, spotlightedCount, totalCount);

  console.log(`Spotlighting: ${pick.name}`);
  console.log(message);

  // Send via Telegram
  const result = await sendMessage(DEFAULT_CHAT_ID, message);
  console.log("Telegram response:", JSON.stringify(result));

  // Record in history
  history.history.push({ skill: pick.slug, sentAt: new Date().toISOString() });
  saveHistory(hPath, history);

  console.log(`Done. ${spotlightedCount}/${totalCount} skills spotlighted this cycle.`);
}

main().catch(err => {
  console.error("Spotlight failed:", err);
  process.exit(1);
});
