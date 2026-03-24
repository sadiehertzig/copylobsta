export type SessionState =
  | "WELCOME"
  | "AWS_ACCOUNT_CHECK"
  | "AWS_SIGNUP_GUIDE"
  | "AWS_LAUNCH"
  | "INSTANCE_VERIFY"
  | "CRED_GITHUB"
  | "CRED_ANTHROPIC"
  | "CRED_GEMINI"
  | "CRED_OPENAI"
  | "CRED_TELEGRAM"
  | "SOUL_INTERVIEW"
  | "SOUL_REVIEW"
  | "USER_INTERVIEW"
  | "USER_REVIEW"
  | "DEPLOY"
  | "HANDSHAKE"
  | "COMPLETE"
  | "PAUSED"
  | "FAILED"
  | "ABANDONED";

export type CredentialStatus = "unset" | "valid" | "skipped";

export interface SharingSession {
  launchUrl: string;
  setupBaseUrl: string | null;
  expiresAt: string;
  tunnelPid: number | null;
  status: "active" | "expired" | "closed";
}

export interface Session {
  sessionId: string;
  referrerTelegramId: number | null;
  friendTelegramId: number;
  friendUsername: string | null;
  groupChatId: number | null;
  state: SessionState;
  previousState: SessionState | null; // for PAUSED resume
  createdAt: string;
  updatedAt: string;
  aws: {
    hasAccount: boolean | null;
    stackId: string | null;
    instanceId: string | null;
    instanceIp: string | null;
    setupBaseUrl: string | null;
    ssmVerified: boolean;
    region: string;
  };
  sharingEnabled: boolean;
  sharingSession: SharingSession | null;
  credentials: {
    githubUsername: string | null;
    anthropic: CredentialStatus;
    gemini: CredentialStatus;
    openai: CredentialStatus;
    telegramToken: CredentialStatus;
    botUsername: string | null;
  };
  soul: {
    answers: Record<string, string>;
    draftMarkdown: string | null;
    approved: boolean;
  };
  user: {
    answers: Record<string, string>;
    draftMarkdown: string | null;
    approved: boolean;
  };
  setupToken: string | null; // token for setup API + callback auth
  callbackSecret: string | null; // per-launch HMAC key for instance callback verification
  deploy: {
    startedAt: string | null;
    completedAt: string | null;
    stepsCompleted: string[];
    error: string | null;
  };
}
