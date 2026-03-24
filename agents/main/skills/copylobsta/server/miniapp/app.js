// CopyLobsta Mini App — client-side JavaScript
const tg = window.Telegram?.WebApp;
const API_BASE = window.location.origin;
const SESSION_TOKEN_STORAGE_KEY = "copylobsta_session_token";
const SESSION_TOKEN_META_KEY = "copylobsta_session_meta";
const CLIENT_TOKEN_MAX_AGE_MS = 110 * 60 * 1000; // Keep client-side lifetime shorter than server TTL (2h).

function loadStoredSessionToken() {
  try {
    const rawMeta = window.localStorage.getItem(SESSION_TOKEN_META_KEY);
    if (rawMeta) {
      const meta = JSON.parse(rawMeta);
      if (!meta?.token || !meta?.issuedAt) {
        window.localStorage.removeItem(SESSION_TOKEN_META_KEY);
        window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
        return null;
      }
      if (Date.now() - Number(meta.issuedAt) > CLIENT_TOKEN_MAX_AGE_MS) {
        window.localStorage.removeItem(SESSION_TOKEN_META_KEY);
        window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
        return null;
      }
      return String(meta.token);
    }
    // Backward compatibility for old single-key token storage.
    const legacyToken = window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
    if (legacyToken) {
      window.localStorage.setItem(
        SESSION_TOKEN_META_KEY,
        JSON.stringify({ token: legacyToken, issuedAt: Date.now() }),
      );
      return legacyToken;
    }
    return null;
  } catch {
    return null;
  }
}

function persistSessionToken(token) {
  try {
    if (!token) {
      window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
      window.localStorage.removeItem(SESSION_TOKEN_META_KEY);
      return;
    }
    window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
    window.localStorage.setItem(
      SESSION_TOKEN_META_KEY,
      JSON.stringify({ token, issuedAt: Date.now() }),
    );
  } catch {
    // Best-effort persistence only.
  }
}

let currentSession = null;
let setupToken = null;
let sessionToken = loadStoredSessionToken(); // Issued by server for non-web_app opens (plain URL buttons)
let pollTimer = null;
let pollTimeoutTimer = null;
let pollErrorCount = 0;
let sessionRefreshInFlight = null;

const CALLBACK_POLL_INTERVAL_MS = 5000;
const CALLBACK_POLL_TIMEOUT_MS = 15 * 60 * 1000;

// ============================================================
// Interview question definitions
// ============================================================

const SOUL_QUESTIONS = [
  { id: "botName", text: "What do you want to name your bot?", required: true, placeholder: "e.g., Luna, Atlas, Sparky" },
  { id: "personality", text: "Describe their personality in 3 words.", required: true, placeholder: "e.g., witty, curious, kind" },
  { id: "vibe", text: "What's their vibe \u2014 sarcastic, warm, dry, chaotic, chill?", required: true, placeholder: "e.g., warm and playful",
    followups: { sarcastic: "How sarcastic? Light teasing or full roast?", chaotic: "Chaotic how? Random tangents or deliberate chaos?", dry: "Dry like deadpan humor, or more reserved?" } },
  { id: "relationship", text: "What's your bot's relationship to you? (friend, tutor, mentor, hype-person, chaos agent...)", required: true, placeholder: "e.g., friend and study buddy" },
  { id: "pushback", text: "Should they push back on you or mostly agree?", required: true, placeholder: "e.g., push back sometimes, but gently" },
  { id: "neverJoke", text: "What topics should they never joke about?", required: false, placeholder: "e.g., family stuff, grades" },
  { id: "expertise", text: "Any topics they should be especially knowledgeable about?", required: false, placeholder: "e.g., math, coding, creative writing" },
  { id: "quirks", text: "Do they have any catchphrases, verbal tics, or stylistic quirks?", required: false, placeholder: "e.g., says 'bet' a lot, uses emoji sparingly" },
  { id: "frustrated", text: "How do they handle it when you're frustrated or upset?", required: true, placeholder: "e.g., calm me down, give me space, crack a joke" },
  { id: "character", text: "If your bot were a character in a movie, who would they be?", required: false, placeholder: "e.g., Gandalf, Wednesday Addams" },
];

