// Telegram Mini App SDK
const tg = window.Telegram?.WebApp;
if (tg) tg.expand();
const initData = tg?.initData || "";

const API_BASE = window.location.origin;
const REALTIME_MODEL = "gpt-4o-realtime-preview-2025-06-03";

// --- State ---
let peerConnection = null;
let dataChannel = null;
let selectedCategory = "random";
let selectedDifficulty = "any";

// --- DOM refs ---
const screens = {
  setup: document.getElementById("setup-screen"),
  connecting: document.getElementById("connecting-screen"),
  playing: document.getElementById("playing-screen"),
  done: document.getElementById("done-screen"),
  error: document.getElementById("error-screen"),
};

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => {
    el.hidden = k !== name;
  });
}

// --- Setup screen: populate pickers ---
async function initSetup() {
  try {
    const res = await fetch(`${API_BASE}/api/categories`);
    const { categories, difficulties } = await res.json();

    const catPicker = document.getElementById("category-picker");
    // Add "Random" option first
    catPicker.innerHTML = makePill("random", "Random", true);
    categories.forEach((cat) => {
      catPicker.innerHTML += makePill(cat, cat, false);
    });

    const diffPicker = document.getElementById("difficulty-picker");
    diffPicker.innerHTML = makePill("any", "Any", true);
    difficulties.forEach((d) => {
      diffPicker.innerHTML += makePill(d, d, false);
    });

    // Pill click handlers
    catPicker.addEventListener("click", (e) => {
      const pill = e.target.closest(".pill");
      if (!pill) return;
      catPicker.querySelectorAll(".pill").forEach((p) => p.classList.remove("selected"));
      pill.classList.add("selected");
      selectedCategory = pill.dataset.value;
    });

    diffPicker.addEventListener("click", (e) => {
      const pill = e.target.closest(".pill");
      if (!pill) return;
      diffPicker.querySelectorAll(".pill").forEach((p) => p.classList.remove("selected"));
      pill.classList.add("selected");
      selectedDifficulty = pill.dataset.value;
    });
  } catch (err) {
    console.error("Failed to load categories:", err);
  }
}

function makePill(value, label, selected) {
  return `<button class="pill${selected ? " selected" : ""}" data-value="${value}">${label}</button>`;
}

// --- Start voice session ---
async function startSession() {
  showScreen("connecting");

  try {
    // 1. Get microphone
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // 2. Get ephemeral session from our server
    const sessionRes = await fetch(`${API_BASE}/api/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Init-Data": initData,
      },
      body: JSON.stringify({
        category: selectedCategory,
        difficulty: selectedDifficulty,
      }),
    });

    if (!sessionRes.ok) {
      const err = await sessionRes.json();
      throw new Error(err.error || "Failed to create session");
    }

    const { client_secret, user_id } = await sessionRes.json();
    const ephemeralKey = client_secret.value;

    // 3. Create WebRTC peer connection
    peerConnection = new RTCPeerConnection();

    // Add mic track
    stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

    // Handle remote audio (Host's voice)
    const audioEl = document.getElementById("remote-audio");
    peerConnection.ontrack = (event) => {
      audioEl.srcObject = event.streams[0];
    };

    // 4. Create data channel for Realtime API events
    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.onopen = () => {
      console.log("Data channel open");
      showScreen("playing");
      updateAudioBars(true);
    };
    dataChannel.onmessage = (event) => handleRealtimeEvent(JSON.parse(event.data), user_id);
    dataChannel.onclose = () => {
      console.log("Data channel closed");
      cleanup(stream);
    };

    // 5. Create SDP offer and connect to OpenAI Realtime
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const sdpRes = await fetch(
      `https://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      }
    );

    if (!sdpRes.ok) {
      throw new Error(`OpenAI SDP exchange failed: ${sdpRes.status}`);
    }

    const answerSdp = await sdpRes.text();
    await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });

    // Connection established — Host will greet and start asking questions
    // (driven by the personality prompt's "on first connect" instruction)
  } catch (err) {
    console.error("Session start error:", err);
    showError(err.message);
  }
}

