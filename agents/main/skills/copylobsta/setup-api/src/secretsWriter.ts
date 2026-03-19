/**
 * Writes API keys to this instance's own AWS Secrets Manager.
 * Uses the instance's IAM role — no credentials needed.
 */

import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const REGION = process.env.AWS_REGION || "us-east-1";
const PREFIX = process.env.SECRET_PREFIX || "openclaw/";

const client = new SecretsManagerClient({ region: REGION });

const SECRET_NAMES: Record<string, string> = {
  anthropic: "anthropic-api-key",
  gemini: "gemini-api-key",
  openai: "openai-api-key",
  telegram: "telegram-bot-token",
};

export async function writeSecret(provider: string, value: string): Promise<void> {
  const name = SECRET_NAMES[provider];
  if (!name) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const secretName = `${PREFIX}${name}`;

  // Try to update existing secret, create if it doesn't exist
  try {
    await client.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );
    // Secret exists — update it
    await client.send(
      new PutSecretValueCommand({
        SecretId: secretName,
        SecretString: value,
      })
    );
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === "ResourceNotFoundException") {
      // Secret doesn't exist — create it
      await client.send(
        new CreateSecretCommand({
          Name: secretName,
          SecretString: value,
          Description: `OpenClaw ${provider} API key — written by CopyLobsta setup`,
        })
      );
    } else {
      throw err;
    }
  }
}