const USER_QUESTIONS_SHARED = [
  { id: "name", text: "What's your name? (Or what should your bot call you?)", required: true, placeholder: "e.g., Alex" },
  { id: "role", text: "What do you do? Are you a student, or what's your line of work?", required: true, placeholder: "e.g., high school junior, software engineer, stay-at-home parent" },
];

const USER_QUESTIONS_STUDENT = [
  { id: "grade", text: "What grade are you in?", required: true, placeholder: "e.g., 11th grade, college freshman" },
  { id: "school", text: "What school do you go to? (Optional)", required: false, placeholder: "e.g., Lincoln High" },
  { id: "subjects", text: "What subjects are you taking this year?", required: true, placeholder: "e.g., AP Bio, Calc AB, English, Spanish" },
  { id: "helpSubjects", text: "Which subjects do you need the most help with?", required: true, placeholder: "e.g., math and chemistry",
    followups: { math: "What part of math? Algebra, geometry, calc?", science: "Which science? Bio, chem, physics?", chemistry: "Organic, general, or AP?", physics: "Mechanics, E&M, or modern?" } },
  { id: "interests", text: "What are you into outside of school?", required: false, placeholder: "e.g., basketball, drawing, coding" },
  { id: "goals", text: "Any big goals right now? College apps, a project, learning to code?", required: false, placeholder: "e.g., getting into a good CS program",
    followups: { college: "What year are you applying? Dream school list?", coding: "What language? Beginner, intermediate, or 'I break things and fix them'?", programming: "What language? Beginner, intermediate, or 'I break things and fix them'?" } },
  { id: "studyStyle", text: "How do you like to study? (flashcards, practice problems, explain-it-to-me style)", required: true, placeholder: "e.g., practice problems and then explain what I got wrong" },
  { id: "pushOrEasy", text: "Should your bot push you or go easy?", required: true, placeholder: "e.g., push me on studying, go easy on creative stuff" },
  { id: "anythingElse", text: "Anything else your bot should know about you?", required: false, placeholder: "e.g., I'm a night owl, I have ADHD, I love puns" },
];

const USER_QUESTIONS_ADULT = [
  { id: "occupation", text: "What's your job or role?", required: true, placeholder: "e.g., marketing manager, freelance designer" },
  { id: "botUseCase", text: "What will you mainly use your bot for? (work help, learning, creative projects, staying organized...)", required: true, placeholder: "e.g., brainstorming and research for work" },
  { id: "expertiseAreas", text: "What topics should your bot be most helpful with?", required: true, placeholder: "e.g., data analysis, writing, project management" },
  { id: "skillLevel", text: "How would you rate yourself in those areas? (beginner, intermediate, expert, mixed)", required: true, placeholder: "e.g., expert in writing, beginner in data stuff" },
  { id: "interests", text: "What are you into outside of work?", required: false, placeholder: "e.g., cooking, hiking, sci-fi novels" },
  { id: "goals", text: "Any big goals right now?", required: false, placeholder: "e.g., launch a side project, learn Python" },
  { id: "learnStyle", text: "How do you prefer to learn new things? (deep dives, quick summaries, step-by-step, examples first)", required: true, placeholder: "e.g., give me examples first, then explain the theory" },
  { id: "pushOrEasy", text: "Should your bot challenge you or keep it supportive?", required: true, placeholder: "e.g., challenge me on work stuff, supportive otherwise" },
  { id: "anythingElse", text: "Anything else your bot should know about you?", required: false, placeholder: "e.g., I work best in the morning, prefer bullet points" },
];

// ============================================================
// Interview engine (shared between soul & user)
// ============================================================

function createInterviewState() {
  return { currentIndex: 0, answers: {}, followupActive: null, branch: null };
}

let soulInterview = createInterviewState();
let userInterview = createInterviewState();

function getSoulQuestions() {
  return SOUL_QUESTIONS;
}

function getUserQuestions() {
  if (!userInterview.branch) return USER_QUESTIONS_SHARED;
  return [
    ...USER_QUESTIONS_SHARED,
    ...(userInterview.branch === "student" ? USER_QUESTIONS_STUDENT : USER_QUESTIONS_ADULT),
  ];
}

function detectUserBranch(roleAnswer) {
  const lower = roleAnswer.toLowerCase();
  const studentKeywords = ["student", "school", "grade", "college", "university", "freshman", "sophomore", "junior", "senior", "high school", "middle school", "8th", "9th", "10th", "11th", "12th"];
  return studentKeywords.some((kw) => lower.includes(kw)) ? "student" : "adult";
}