// --- Handle Realtime API events from the data channel ---
async function handleRealtimeEvent(event, userId) {
  switch (event.type) {
    case "response.function_call_arguments.done": {
      // Proxy tool call to our server
      const { name, arguments: argsJson, call_id } = event;
      const args = JSON.parse(argsJson || "{}");

      try {
        const toolRes = await fetch(`${API_BASE}/api/tool`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Init-Data": initData,
          },
          body: JSON.stringify({ tool_name: name, arguments: args }),
        });

        const result = await toolRes.json();

        // Update UI based on tool results
        updateUIFromTool(name, result);

        // Send function output back to OpenAI via data channel
        sendDataChannelEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id,
            output: JSON.stringify(result),
          },
        });

        // Trigger Host to respond
        sendDataChannelEvent({ type: "response.create" });
      } catch (err) {
        console.error("Tool call error:", err);
        // Send error back so Host can recover
        sendDataChannelEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id,
            output: JSON.stringify({ error: err.message }),
          },
        });
        sendDataChannelEvent({ type: "response.create" });
      }
      break;
    }

    case "input_audio_buffer.speech_started":
      document.getElementById("status-text").textContent = "You're speaking...";
      updateAudioBars(true);
      break;

    case "input_audio_buffer.speech_stopped":
      document.getElementById("status-text").textContent = "Thinking...";
      break;

    case "response.audio.delta":
      document.getElementById("status-text").textContent = "Host is talking...";
      updateAudioBars(true);
      break;

    case "response.done":
      document.getElementById("status-text").textContent = "Listening...";
      // Report token usage to spend tracker
      if (event.response?.usage) {
        const u = event.response.usage;
        fetch(`${API_BASE}/api/log-usage`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Init-Data": initData,
          },
          body: JSON.stringify({
            input_tokens: u.input_tokens || 0,
            output_tokens: u.output_tokens || 0,
          }),
        }).catch(() => {});
      }
      break;

    case "error":
      console.error("Realtime error:", event.error);
      if (event.error?.message) {
        document.getElementById("status-text").textContent = "Error - try again";
      }
      break;
  }
}

function sendDataChannelEvent(event) {
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(JSON.stringify(event));
  }
}

// --- Update UI from tool call results ---
function updateUIFromTool(toolName, result) {
  if (toolName === "grade_answer" && result.score !== undefined) {
    document.getElementById("streak-display").textContent = result.streak;
    document.getElementById("score-display").textContent = `Score: ${result.score}`;
    // Streak highlight animation
    const streakEl = document.getElementById("streak-display");
    streakEl.style.transform = "scale(1.3)";
    setTimeout(() => { streakEl.style.transform = "scale(1)"; }, 300);
  }

  if (toolName === "get_status" && result.score !== undefined) {
    document.getElementById("streak-display").textContent = result.streak;
    document.getElementById("score-display").textContent = `Score: ${result.score}`;
  }

  if (toolName === "stop_game" && result.finalStats) {
    const s = result.finalStats;
    document.getElementById("final-score").textContent =
      `${s.totalCorrect} / ${s.totalAsked} correct | Best streak: ${s.streak}`;
    showScreen("done");
  }
}

function updateAudioBars(active) {
  const bars = document.querySelector(".audio-bars");
  if (bars) bars.classList.toggle("inactive", !active);
}

// --- Cleanup ---
function cleanup(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  dataChannel = null;
}

// --- Stop game ---
async function stopGame() {
  try {
    // Tell OpenAI to call stop_game
    sendDataChannelEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "I want to stop the game." }],
      },
    });
    sendDataChannelEvent({ type: "response.create" });
  } catch (err) {
    // If data channel is dead, just show done screen
    showScreen("done");
    document.getElementById("final-score").textContent = "Thanks for playing!";
  }
}

// --- Error handling ---
function showError(msg) {
  document.getElementById("error-msg").textContent = msg;
  showScreen("error");
}

// --- Event listeners ---
document.getElementById("start-btn").addEventListener("click", startSession);
document.getElementById("stop-btn").addEventListener("click", stopGame);
document.getElementById("retry-btn").addEventListener("click", () => {
  showScreen("setup");
});
document.getElementById("restart-btn").addEventListener("click", () => {
  showScreen("setup");
});
document.getElementById("close-btn").addEventListener("click", () => {
  if (tg) tg.close();
});

// --- Init ---
initSetup();
