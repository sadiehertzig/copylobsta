import { buildPersonalityPrompt } from "./personalityPrompt.js";

const TOOL_DEFS = [
  {
    type: "function",
    name: "ask_question",
    description: "Fetch a new trivia question from the database. Call this to start each round.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "grade_answer",
    description: "Grade the player's answer. Pass ONLY the answer letter (A, B, C, or D) or the answer text itself. Strip filler words, preamble, and conversational fluff — just the core answer.",
    parameters: {
      type: "object",
      properties: {
        user_answer: { type: "string", description: "The answer letter (A/B/C/D) or the answer text only — no filler words" },
      },
      required: ["user_answer"],
    },
  },
  {
    type: "function",
    name: "get_status",
    description: "Get current score, streak, and game state.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "set_preferences",
    description: "Change category and/or difficulty for upcoming questions.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "Category name (e.g. science, geography, history) or 'random'" },
        difficulty: { type: "string", enum: ["easy", "medium", "hard", "any"] },
      },
    },
  },
  {
    type: "function",
    name: "stop_game",
    description: "End the trivia session and get final stats.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

/**
 * Create an ephemeral OpenAI Realtime session.
 * Returns { client_secret } for the Mini App to connect directly via WebRTC.
 */
export async function createSession(firstName = "Player") {
  const res = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-realtime-preview-2025-06-03",
      voice: "nova",
      instructions: buildPersonalityPrompt(firstName),
      tools: TOOL_DEFS,
      tool_choice: "auto",
      input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
      turn_detection: {
        type: "server_vad",
        threshold: 0.8,
        prefix_padding_ms: 400,
        silence_duration_ms: 800,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI Realtime session error: ${res.status} ${body}`);
  }

  return res.json();
}