function checkFollowup(question, answer) {
  if (!question.followups || !answer) return null;
  const lower = answer.toLowerCase();
  for (const [trigger, followupText] of Object.entries(question.followups)) {
    if (lower.includes(trigger.toLowerCase())) return followupText;
  }
  return null;
}

function renderInterview(prefix, questions, state) {
  const q = questions[state.currentIndex];
  if (!q) return;

  // Progress
  const progressEl = document.getElementById(`${prefix}-interview-progress`);
  if (progressEl) {
    progressEl.innerHTML = `Question ${state.currentIndex + 1} of ${questions.length}<div class="progress-bar"><div class="progress-fill" style="width: ${((state.currentIndex + 1) / questions.length) * 100}%"></div></div>`;
  }

  // Question text
  document.getElementById(`${prefix}-question-text`).textContent = q.text;

  // Input
  const input = document.getElementById(`${prefix}-answer-input`);
  input.value = state.answers[q.id] || "";
  input.placeholder = q.placeholder || "Type your answer...";
  input.focus();

  // Followup
  const followupEl = document.getElementById(`${prefix}-followup-text`);
  if (state.followupActive) {
    followupEl.textContent = state.followupActive;
    followupEl.classList.remove("hidden");
  } else {
    followupEl.classList.add("hidden");
  }

  // Back button visibility
  const backBtn = document.getElementById(`btn-${prefix}-back`);
  if (backBtn) backBtn.style.visibility = state.currentIndex > 0 ? "visible" : "hidden";

  // Skip button visibility
  const skipBtn = document.getElementById(`btn-${prefix}-skip`);
  if (skipBtn) skipBtn.style.visibility = q.required ? "hidden" : "visible";

  // Next button text
  const nextBtn = document.getElementById(`btn-${prefix}-next`);
  if (nextBtn) nextBtn.textContent = state.currentIndex === questions.length - 1 ? "Finish" : "Next";
}

function handleInterviewNext(prefix, getQuestions, state, onComplete) {
  const questions = getQuestions();
  const q = questions[state.currentIndex];
  const input = document.getElementById(`${prefix}-answer-input`);
  const answer = input?.value?.trim() || "";

  if (q.required && !answer) {
    input.classList.add("input-error");
    setTimeout(() => input.classList.remove("input-error"), 1000);
    return;
  }

  if (answer) state.answers[q.id] = answer;

  // Detect branch for user interview after role question
  if (prefix === "user" && q.id === "role" && answer) {
    state.branch = detectUserBranch(answer);
  }

  // Check for followup
  if (!state.followupActive && answer) {
    const followup = checkFollowup(q, answer);
    if (followup) {
      state.followupActive = followup;
      renderInterview(prefix, getQuestions(), state);
      return;
    }
  }

  state.followupActive = null;

  // Advance
  const updatedQuestions = getQuestions(); // may have changed after branch detection
  if (state.currentIndex < updatedQuestions.length - 1) {
    state.currentIndex++;
    renderInterview(prefix, updatedQuestions, state);
  } else {
    onComplete(state.answers);
  }
}

function handleInterviewBack(prefix, getQuestions, state) {
  if (state.currentIndex <= 0) return;
  state.followupActive = null;
  state.currentIndex--;
  renderInterview(prefix, getQuestions(), state);
}

function handleInterviewSkip(prefix, getQuestions, state, onComplete) {
  const questions = getQuestions();
  const q = questions[state.currentIndex];
  if (q.required) return;

  state.followupActive = null;

  if (state.currentIndex < questions.length - 1) {
    state.currentIndex++;
    renderInterview(prefix, questions, state);
  } else {
    onComplete(state.answers);
  }
}

// ============================================================
// Screen management
// ============================================================

function showScreen(screenId) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  const target = document.getElementById(`screen-${screenId}`);
  if (target) {
    target.classList.add("active");
    updateStepBadges();
    // Auto-actions for certain screens
    if (screenId === "INSTANCE_VERIFY") autoVerifyInstance();
    if (screenId === "SOUL_INTERVIEW") renderInterview("soul", getSoulQuestions(), soulInterview);
    if (screenId === "USER_INTERVIEW") renderInterview("user", getUserQuestions(), userInterview);
  } else {
    showPlaceholder(screenId);
  }
}

