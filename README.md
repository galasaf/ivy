# Ivy — Voice-Only English Practice

A voice-only conversation app: you talk to Ivy, an LLM agent, and she talks back. No text is ever shown or typed — the whole conversation happens by speaking and listening, with an animated avatar that moves her mouth while speaking.

**Try it in the browser: https://galasaf.github.io/ivy/** — the hosted version runs entirely client-side (`docs/`): you paste your own Anthropic API key, which is stored only in your browser and sent only to Anthropic, and progress is kept in localStorage. The rest of this README describes the local server version, which keeps the key server-side and stores progress in files.

## How the adaptive vocabulary works

1. **Frequency priority.** The app ships with a list of the most commonly used English words, ordered by frequency (`data/words.js`). The agent is told to weave the highest-frequency words into every reply and steer topics so you say them too.
2. **Mastery deprioritization.** Everything you say is transcribed and counted. Once you have spoken a word twice, it counts as *mastered* and is heavily deprioritized — the agent stops targeting it and moves down the list to the next most common words you haven't used yet.
3. **Resurfacing.** A mastered word you haven't spoken in 14 days slowly comes back: up to 3 of the longest-unused words per turn become *review words* that the agent gently works into conversation to check you still remember them. Saying a review word refreshes it and sends it back to dormant; if you've genuinely forgotten it, it keeps being practiced.

So the agent starts with the most common English words, continuously advances to new vocabulary as you demonstrate the old, and quietly re-checks old vocabulary before it fades.

## Multiple learners

The app supports multiple learners on the same machine. On first visit you're asked for a name; each learner's vocabulary progress is stored separately in `data/profiles/<name>.json` and remembered via a browser cookie. Use the small "switch" link under the mastered-words counter to change learner.

Sign-in is by name only (no password) — appropriate for a household app. Before hosting this on the public internet, add real authentication: a password hash in the profile checked in `POST /api/user`, and a signed session token instead of the plain name cookie (the code comments mark both spots).

## Requirements

- Node.js 18+
- An Anthropic API key
- Chrome or Edge (uses the Web Speech API for free on-device/browser speech recognition and text-to-speech)

## Run it (easy way)

Double-click **`Start Ivy.cmd`**. On first run it installs dependencies and asks for your API key once (saved to a local `.env` file); after that it just starts the server and opens the browser.

## Run it (manual way)

```powershell
cd language_app
npm install
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # or put ANTHROPIC_API_KEY=... in a .env file
npm start
```

Then open **http://localhost:4780** in Chrome or Edge, press **Start conversation**, and allow microphone access. Ivy greets you first; speak when the ring around her turns green. (Set `$env:PORT` before `npm start` to use a different port.)

## Choosing a model

Ivy runs on **Claude Haiku** by default — the fastest and cheapest option, which matters most in a voice loop. Two ways to switch:

- **In the app:** the "Ivy's brain" dropdown under the mastered-words counter (Haiku / Sonnet / Opus). Takes effect on the next reply, even mid-conversation.
- **At startup:** `$env:MODEL = "sonnet"` (accepts `haiku`, `sonnet`, `opus`, or a full model id like `claude-opus-4-8`).

Rough cost per hour of conversation: Haiku ≈ $0.25, Sonnet ≈ $0.75, Opus ≈ $1–2. Step up if Ivy's word-weaving starts to feel forced or quiz-like.

## Reset progress

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:4780/api/reset -ContentType application/json -Body '{"name": "the-learner-name", "clearProgress": true}'
```

## Shared access on the hosted version (optional)

By default the GitHub Pages build asks every visitor for their own API key. To let family use it without keys, deploy `proxy/ivy-proxy.php` to any PHP host: copy `proxy/ivy-config.sample.php` to `ivy-config.php` beside it, fill in the real API key and a passphrase (that file must never be committed or publicly readable as text), then set `PROXY_URL` at the top of `docs/app.js` to the proxy's URL. Visitors can then enter either the passphrase or their own key. Never put the raw API key at any URL a browser can fetch — that publishes it. Set a monthly spend limit in the Anthropic console as a backstop.

## Putting it online (later)

The server is a plain Node/Express app, so any Node host works (a small VPS, Railway, Render, Fly.io): copy the folder, set `ANTHROPIC_API_KEY` in the host's environment, run `node server.js`. Two things to know first:

1. **HTTPS is required** — browsers only allow microphone access on `https://` (localhost is the sole exception), so put the app behind TLS (most platforms do this for you).
2. **Add real logins first** — see the note under "Multiple learners". As-is, anyone who can reach the server can talk (spending your API credits) and open any profile by name.

## Architecture

- `server.js` — Express server. Tracks word mastery, computes the current target and review words, and calls the Claude API (Haiku by default, switchable) with a stable system prompt plus a per-turn vocabulary block.
- `data/words.js` — ~490 English words in approximate frequency order.
- `public/` — browser client: speech recognition → `/api/chat` → speech synthesis, with an SVG avatar (blinking eyes, lip-synced mouth, listening/thinking/speaking state ring).

## Credits

3D avatar model: example avatar from the [TalkingHead](https://github.com/met4citizen/TalkingHead) project (created with Avaturn; non-commercial use). Rendered with [three.js](https://threejs.org).
