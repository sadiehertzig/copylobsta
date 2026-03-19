/**
 * Security scaffolding: detect accidental API key pastes and redact secrets from logs.
 */

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "Anthropic API key", regex: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
  { name: "OpenAI API key", regex: /sk-proj-[a-zA-Z0-9_-]{20,}/ },
  { name: "OpenAI legacy key", regex: /sk-[a-zA-Z0-9]{20,}/ },
  { name: "Google API key", regex: /AIza[a-zA-Z0-9_-]{30,}/ },
  { name: "AWS access key", regex: /AKIA[A-Z0-9]{16}/ },
  { name: "Telegram bot token", regex: /\d{8,10}:[A-Za-z0-9_-]{35}/ },
];

/** Scan text for patterns that look like API keys or secrets. Returns matched pattern names. */
export function scanForSecrets(text: string): string[] {
  const matches: string[] = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    if (regex.test(text)) {
      matches.push(name);
    }
  }
  return matches;
}

/** Returns true if the text contains anything that looks like a secret. */
export function containsSecrets(text: string): boolean {
  return SECRET_PATTERNS.some(({ regex }) => regex.test(text));
}

/** Replace any detected secrets in text with [REDACTED]. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { regex } of SECRET_PATTERNS) {
    result = result.replace(new RegExp(regex.source, "g"), "[REDACTED]");
  }
  return result;
}