function showPlaceholder(state) {
  const el = document.getElementById("screen-placeholder");
  document.getElementById("placeholder-title").textContent = state;
  document.getElementById("placeholder-desc").textContent = "This step is under construction.";
  document.getElementById("placeholder-step").textContent =
    currentSession ? `Step ${currentSession.stepNumber} of ${currentSession.totalSteps}` : "";
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  el.classList.add("active");
}

function showError(message) {
  document.getElementById("error-message").textContent = message;
  showScreen("error");
}

function updateStepBadges() {
  if (!currentSession) return;
  const label = STEP_LABELS[currentSession.state] || "";
  document.querySelectorAll("[data-step]").forEach((badge) => {
    badge.textContent = label
      ? `Step ${currentSession.stepNumber} of ${currentSession.totalSteps} — ${label}`
      : `Step ${currentSession.stepNumber} of ${currentSession.totalSteps}`;
  });
}

// ============================================================
// API helpers
// ============================================================

function getInitDataHeader() {
  return tg?.initData || "";
}

async function refreshSessionAfterAuthFailure() {
  if (sessionRefreshInFlight) return sessionRefreshInFlight;
  sessionRefreshInFlight = (async () => {
    persistSessionToken(null);
    sessionToken = null;
    const headers = {
      "Content-Type": "application/json",
      "x-telegram-init-data": getInitDataHeader(),
    };
    const urlParams = new URLSearchParams(window.location.search);
    const startParam = urlParams.get("start") || undefined;
    const refreshRes = await fetch(`${API_BASE}/api/session`, {
      method: "POST",
      headers,
      body: startParam ? JSON.stringify({ startParam }) : undefined,
    });
    const refreshData = await refreshRes.json().catch(() => ({}));
    if (!refreshRes.ok) {
      throw new Error(refreshData.error || "Session expired. Re-open from Telegram.");
    }
    if (refreshData.sessionToken) {
      sessionToken = refreshData.sessionToken;
      persistSessionToken(sessionToken);
    }
    currentSession = refreshData.session || currentSession;
    return true;
  })();

  try {
    return await sessionRefreshInFlight;
  } finally {
    sessionRefreshInFlight = null;
  }
}

async function apiCall(method, path, body) {
  const headers = {
    "Content-Type": "application/json",
    "x-telegram-init-data": getInitDataHeader(),
  };
  // Include session token for non-web_app opens (plain URL from group chats)
  if (sessionToken) headers["x-session-token"] = sessionToken;

  const opts = { method, headers };
  if (method === "GET") opts.cache = "no-store";
  if (body) opts.body = JSON.stringify(body);
  let res = await fetch(`${API_BASE}${path}`, opts);
  let data = await res.json().catch(() => ({}));
  if (!res.ok && res.status === 401 && sessionToken && path !== "/api/session") {
    await refreshSessionAfterAuthFailure();
    const retryHeaders = {
      ...headers,
    };
    if (sessionToken) retryHeaders["x-session-token"] = sessionToken;
    const retryOpts = { method, headers: retryHeaders };
    if (method === "GET") retryOpts.cache = "no-store";
    if (body) retryOpts.body = JSON.stringify(body);
    res = await fetch(`${API_BASE}${path}`, retryOpts);
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Set a button to loading state (disable + show spinner text). Returns restore function. */
function setButtonLoading(btn) {
  if (!btn) return () => {};
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Loading...";
  btn.style.opacity = "0.7";
  return () => {
    btn.disabled = false;
    btn.textContent = original;
    btn.style.opacity = "1";
  };
}

/** Map states to human-readable step labels. */
const STEP_LABELS = {
  WELCOME: "Getting Started",
  AWS_ACCOUNT_CHECK: "AWS Account",
  AWS_SIGNUP_GUIDE: "AWS Signup",
  AWS_LAUNCH: "Server Launch",
  INSTANCE_VERIFY: "Server Verify",
  CRED_GITHUB: "GitHub",
  CRED_ANTHROPIC: "Anthropic Key",
  CRED_GEMINI: "Gemini Key",
  CRED_OPENAI: "OpenAI Key",
  CRED_TELEGRAM: "Telegram Bot",
  SOUL_INTERVIEW: "Bot Personality",
  SOUL_REVIEW: "Personality Review",
  USER_INTERVIEW: "Your Profile",
  USER_REVIEW: "Profile Review",
  DEPLOY: "Deploying",
  HANDSHAKE: "Say Hello",
  COMPLETE: "Done!",
};

// ============================================================
// Session
// ============================================================

async function loadSession() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const startParam = urlParams.get("start") || undefined;
    const data = await apiCall("POST", "/api/session", startParam ? { startParam } : undefined);
    if (data.sessionToken) {
      sessionToken = data.sessionToken;
      persistSessionToken(sessionToken);
    }
    currentSession = data.session;
    await checkForInstanceDetails();

    // Restore draft docs if resuming a session
    if (currentSession.isResuming) {
      if (currentSession.soul?.draftMarkdown) {
        const el = document.getElementById("soul-preview");
        if (el) el.value = currentSession.soul.draftMarkdown;
      }
      if (currentSession.user?.draftMarkdown) {
        const el = document.getElementById("user-preview");
        if (el) el.value = currentSession.user.draftMarkdown;
      }
    }

    showScreen(currentSession.state);
  } catch (err) {
    console.error("Failed to load session:", err);
    showError(err.message || "Failed to connect to CopyLobsta server.");
  }
}

