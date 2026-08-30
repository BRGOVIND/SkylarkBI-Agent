# Deploying the hosted prototype

The application is complete and builds cleanly. Deployment needs three
credentials that must come from you — they cannot be provisioned from source.

## What you need

1. **monday.com API token** — monday.com → avatar → *Developers* → *My access tokens*
2. **Two board IDs** — create the boards first (below)
3. **An LLM API key** — one of:
   - **Google Gemini** (primary, free tier): https://aistudio.google.com/apikey — default model `gemini-2.5-flash`
   - **Groq** (free tier, but only 8k tokens/minute): https://console.groq.com/keys
   - **Anthropic** (paid): https://console.anthropic.com

   Only one is needed. The app requires the key for whichever provider you
   select, and never asks for the others.

## Step 1 — create the monday.com boards

```powershell
$env:MONDAY_API_TOKEN = "<your token>"

# Read-only: what exists and how much is already imported
npx tsx scripts/seed-monday.ts --inspect

# Create or resume both boards
npx tsx scripts/seed-monday.ts
```

It prints both board IDs on completion.

The import is **resumable**: monday.com rate-limits aggressively, so a run may
stop partway. Re-running the same command reuses the existing boards and
inserts only the rows that are genuinely missing — matched by content, not by
position — so duplicate boards and duplicate rows cannot occur. Run
`--inspect` any time for a read-only progress report, and `--only deals` /
`--only work-orders` to import one board at a time.

## Step 2 — verify locally

```bash
cp .env.example .env.local     # fill in the four required values
npm run check:monday           # confirms token, board access, column resolution
npm run dev                    # http://localhost:3000
```

`npm run check:monday` is the fastest way to catch a wrong board ID or a token
that cannot see a board.

Then verify the model end to end against the live boards:

```powershell
npm run smoke:llm
```

### If Gemini returns a 404 on the model

Model availability varies by API key, project and region, so the fix is to ask
Google what your key can reach rather than trying another name:

```powershell
npm run gemini:models              # list models available to this key
npm run gemini:models -- --verify  # also prove tool calling works
```

It prints a recommended model and the exact `GEMINI_MODEL=` line to set. The
key is sent in a header, never in a URL, and is never printed.

### Verifying the provider

First confirm the key, model and endpoint work — one minimal request:

```powershell
npm run smoke:llm -- --probe
```

Then validate the real integration with a single scenario (~7-10k tokens):

```powershell
npm run smoke:llm -- --quick
```

Then the full six scenarios:

```powershell
npm run smoke:llm
```

Pacing between scenarios adapts to the provider: 8s by default, but 65s on
Groq, whose free tier allows only 8,000 tokens per minute (one scenario costs
~7-10k, so back-to-back runs will 429 there). Override with `--gap <seconds>`.
Gemini's free tier is substantially more generous; check your live limits at
https://aistudio.google.com/rate-limit

## Step 3 — deploy

```bash
npm i -g vercel
vercel login
vercel --prod
```

Then add the environment variables:

```bash
vercel env add MONDAY_API_TOKEN production
vercel env add MONDAY_DEALS_BOARD_ID production
vercel env add MONDAY_WORK_ORDERS_BOARD_ID production

# Then ONE provider:
vercel env add LLM_PROVIDER production      # value: gemini
vercel env add GEMINI_API_KEY production
# ...or LLM_PROVIDER=groq + GROQ_API_KEY
# ...or LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY

vercel --prod          # redeploy so the new vars take effect
```

## Step 4 — confirm

Open `https://<your-deployment>/api/health`. A healthy deployment returns
`"status": "ok"` with record counts for both boards, an empty
`unresolvedColumns` list, and the `llm` provider/model in use.

If it returns `not_configured`, the listed variables are missing. If it returns
`error`, the message states exactly what monday.com rejected.

## Notes

- A **read-only** monday.com token is sufficient for running the app, and is
  recommended. Write scope is only needed once, for the seeding step.
- The app requires a server runtime. It cannot be exported as a static site —
  that would place secrets in the browser.
