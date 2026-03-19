# Voice Trivia

Voice-first trivia game powered by OpenAI's Realtime API, served as a Telegram Mini App. Falls back to text-based trivia when voice isn't available.

## Usage

- "Let's play trivia"
- "Voice trivia"
- "/trivia"

## How It Works

**Voice mode (Telegram):**
1. Bot sends a Mini App launcher button
2. Tap to open the voice trivia interface
3. Play trivia with voice interaction via OpenAI Realtime API
4. Score tracking and category/difficulty selection

**Text fallback:**
1. Fetches questions from OpenTDB
2. Multiple choice format (A/B/C/D)
3. Grades answers and gives fun facts

## Setup

The voice mode requires a running Express server:

```bash
cd server && npm install
node index.js
```

### Environment Variables

- `TRIVIA_PORT` — Server port (default: 3456)
- `TRIVIA_VOICE_BASE_URL` — Public URL for the Mini App (e.g., Cloudflare tunnel)
- `OPENCLAW_TELEGRAM_BOT_TOKEN` — Telegram bot token
- `OPENCLAW_TELEGRAM_CHAT_ID` — Chat ID for startup button (optional)
- `OPENAI_API_KEY` — Required for Realtime API voice sessions

### Systemd Service

Install `trivia-voice.service` to run as a background service.

## Dependencies

- Node.js >= 20
- OpenAI API key (for Realtime API)
- Telegram bot token

## License

MIT