async function checkForInstanceDetails() {
  if (!currentSession) return;
  try {
    const data = await apiCall("GET", "/api/aws/poll-callback");
    if (data.ready) {
      setupToken = "ready";
    }
  } catch {
    // Not ready yet
  }
}

// ============================================================
// AWS Account Check
// ============================================================

async function handleAwsCheck(hasAccount) {
  try {
    const data = await apiCall("POST", "/api/aws/check", { hasAccount });
    currentSession.state = data.session.state;
    showScreen(currentSession.state);
  } catch (err) {
    showError(err.message);
  }
}

async function handleAwsSignupDone() {
  try {
    const data = await apiCall("POST", "/api/step", { action: "goto", data: { target: "AWS_LAUNCH" } });
    currentSession = data.session;
    showScreen(currentSession.state);
  } catch (err) {
    showError(err.message);
  }
}

// ============================================================
// AWS Launch
// ============================================================

async function handleCfnLaunch() {
  try {
    const data = await apiCall("GET", "/api/aws/quick-create-url");
    const manualLink = document.getElementById("btn-aws-open-manual");
    if (manualLink) {
      manualLink.href = data.url;
      manualLink.classList.remove("hidden");
    }
    const statusEl = document.getElementById("aws-launch-status");
    if (statusEl) {
      statusEl.classList.add("hidden");
      statusEl.textContent = "";
    }
    document.getElementById("btn-aws-recheck")?.classList.add("hidden");

    let launched = false;
    if (tg?.openLink) {
      tg.openLink(data.url);
      launched = true;
    } else {
      const popup = window.open(data.url, "_blank");
      launched = !!popup;
    }
    if (!launched) {
      throw new Error("Could not open AWS Console. Please allow popups/links and tap Launch on AWS again.");
    }

    setupToken = "pending";
    document.getElementById("aws-launch-info").classList.add("hidden");
    document.getElementById("aws-launch-waiting").classList.remove("hidden");
    startCallbackPolling();
  } catch (err) {
    showError(err.message);
  }
}

function clearAwsPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (pollTimeoutTimer) {
    clearTimeout(pollTimeoutTimer);
    pollTimeoutTimer = null;
  }
}

function startCallbackPolling() {
  clearAwsPolling();
  pollErrorCount = 0;

  const statusEl = document.getElementById("aws-launch-status");
  if (statusEl) {
    statusEl.classList.add("hidden");
    statusEl.textContent = "";
  }
  document.getElementById("btn-aws-recheck")?.classList.add("hidden");

  pollTimer = setInterval(async () => {
    try {
      const data = await apiCall("GET", "/api/aws/poll-callback");
      pollErrorCount = 0;
      if (data.ready) {
        clearAwsPolling();
        setupToken = "ready";
        currentSession.state = data.state;
        document.getElementById("aws-launch-waiting").classList.add("hidden");
        document.getElementById("aws-launch-done").classList.remove("hidden");
        document.getElementById("instance-ip-display").textContent = data.instanceIp;
      }
    } catch {
      pollErrorCount += 1;
      if (pollErrorCount >= 3 && statusEl) {
        statusEl.classList.remove("hidden");
        statusEl.textContent = "Still waiting for AWS callback. Make sure your CloudFormation stack is created and still running.";
      }
    }
  }, CALLBACK_POLL_INTERVAL_MS);

  pollTimeoutTimer = setTimeout(() => {
    clearAwsPolling();
    if (statusEl) {
      statusEl.classList.remove("hidden");
      statusEl.textContent = "Timed out waiting for server callback. Open CloudFormation and confirm the stack is CREATE_IN_PROGRESS or CREATE_COMPLETE, then tap Check Again.";
    }
    document.getElementById("btn-aws-recheck")?.classList.remove("hidden");
  }, CALLBACK_POLL_TIMEOUT_MS);
}

