import { categoryIdFor } from "./categories.js";

/** Fetch a single multiple-choice question from OpenTDB. */
async function fetchQuestion({ category = null, difficulty = null } = {}) {
  let url = "https://opentdb.com/api.php?amount=1&type=multiple&encode=url3986";
  const catId = typeof category === "number" ? category : categoryIdFor(category);
  if (catId) url += `&category=${catId}`;
  if (difficulty && difficulty !== "any") url += `&difficulty=${difficulty}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenTDB returned ${res.status}`);
  const data = await res.json();

  if (!data.results || data.results.length === 0) {
    throw new Error("No questions returned from OpenTDB");
  }

  const raw = data.results[0];
  const decode = (s) => decodeURIComponent(s);

  const correct = decode(raw.correct_answer);
  const incorrect = raw.incorrect_answers.map(decode);
  const allAnswers = shuffle([correct, ...incorrect]);
  const labels = ["A", "B", "C", "D"];

  const options = allAnswers.map((text, i) => ({
    label: labels[i],
    text,
    correct: text === correct,
  }));

  return {
    question: decode(raw.question),
    category: decode(raw.category),
    difficulty: raw.difficulty,
    options,
    correctAnswer: correct,
    correctLabel: options.find((o) => o.correct).label,
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Simple Levenshtein distance for short-string fuzzy matching. */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1);
    row[0] = i;
    return row;
  });
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** In-memory per-user trivia game state. */
export class TriviaGame {
  constructor(userId) {
    this.userId = userId;
    this.currentQuestion = null;
    this.score = 0;
    this.streak = 0;
    this.totalAsked = 0;
    this.totalCorrect = 0;
    this.preferences = { category: null, difficulty: null };
  }

  async askQuestion() {
    const q = await fetchQuestion(this.preferences);
    this.currentQuestion = q;
    this.totalAsked++;
    // Return sanitized version — no correct answer exposed
    return {
      question: q.question,
      category: q.category,
      difficulty: q.difficulty,
      options: q.options.map(({ label, text }) => ({ label, text })),
    };
  }

  gradeAnswer(userAnswer) {
    if (!this.currentQuestion) {
      return { ok: false, error: "No active question. Call ask_question first." };
    }

    const q = this.currentQuestion;
    // Strip "final answer" prefix if it leaked through from speech
    const cleaned = userAnswer.replace(/^.*final\s+answer[,:\s]*/i, "").trim();
    const normalized = cleaned.toUpperCase();
    const correctUpper = q.correctAnswer.toUpperCase();

    // 1. Exact match by label (A/B/C/D) or full text
    let isCorrect =
      normalized === q.correctLabel ||
      normalized === correctUpper ||
      q.options.some((o) => o.correct && normalized === o.text.toUpperCase());

    // 2. Substring / contains match (handles speech filler like "I think it's Paris")
    if (!isCorrect) {
      isCorrect =
        normalized.includes(correctUpper) ||
        correctUpper.includes(normalized) ||
        q.options.some((o) => o.correct && (
          normalized.includes(o.text.toUpperCase()) ||
          o.text.toUpperCase().includes(normalized)
        ));
      // Guard against very short substrings matching accidentally (e.g. "A" inside "FRANCE")
      if (isCorrect && normalized.length < 3 && normalized !== q.correctLabel) {
        isCorrect = false;
      }
    }

    // 3. Fuzzy match via Levenshtein distance (handles speech-to-text typos)
    if (!isCorrect && normalized.length >= 3) {
      const maxDist = Math.max(1, Math.floor(correctUpper.length * 0.3));
      if (levenshtein(normalized, correctUpper) <= maxDist) {
        isCorrect = true;
      } else {
        // Also check against each option text
        isCorrect = q.options.some((o) =>
          o.correct && levenshtein(normalized, o.text.toUpperCase()) <= maxDist
        );
      }
    }

    if (isCorrect) {
      this.score++;
      this.streak++;
      this.totalCorrect++;
    } else {
      this.streak = 0;
    }

    const result = {
      correct: isCorrect,
      correctAnswer: `${q.correctLabel}. ${q.correctAnswer}`,
      score: this.score,
      streak: this.streak,
    };

    this.currentQuestion = null;
    return result;
  }

  getStatus() {
    return {
      score: this.score,
      streak: this.streak,
      totalAsked: this.totalAsked,
      totalCorrect: this.totalCorrect,
      hasActiveQuestion: !!this.currentQuestion,
      preferences: { ...this.preferences },
    };
  }

  setPreferences({ category, difficulty }) {
    if (category !== undefined) this.preferences.category = category === "random" ? null : category;
    if (difficulty !== undefined) this.preferences.difficulty = difficulty === "any" ? null : difficulty;
    return { ok: true, preferences: { ...this.preferences } };
  }

  stop() {
    const stats = this.getStatus();
    this.currentQuestion = null;
    return { ok: true, finalStats: stats };
  }
}

/** Store active games by userId. */
const games = new Map();

export function getOrCreateGame(userId) {
  if (!games.has(userId)) {
    games.set(userId, new TriviaGame(userId));
  }
  return games.get(userId);
}

export function removeGame(userId) {
  games.delete(userId);
}
