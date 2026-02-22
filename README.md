# HackersGPT

HackersGPT is a fully client-side, serverless chat UI for cybersecurity questions.

- Static site (no backend, no database)
- Conversations stored locally in your browser (`localStorage`)
- Inference via **LLM7.io** using an OpenAI-compatible API
- Uses Vercel **serverless API routes** (`/api/*`) to proxy to LLM7.io and avoid browser CORS blocks
- Optional live context enrichment: when you ask to "search" / "look up" / a CVE, the browser fetches results and injects them into the prompt

## Run locally

Local running is optional. The recommended way to test is a Vercel preview deployment.

PowerShell:

```powershell
node .\dev-server.mjs
```

Then open `http://localhost:8080`.

Quick check:

```powershell
powershell -ExecutionPolicy Bypass -File .\smoke.ps1 -NoStart
```

## Deploy (Vercel)

1. Push this repo to GitHub.
2. Import the repo in Vercel.
3. Framework preset: **Other** (static).
4. No build step; output is repository root. The proxy lives in `api/`.

## LLM7.io settings

Open **Settings** in the app:

- Base URL: `/api` (recommended; proxy)
- Model: `default` / `fast` / `pro` (pro may require a paid token)
- Token: optional; stored locally for higher rate limits

### If you hit CORS errors

If your browser blocks requests to LLM7.io due to CORS, keep Base URL as `/api`. On Vercel, `/api/*` is handled by serverless routes in `api/`; locally it's provided by `dev-server.mjs`.

## GitHub Pages

GitHub Pages cannot run the `/api/*` proxy routes. If LLM7.io does not allow browser CORS, a pure GitHub Pages deployment will not be able to call the API.

## Privacy

- Chats are stored locally in your browser.
- Your prompts and conversation context are sent directly from your browser to LLM7.io.