async function handleAwsLaunchContinue() {
  try {
    const data = await apiCall("POST", "/api/step", { action: "next" });
    currentSession = data.session;
    showScreen(currentSession.state);
  } catch (err) {
    showError(err.message);
  }
}

// ============================================================
// Instance Verify
// ============================================================

async function autoVerifyInstance() {
  await checkForInstanceDetails();
  if (setupToken) {
    try {
      const data = await apiCall("POST", "/api/step", { action: "next" });
      currentSession = data.session;
      showScreen(currentSession.state);
      return;
    } catch {
      // Not ready yet
    }
  }
  setTimeout(() => autoVerifyInstance(), 3000);
}

// ============================================================
// GitHub
// ============================================================

async function handleGithub(username) {
  try {
    const data = await apiCall("POST", "/api/credentials/github", { username });
    currentSession = data.session;
    showScreen(currentSession.state);
  } catch (err) {
    showError(err.message);
  }
}

// ============================================================
// Credential phase navigation
// ============================================================

function showPhase(provider, phase) {
  document.querySelectorAll(`#screen-CRED_${provider.toUpperCase()} .phase`).forEach((el) => {
    el.classList.add("hidden");
  });
  const target = document.getElementById(`${provider}-phase${phase}`);
  if (target) {
    target.classList.remove("hidden");
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ============================================================
// Key validation
// ============================================================

async function validateKey(provider) {
  const input = document.getElementById(`key-${provider}`);
  const statusEl = document.getElementById(`${provider}-status`);
  const key = input?.value?.trim();

  if (!key) {
    statusEl.textContent = "Please paste your key first.";
    statusEl.className = "validation-status status-error";
    return;
  }
  if (!setupToken) {
    statusEl.textContent = "Server connection not ready. Please wait...";
    statusEl.className = "validation-status status-error";
    return;
  }

  statusEl.textContent = "Validating...";
  statusEl.className = "validation-status status-pending";

  try {
    const data = await apiCall("POST", "/api/aws/proxy-validate", { provider, key });
    if (data.valid) {
      statusEl.className = "validation-status status-success";
      statusEl.textContent = provider === "telegram" && data.metadata?.botUsername
        ? `Connected! Your bot is @${data.metadata.botUsername}`
        : "Valid!";

      const result = await apiCall("POST", "/api/credentials/status", {
        provider,
        valid: true,
        botUsername: data.metadata?.botUsername || null,
      });
      currentSession = result.session;
      setTimeout(() => showScreen(currentSession.state), 1000);
    } else {
      statusEl.textContent = data.error || "Invalid key. Please try again.";
      statusEl.className = "validation-status status-error";
    }
  } catch {
    statusEl.textContent = "Could not connect to your server. Make sure it's still running.";
    statusEl.className = "validation-status status-error";
  }
}

async function skipProvider(provider) {
  try {
    const data = await apiCall("POST", "/api/credentials/status", {
      provider,
      valid: false,
      skipped: true,
    });
    currentSession = data.session;
    showScreen(currentSession.state);
  } catch (err) {
    showError(err.message);
  }
}

// ============================================================
// Toggle password visibility
// ============================================================

function toggleVisibility(targetId) {
  const input = document.getElementById(targetId);
  const btn = document.querySelector(`[data-target="${targetId}"]`);
  if (!input || !btn) return;
  if (input.type === "password") {
    input.type = "text";
    btn.textContent = "Hide";
  } else {
    input.type = "password";
    btn.textContent = "Show";
  }
}

// ============================================================
// Deploy
// ============================================================

let deployBotUsername = null;

async function triggerDeploy() {
  const spinner = document.getElementById("deploy-spinner");
  try {
    const data = await apiCall("POST", "/api/soul/deploy");
    currentSession = data.session;
    deployBotUsername = data.botUsername || null;

    if (currentSession.state === "HANDSHAKE" && deployBotUsername) {
      const link = document.getElementById("btn-open-bot");
      link.href = `https://t.me/${deployBotUsername}`;
      link.textContent = `Open @${deployBotUsername}`;
    }
    if (currentSession.state === "FAILED") {
      const failedMsg = document.getElementById("failed-error-message");
      if (failedMsg && data.error) {
        failedMsg.textContent = data.error;
      }
    }
    showScreen(currentSession.state);
  } catch (err) {
    // Show deploy error with retry option
    if (spinner) spinner.style.display = "none";
    const stepsEl = document.getElementById("deploy-steps");
    if (stepsEl) {
      const failureStep = document.createElement("li");
      failureStep.className = "step-failed";
      failureStep.textContent = err.message || "Deployment failed";
      stepsEl.appendChild(failureStep);
    }
    const retryBtn = document.createElement("button");
    retryBtn.className = "btn-primary";
    retryBtn.textContent = "Retry Deploy";
    retryBtn.style.marginTop = "16px";
    retryBtn.addEventListener("click", () => {
      if (spinner) spinner.style.display = "block";
      retryBtn.remove();
      triggerDeploy();
    });
    stepsEl?.parentElement?.appendChild(retryBtn);
  }
}

// ============================================================
// Event listeners
// ============================================================

// Welcome
document.getElementById("btn-start")?.addEventListener("click", () => {
  apiCall("POST", "/api/step", { action: "next" }).then((data) => {
    currentSession = data.session;
    showScreen(currentSession.state);
  }).catch((err) => showError(err.message));
});

// AWS Account Check
document.getElementById("btn-aws-yes")?.addEventListener("click", () => handleAwsCheck(true));
document.getElementById("btn-aws-no")?.addEventListener("click", () => handleAwsCheck(false));

// AWS Signup Done
document.getElementById("btn-aws-signup-done")?.addEventListener("click", handleAwsSignupDone);

// AWS Launch
document.getElementById("btn-cfn-launch")?.addEventListener("click", handleCfnLaunch);
document.getElementById("btn-aws-launch-continue")?.addEventListener("click", handleAwsLaunchContinue);
document.getElementById("btn-aws-recheck")?.addEventListener("click", () => {
  startCallbackPolling();
});

// GitHub
document.getElementById("btn-github-has-account")?.addEventListener("click", () => showPhase("github", 3));
document.getElementById("btn-github-needs-account")?.addEventListener("click", () => showPhase("github", 2));
document.getElementById("btn-github-signup-done")?.addEventListener("click", () => showPhase("github", 3));
document.getElementById("btn-github-save")?.addEventListener("click", () => {
  const username = document.getElementById("github-username")?.value?.trim();
  if (!username) {
    const input = document.getElementById("github-username");
    input?.classList.add("input-error");
    setTimeout(() => input?.classList.remove("input-error"), 1000);
    return;
  }
  handleGithub(username);
});
document.getElementById("btn-github-skip")?.addEventListener("click", (e) => { e.preventDefault(); handleGithub(null); });

// Phase navigation (all credential screens)
document.querySelectorAll(".phase-next").forEach((btn) => {
  btn.addEventListener("click", () => showPhase(btn.dataset.provider, btn.dataset.phase));
});

// Key validation buttons
document.getElementById("btn-validate-anthropic")?.addEventListener("click", () => validateKey("anthropic"));
document.getElementById("btn-validate-gemini")?.addEventListener("click", () => validateKey("gemini"));
document.getElementById("btn-validate-openai")?.addEventListener("click", () => validateKey("openai"));
document.getElementById("btn-validate-telegram")?.addEventListener("click", () => validateKey("telegram"));

// Skip buttons
document.getElementById("btn-skip-gemini")?.addEventListener("click", (e) => { e.preventDefault(); skipProvider("gemini"); });
document.getElementById("btn-skip-openai")?.addEventListener("click", (e) => { e.preventDefault(); skipProvider("openai"); });

// Password visibility toggles
document.querySelectorAll(".btn-toggle-vis").forEach((btn) => {
  btn.addEventListener("click", () => toggleVisibility(btn.dataset.target));
});

// --- Soul Interview ---
document.getElementById("btn-soul-next")?.addEventListener("click", () => {
  handleInterviewNext("soul", getSoulQuestions, soulInterview, async (answers) => {
    try {
      const data = await apiCall("POST", "/api/soul/answers", { answers });
      currentSession = data.session;
      document.getElementById("soul-preview").value = data.draft;
      showScreen(currentSession.state);
    } catch (err) {
      showError(err.message);
    }
  });
});
document.getElementById("btn-soul-back")?.addEventListener("click", () => {
  handleInterviewBack("soul", getSoulQuestions, soulInterview);
});
document.getElementById("btn-soul-skip")?.addEventListener("click", () => {
  handleInterviewSkip("soul", getSoulQuestions, soulInterview, async (answers) => {
    try {
      const data = await apiCall("POST", "/api/soul/answers", { answers });
      currentSession = data.session;
      document.getElementById("soul-preview").value = data.draft;
      showScreen(currentSession.state);
    } catch (err) {
      showError(err.message);
    }
  });
});

// Enter key advances interview
document.getElementById("soul-answer-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-soul-next")?.click();
});
document.getElementById("user-answer-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-user-next")?.click();
});

