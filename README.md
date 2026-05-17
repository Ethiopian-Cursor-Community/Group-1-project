<div align="center">
<img width="1200" height="475" alt="C_GUIDE banner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />

# C_GUIDE

**Your AI co-pilot for any web app.** Capture your screen or any browser tab, ask in voice or text, and get a step-by-step guide with a moving phantom cursor that points to the exact button to click — refined per step by Gemini.

</div>

---

## Table of contents

1. [What is C_GUIDE?](#what-is-c_guide)
2. [Features at a glance](#features-at-a-glance)
3. [Architecture overview](#architecture-overview)
4. [How the AI providers are used](#how-the-ai-providers-are-used)
   - [Gemini (`@google/genai`)](#gemini-googlegenai)
   - [Cursor SDK (`@cursor/sdk`)](#cursor-sdk-cursorsdk)
5. [Per-step refinement (the moving cursor)](#per-step-refinement-the-moving-cursor)
6. [REST API reference](#rest-api-reference)
7. [Quick start](#quick-start)
8. [Project layout](#project-layout)
9. [Environment variables](#environment-variables)
10. [Hotkey & UI cheat sheet](#hotkey--ui-cheat-sheet)
11. [Troubleshooting](#troubleshooting)
12. [Extending C_GUIDE](#extending-c_guide)

---

## What is C_GUIDE?

C_GUIDE is two cooperating clients sharing one backend:

| Surface | What it does |
| --- | --- |
| **Web app** at `http://localhost:3000` | Shares your screen via `getDisplayMedia`, sends a JPEG frame + your question to Gemini, then animates a phantom cursor over the live preview, refining the target with a **second Gemini call per step**. |
| **Chrome extension** (`extension/`) | Drops onto every other tab, scans real interactive DOM elements, asks Gemini which element each step refers to, and pins a phantom cursor + glowing highlight to that element. A small purple ring follows your mouse to show the extension is alive. |

Both surfaces share the same hotkey: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> (⌘+Shift+L on macOS).

---

## Features at a glance

- 🎙️ **Voice or text input** — Web Speech API in app & extension.
- 🖼️ **Screenshot understanding** — Gemini vision analyzes a JPEG of the user's screen.
- 🖱️ **Phantom cursor** — Moves over the live preview (app) or pins to real DOM elements (extension).
- 🔁 **Per-step refinement** — Every Previous/Next click re-asks the AI _"where exactly for this step?"_, so the cursor stays correct even after the page changes.
- 🧭 **Step navigation** — Numbered list, Previous / Next buttons, ←/→ arrow keys.
- ✨ **Mouse companion** — Purple glowing ring follows your real cursor on any tab to confirm the extension is active.
- 🔄 **Multi-provider with fallback chain** — Gemini → Cursor SDK → local keyword matching. Never returns nothing.
- 🛡️ **API key only** — No GCP / ADC / OAuth.

---

## Architecture overview

```
┌──────────────────────┐                ┌──────────────────────────┐
│  Web app             │                │  Chrome extension        │
│  (Vite + React 19)   │                │  (MV3, content scripts)  │
│  src/App.tsx         │                │  extension/overlay.js    │
│  - getDisplayMedia() │                │  - DOM element scanner    │
│  - SpeechRecognition │                │  - SpeechRecognition      │
│  - phantom cursor    │                │  - phantom + highlight    │
│  - Ctrl+Shift+L      │◄──hotkey───┐   │  - Ctrl+Shift+L           │
└──────────┬───────────┘            │   └──────────┬───────────────┘
           │  JPEG + prompt          │              │  DOM elements + prompt
           ▼                         │              ▼
      ┌────────────────────────────────────────────────────┐
      │                  Express server                    │
      │                    server.ts                       │
      │                                                    │
      │  POST /api/guide       (screenshot → vision)       │
      │  POST /api/guide/step  (re-screenshot per step)    │
      │  POST /api/ask         (DOM elements → steps)      │
      │  POST /api/ask/step    (single DOM element/step)   │
      │  POST /api/session/*   (cross-tab fallback queue)  │
      │  GET  /api/health                                  │
      └────────┬───────────────────────────┬───────────────┘
               │                           │
               ▼                           ▼
       ┌──────────────────┐        ┌────────────────────┐
       │ Gemini API       │        │ Cursor Cloud Agents│
       │ @google/genai    │        │ @cursor/sdk        │
       │ vision + text    │        │ text only (text    │
       │ JSON mode        │        │ fallback / Q&A)    │
       └──────────────────┘        └────────────────────┘
```

Key idea: **the server picks the right provider per request** and always has a graceful fallback path so the user is never left with an empty answer.

---

## How the AI providers are used

### Gemini (`@google/genai`)

File: [`server/gemini.ts`](server/gemini.ts)

- **Single source of truth** for image understanding. Cursor cannot consume screenshots, so anything involving a frame goes here first.
- Client is constructed lazily from `GEMINI_API_KEY`:

  ```ts
  import { GoogleGenAI } from "@google/genai";

  export function createGeminiClient(apiKey: string | undefined) {
    const key = apiKey?.replace(/^["']|["']$/g, "").trim();
    if (!key) return null;
    return new GoogleGenAI({ apiKey: key });
  }
  ```

- Text-only requests use `responseMimeType: "application/json"` to force valid JSON output.
- Vision requests send `inlineData` (base64 JPEG) + a text prompt in one `parts` array.
- A **fallback chain** of Gemini models (`gemini-2.5-flash` → `gemini-2.0-flash-lite` → `gemini-1.5-flash-8b` → `gemini-1.5-flash` → `gemini-2.0-flash`) is tried on `404` / `429` / quota errors so a single revoked model never blocks the user.

### Cursor SDK (`@cursor/sdk`)

File: [`server/cursor.ts`](server/cursor.ts)

C_GUIDE uses Cursor as a **text-mode AI fallback** when Gemini's free-tier quota is exhausted or when an answer doesn't need vision. The integration is intentionally tiny so the SDK can also be used standalone for experiments.

```ts
import { Agent, CursorAgentError } from "@cursor/sdk";

export async function cursorPrompt(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  try {
    const result = await Agent.prompt(prompt, {
      apiKey,                  // CURSOR_API_KEY from .env (starts with crsr_…)
      model: { id: model },    // e.g. "composer-2"
      local: { cwd: process.cwd() },
    });

    if (result.status === "error") {
      throw new Error("Cursor agent run failed");
    }
    return typeof result.result === "string" ? result.result : "";
  } catch (err) {
    if (err instanceof CursorAgentError) {
      // CursorAgentError unwraps the API-level message for nicer logs.
      throw new Error(err.message);
    }
    throw err;
  }
}
```

#### Why `Agent.prompt`?

- **One-shot, no streaming required.** C_GUIDE wants a complete JSON guidance object — `Agent.prompt` returns the final result string when the agent finishes, which fits a request/response HTTP handler cleanly.
- **`local: { cwd }`** runs the agent locally rather than dispatching a cloud Background Agent, which:
  - avoids spinning up a remote sandbox per request,
  - keeps latency low,
  - lets the agent reason about the current project if needed,
  - and does not require a GitHub-linked workspace.
- **`apiKey`** is read fresh from `.env` per request (`normalizeKey` strips quotes/whitespace), so you can rotate keys without restarting `npm run dev`.

#### Where Cursor is invoked

| Route | When Cursor is used |
| --- | --- |
| `POST /api/ask` | Primary path if `AI_PROVIDER=cursor`, **or** as automatic fallback when Gemini returns 429 / `RESOURCE_EXHAUSTED`. |
| `POST /api/ask/step` | Same as above for per-step element matching. |
| `POST /api/guide` (text mode) | Preferred for the text-only fallback when no screenshot is supplied (text reasoning is Cursor's strength). |
| `POST /api/guide` (vision mode) | Used only as a degraded fallback if Gemini is unavailable — Cursor produces best-effort steps with placeholder coordinates because it cannot see the screenshot. |

#### Error handling pattern

Every Cursor call is wrapped in a `try/catch` that recognizes the SDK's `CursorAgentError` and rethrows a plain `Error` with the human-readable message. The route handler turns that into a JSON `{ error }` response so the frontend can show a friendly toast.

#### Tuning knobs

- `CURSOR_MODEL` env (defaults to `composer-2`) is forwarded to `model: { id }`. Swap to any model your Cursor account has access to.
- `CURSOR_API_KEY` env (`crsr_…`) is the only credential needed — no OAuth, no service accounts.
- If you want to switch to **Cloud (Background) Agents** later, remove `local: { cwd }` and Cursor's SDK will run the agent remotely against your linked workspace.

#### A note on `@cursor/sdk` version

This project pins `^1.0.13`. Newer SDK versions add streaming, MCP wiring, and explicit cancellation — they are drop-in if you ever need them. The minimal usage here is forward-compatible.

---

## Per-step refinement (the moving cursor)

A big practical problem with AI UI guides is _"step 1 lands correctly, but step 2 points at the wrong thing"_. C_GUIDE solves this by **re-asking the AI per step** instead of trusting one big response:

| Surface | Per-step call | Endpoint | What is sent |
| --- | --- | --- | --- |
| Web app | New screenshot of the current screen | `POST /api/guide/step` | JPEG + current step text + dimensions |
| Extension | Fresh DOM scan of the current page | `POST /api/ask/step` | Step text + original prompt + previous step texts + live interactive elements |

The endpoints return one updated target (`{ x, y, label }` for vision, `{ elementIndex, label }` for DOM). The frontend then re-positions the phantom cursor, so:

- After the user actually performs step 1, the page changes — step 2 is computed against the new state.
- If the AI returns an invalid element index, the server falls back to local keyword matching so the cursor still lands on _something sensible_.
- If both Gemini and Cursor fail entirely, the extension uses its own local keyword matcher as the last resort.

---

## REST API reference

All endpoints accept and return JSON. CORS is open (`Access-Control-Allow-Origin: *`) so the extension can call from `<all_urls>`.

### `GET /api/health`

Returns provider configuration:

```json
{
  "ok": true,
  "auth": "api-key-only",
  "defaultProvider": "gemini",
  "gemini": { "configured": true, "model": "gemini-2.5-flash" },
  "cursor": { "configured": true, "model": "composer-2" }
}
```

### `POST /api/ask`

Used by the extension's first request on a page.

Request:

```json
{
  "prompt": "How do I create a new repo?",
  "url": "https://github.com/",
  "title": "GitHub",
  "elements": [{ "i": 0, "tag": "a", "text": "New" }, ...],
  "provider": "gemini"   // optional, defaults to AI_PROVIDER
}
```

Response:

```json
{
  "provider": "gemini",
  "answer": "...",
  "steps": ["Click New", "Type a repo name", ...],
  "stepItems": [{ "text": "...", "elementIndex": 3, "target": { "label": "New" } }],
  "elementIndex": 3,
  "label": "New"
}
```

### `POST /api/ask/step`

Re-ask Gemini (or Cursor) for **one specific step's element**, given the page's current state. This is what fixes the _"step 2 points to a random button"_ bug.

```json
{
  "originalPrompt": "How do I create a new repo?",
  "stepText": "Type a repository name",
  "stepIndex": 2,
  "totalSteps": 4,
  "previousSteps": ["Click New"],
  "url": "https://github.com/new",
  "title": "Create a new repository",
  "elements": [...]
}
```

→ `{ "elementIndex": 7, "label": "Repository name", "provider": "gemini" }`

### `POST /api/guide`

Web-app vision path. Sends a JPEG (`image` is base64 without the data URL prefix) and dimensions.

### `POST /api/guide/step`

Web-app per-step refinement. Sends a fresh JPEG + the current step text; returns `{ target: { x, y, label } }` in normalized 0–1000 coordinates.

### `POST /api/session/*`

Lightweight in-memory queue used for the older cross-tab trigger flow. Not required for normal operation.

---

## Quick start

### Prerequisites

- Node.js ≥ 20
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey)
- _(optional)_ A **Cursor API key** from [cursor.com/dashboard](https://cursor.com/dashboard) → API Keys

### 1. Install

```bash
npm install
```

### 2. Configure `.env`

Create `./.env` at the project root:

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-2.5-flash
CURSOR_API_KEY=crsr_...
CURSOR_MODEL=composer-2
```

### 3. Run the dev server

```bash
npm run dev
```

You should see:

```
[env] GEMINI_API_KEY: set (AIza…)
[env] CURSOR_API_KEY: set (crsr_…)
Gemini ready (gemini-2.5-flash, API key)
Cursor ready (composer-2, API key)
Server running on http://localhost:3000
Default AI provider: gemini (api-key auth only)
```

Open `http://localhost:3000`, click **SYNC ENVIRONMENT**, allow screen sharing, and press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> or one of the **Ask / Text** buttons.

### 4. Load the Chrome extension

1. Visit `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension/` folder.
4. _(Optional)_ Open `chrome://extensions/shortcuts` and confirm <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> is bound to **C_GUIDE → Open C_GUIDE**.

The purple ring should now appear on any tab where you move the mouse, confirming the extension is live.

### 5. Production build

```bash
npm run build
npm start
```

This bundles the Vite frontend into `dist/` and emits a CommonJS server at `dist/server.cjs`.

---

## Project layout

```
.
├── .env                       # API keys (gitignored)
├── server.ts                  # Express app + all REST routes
├── server/
│   ├── gemini.ts              # @google/genai client + vision fallback chain
│   ├── cursor.ts              # @cursor/sdk wrapper (Agent.prompt)
│   ├── providers.ts           # Prompts, JSON parsing, element matching
│   └── session.ts             # Cross-tab trigger queue
├── src/                       # React 19 web app
│   ├── App.tsx                # Phantom cursor, capture, modal, step nav
│   ├── main.tsx
│   └── index.css
├── extension/                 # Chrome MV3 extension
│   ├── manifest.json
│   ├── background.js          # Routes Ctrl+Shift+L per-tab type
│   ├── app-bridge.js          # On localhost: dispatch hotkey to app
│   ├── overlay.js             # DOM scan, panel, phantom cursor
│   ├── overlay.css
│   ├── companion.js           # Purple ring following the real cursor
│   └── companion.css
├── index.html
├── vite.config.ts
└── tsconfig.json
```

---

## Environment variables

| Variable | Required? | Default | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | yes (for vision) | — | API key from Google AI Studio |
| `GEMINI_MODEL` | no | `gemini-2.0-flash-lite` | Primary Gemini model — fallback chain handles the rest |
| `CURSOR_API_KEY` | no (recommended) | — | Cursor API key (`crsr_…`) used as text fallback |
| `CURSOR_MODEL` | no | `composer-2` | Cursor agent model id |
| `AI_PROVIDER` | no | `gemini` | Default provider when the request doesn't specify one |

Keys are re-read **per request** (not just at boot), so editing `.env` takes effect without restarting the dev server.

---

## Hotkey & UI cheat sheet

| Action | Where | Shortcut / Button |
| --- | --- | --- |
| Open assistant on localhost app | Web app tab | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> · **Ask** · **Text** |
| Open assistant on any other tab | Any URL | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> · ✦ floating button |
| Voice input | Modal | 🎤 button |
| Next step | App side panel & extension panel | **Next** button · <kbd>→</kbd> |
| Previous step | Same | **Previous** button · <kbd>←</kbd> |
| Close panel | Anywhere | <kbd>Esc</kbd> · × button |

---

## Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| `[env] GEMINI_API_KEY: MISSING` | `.env` is in the wrong folder or has Windows BOM. Recreate as UTF-8. |
| 429 / `RESOURCE_EXHAUSTED` | Free-tier Gemini quota. Add a `CURSOR_API_KEY` so requests automatically fall back to Cursor text mode. |
| `EADDRINUSE :3000` | Another dev server is using port 3000. Kill it: `npx kill-port 3000`. |
| Blank screen-share preview | Re-click **SYNC ENVIRONMENT** and grant the share again. Some Windows Chrome builds detach the stream after Alt-Tab. |
| Extension cursor stays on step 1 | You're on an older build. Reload C_GUIDE in `chrome://extensions` (version should be **2.6.0+**). |
| Purple ring missing on `chrome://` pages | Chrome blocks content scripts on internal URLs — by design. |

---

## Extending C_GUIDE

- **Add a new provider.** Implement it the way `server/cursor.ts` wraps `Agent.prompt`, then plug it into `selectProvider` in `server.ts`.
- **Add custom MCP tools** to the Cursor SDK call by passing `mcp: { ... }` to `Agent.prompt` — see [`@cursor/sdk` docs](https://docs.cursor.com/en/cli/sdk).
- **Switch to streaming.** Use `Agent.create` + `run.stream()` from the Cursor SDK or Gemini's `generateContentStream` and forward chunks via SSE for live token output.
- **Persist conversations.** The current `session.ts` is in-memory; back it with SQLite/Redis to survive restarts.

---

Built with React 19, Express, Tailwind 4, `@google/genai`, and `@cursor/sdk`.
