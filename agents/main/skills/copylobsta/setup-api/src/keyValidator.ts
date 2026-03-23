/**
 * Validates API keys by making test calls to each provider.
 * Runs on the friend's instance — keys never leave this server.
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
  metadata?: Record<string, string>;
}

export async function validateKey(provider: string, key: string): Promise<ValidationResult> {
  switch (provider) {
    case "anthropic":
      return validateAnthropic(key);
    case "gemini":
      return validateGemini(key);
    case "openai":
      return validateOpenAI(key);
    case "telegram":
      return validateTelegram(key);
    default:
      return { valid: false, error: `Unknown provider: ${provider}` };
  }
}

async function validateAnthropic(key: string): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    });
    if (res.ok) {
      return { valid: true };
    }
    const body = await res.json().catch(() => ({}));
    const msg = (body as Record<string, Record<string, string>>)?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) {
      return { valid: false, error: "Invalid API key. Double-check you copied the full key." };
    }
    if (res.status === 403) {
      return { valid: false, error: "Key doesn't have permission. Make sure billing is set up on your Anthropic account." };
    }
    return { valid: false, error: `Anthropic returned an error: ${msg}` };
  } catch (err) {
    return { valid: false, error: `Could not reach Anthropic API. Check your internet connection.` };
  }
}

async function validateGemini(key: string): Promise<ValidationResult> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(key)}`
    );
    if (res.ok) {
      return { valid: true };
    }
    if (res.status === 400 || res.status === 403) {
      return { valid: false, error: "Invalid API key. Make sure you copied the full key from Google AI Studio." };
    }
    return { valid: false, error: `Google API returned HTTP ${res.status}. Try creating a new key.` };
  } catch (err) {
    return { valid: false, error: `Could not reach Google API. Check your internet connection.` };
  }
}

async function validateOpenAI(key: string): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });
    if (res.ok) {
      return { valid: true };
    }
    if (res.status === 401) {
      return { valid: false, error: "Invalid API key. Double-check you copied the full key." };
    }
    if (res.status === 429) {
      return { valid: false, error: "Key is valid but you've hit a rate limit. Make sure you have credits on your OpenAI account." };
    }
    return { valid: false, error: `OpenAI returned HTTP ${res.status}. Make sure your account has credits.` };
  } catch (err) {
    return { valid: false, error: `Could not reach OpenAI API. Check your internet connection.` };
  }
}

async function validateTelegram(token: string): Promise<ValidationResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (!res.ok) {
      return { valid: false, error: "Invalid bot token. Make sure you copied the full token from BotFather." };
    }
    const data = (await res.json()) as { result?: { username?: string; first_name?: string } };
    const username = data.result?.username || "";
    const firstName = data.result?.first_name || "";
    return {
      valid: true,
      metadata: { botUsername: username, botName: firstName },
    };
  } catch (err) {
    return { valid: false, error: `Could not reach Telegram API. Check your internet connection.` };
  }
}