// --- Soul Review ---
document.getElementById("btn-soul-approve")?.addEventListener("click", async () => {
  const markdown = document.getElementById("soul-preview")?.value || "";
  try {
    const data = await apiCall("POST", "/api/soul/approve", { markdown });
    currentSession = data.session;
    showScreen(currentSession.state);
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById("btn-soul-redo")?.addEventListener("click", async () => {
  try {
    const data = await apiCall("POST", "/api/step", { action: "goto", data: { target: "SOUL_INTERVIEW" } });
    currentSession = data.session;
    showScreen(currentSession.state);
  } catch {
    showScreen("SOUL_INTERVIEW");
  }
});

// --- User Interview ---
document.getElementById("btn-user-next")?.addEventListener("click", () => {
  handleInterviewNext("user", getUserQuestions, userInterview, async (answers) => {
    try {
      answers.branch = userInterview.branch || "adult";
      const data = await apiCall("POST", "/api/user/answers", { answers });
      currentSession = data.session;
      document.getElementById("user-preview").value = data.draft;
      showScreen(currentSession.state);
    } catch (err) {
      showError(err.message);
    }
  });
});
document.getElementById("btn-user-back")?.addEventListener("click", () => {
  handleInterviewBack("user", getUserQuestions, userInterview);
});
document.getElementById("btn-user-skip")?.addEventListener("click", () => {
  handleInterviewSkip("user", getUserQuestions, userInterview, async (answers) => {
    try {
      answers.branch = userInterview.branch || "adult";
      const data = await apiCall("POST", "/api/user/answers", { answers });
      currentSession = data.session;
      document.getElementById("user-preview").value = data.draft;
      showScreen(currentSession.state);
    } catch (err) {
      showError(err.message);
    }
  });
});

// --- User Review ---
document.getElementById("btn-user-approve")?.addEventListener("click", async () => {
  const markdown = document.getElementById("user-preview")?.value || "";
  try {
    const data = await apiCall("POST", "/api/user/approve", { markdown });
    currentSession = data.session;
    showScreen(currentSession.state);
    triggerDeploy();
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById("btn-user-redo")?.addEventListener("click", async () => {
  try {
    const data = await apiCall("POST", "/api/step", { action: "goto", data: { target: "USER_INTERVIEW" } });
    currentSession = data.session;
    showScreen(currentSession.state);
  } catch {
    showScreen("USER_INTERVIEW");
  }
});

// --- Handshake ---
document.getElementById("btn-handshake-done")?.addEventListener("click", async () => {
  try {
    const data = await apiCall("POST", "/api/soul/complete");
    currentSession = data.session;
    showScreen(currentSession.state);
  } catch (err) {
    showError(err.message);
  }
});

// Retry
document.getElementById("btn-retry")?.addEventListener("click", () => {
  showScreen("loading");
  loadSession();
});

// ============================================================
// Init
// ============================================================

if (tg) {
  tg.ready();
  tg.expand();
}

loadSession();
