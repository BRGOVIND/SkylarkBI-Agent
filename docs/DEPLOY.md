# Deploying Skylark BI Agent

A step-by-step guide, written for someone deploying this for the first time.

**Never put a real key or token in this file, in the repository, in a commit,
in a screenshot, or in a chat message.** Everywhere below, `<ANGLE_BRACKETS>`
means "paste your own value here, in the hosting dashboard only".

---

## 1. What you need before starting

| Thing | Where it comes from | Secret? |
|---|---|---|
| Gemini API key | Google AI Studio | **Yes** |
| monday.com API token | monday.com developer area | **Yes** |
| Two board IDs | the monday.com board URLs | No |
| A Vercel account | vercel.com | — |

---

## 2. Get a Gemini API key

1. Open **Google AI Studio** and go to the API keys page: <https://aistudio.google.com/apikey>
2. Sign in with the Google account you want to bill/limit against.
3. Choose **Create API key** and select a Google Cloud project (a new one is fine).
4. **Copy the key once and store it in a password manager.** Google will not
   show it again in full.

Rules:

- Add it to Vercel as `GEMINI_API_KEY`.
- Never commit it.
- **Never** name it `NEXT_PUBLIC_GEMINI_API_KEY` — anything prefixed
  `NEXT_PUBLIC_` is compiled into the browser bundle and is readable by anyone.
- **The key used during earlier development is compromised and must not be
  reused.** Create a fresh one and delete the old key in AI Studio.

To confirm which models your key can actually use:

```bash
GEMINI_API_KEY=<YOUR_GEMINI_API_KEY> npm run gemini:models -- --verify
```

It prints the models available to that key and proves tool calling works. Use
the model id it recommends as `GEMINI_MODEL`.

---

## 3. Get a monday.com API token

1. Sign in to monday.com **as a user who can see both Skylark boards**.
2. Click your avatar (bottom-left) → **Developers** → **My access tokens**.
3. Copy the personal API token.

The token must be able to **read**:

- `Skylark — Deals`
- `Skylark — Work Orders`

The agent only ever reads. A read-only token is sufficient and recommended —
the application refuses to send any GraphQL mutation.

Add it as `MONDAY_API_TOKEN`. Never commit it, never use `NEXT_PUBLIC_`.

---

## 4. Find the board IDs

Open each board in monday.com and read the URL:

```
https://<your-account>.monday.com/boards/5030964935
                                         ^^^^^^^^^^ this is the board ID
```

For this project they are:

```
MONDAY_DEALS_BOARD_ID=5030964935
MONDAY_WORK_ORDERS_BOARD_ID=5030965269
```

Board IDs are not secret.

---

## 5. Environment variables

| Variable | Required | Secret | Example |
|---|---|---|---|
| `LLM_PROVIDER` | yes | no | `gemini` |
| `GEMINI_API_KEY` | yes (for Gemini) | **yes** | `<YOUR_GEMINI_API_KEY>` |
| `GEMINI_MODEL` | no | no | `gemini-3.5-flash` |
| `MONDAY_API_TOKEN` | yes | **yes** | `<YOUR_MONDAY_API_TOKEN>` |
| `MONDAY_DEALS_BOARD_ID` | yes | no | `5030964935` |
| `MONDAY_WORK_ORDERS_BOARD_ID` | yes | no | `5030965269` |
| `DATA_CACHE_TTL_SECONDS` | no | no | `300` |

Only the **selected** provider's key is required. With `LLM_PROVIDER=gemini`
the app never asks for a Groq or Anthropic key. To use a different provider,
set `LLM_PROVIDER=groq` + `GROQ_API_KEY`, or `LLM_PROVIDER=anthropic` +
`ANTHROPIC_API_KEY`.

Every one of these is read **server-side only**. None may ever be prefixed
`NEXT_PUBLIC_`.

---

## 6. Run it locally first

```bash
npm install
cp .env.example .env.local     # then fill in your values
npm run check:monday           # verifies the token, board access, columns
npm run dev                    # http://localhost:3000
```

`.env.local` is gitignored. Never commit it.

---

## 7. Deploy to Vercel

### Connect the project

1. Push the repository to GitHub.
2. In Vercel: **Add New → Project**, import the repository.
3. The Next.js preset is detected automatically. Leave the build command and
   output directory at their defaults.

### Add the environment variables

**Vercel Dashboard → your project → Settings → Environment Variables**

Add each of these with the **Production** scope (also tick Preview if you want
preview deployments to work):

```
LLM_PROVIDER                 gemini
GEMINI_MODEL                 gemini-3.5-flash
GEMINI_API_KEY               <YOUR_GEMINI_API_KEY>
MONDAY_API_TOKEN             <YOUR_MONDAY_API_TOKEN>
MONDAY_DEALS_BOARD_ID        5030964935
MONDAY_WORK_ORDERS_BOARD_ID  5030965269
```

Mark the two keys as sensitive so they are write-only in the dashboard.

### Deploy

Either push to your default branch, or from the CLI:

```bash
npm i -g vercel
vercel login
vercel --prod
```

### After changing any environment variable — redeploy

Vercel bakes environment variables into a deployment at build time. **Editing a
variable does not change an existing deployment.** You must redeploy:

**Deployments → ⋯ on the latest → Redeploy**, or push a commit, or `vercel --prod`.

This is the single most common cause of "I set the key but it still says not
connected".

---

## 8. Verify the deployment

### Health check

Open `https://<your-deployment>/api/health`.

Healthy:

```json
{
  "status": "ok",
  "monday": "connected",
  "llm": { "provider": "gemini", "model": "gemini-3.5-flash" },
  "boards": {
    "deals":      { "usableRecords": 333, "unresolvedColumns": [] },
    "workOrders": { "usableRecords": 177, "unresolvedColumns": [] }
  }
}
```

The endpoint reports the **names** of missing settings and record counts. It
never returns a key or token value.

| Response | Meaning | Fix |
|---|---|---|
| `"status": "not_configured"` | A variable is missing | Add it, then **redeploy** |
| `"status": "error"` + 401/403 | Token rejected | Check `MONDAY_API_TOKEN` |
| `"status": "error"` + board not found | Wrong board ID, or the token's user cannot see the board | Check IDs; add the user to the board |
| `unresolvedColumns` not empty | A board column was renamed | See "Board configuration" in the README |

### Smoke test the agent

```bash
npm run smoke:llm -- --probe    # cheapest: confirms key, model, endpoint
npm run smoke:llm -- --quick    # one real founder question end to end
npm run smoke:llm               # all six scenarios
```

### Check in the browser

Open the deployment. You should see the opening animation, the hero, and — in
the workspace header — a **Connected** status with live record counts. Then ask:

> How is our pipeline looking?

Open DevTools → Network and confirm no request or response contains a key or
token. All provider calls happen server-side.

---

## 9. Common problems

| Symptom | Cause | Fix |
|---|---|---|
| "Skylark is not connected to its business data yet" | A required variable is missing, or you did not redeploy | Add the variable, then redeploy |
| Still not connected after adding variables | Environment variables only apply to **new** deployments | Redeploy |
| Gemini 404 on the model | That model id is not available to your key | `npm run gemini:models -- --verify`, then set `GEMINI_MODEL` |
| Gemini 429 | Free-tier quota | Wait for the window, or raise the quota |
| Request times out around 60s | A complex question exceeded `maxDuration` | See "Request timeout" below |
| Board not found | The token's user is not a subscriber of the board | Add them to the board in monday.com |
| **Local dev looks unstyled or broken** | A stale Turbopack cache plus a stale browser copy of the dev stylesheet — dev chunk filenames are not content-hashed, so the browser reuses an old one | Stop dev, `rm -rf .next`, restart, then hard-reload (Ctrl+Shift+R). **Production is unaffected** — its assets are content-hashed. |

### Request timeout

A complex question can take **18–80 seconds**. `maxDuration` is set to **60s**
in both `vercel.json` and `src/app/api/chat/route.ts`, because 60s is the
maximum on Vercel's Hobby plan.

To allow longer answers on Pro/Fluid compute, change **both** to `300` and
redeploy. Do not set a value above your plan's limit or the deployment is
rejected.

---

## 10. Rotating a compromised key

Assume a key is compromised if it has ever been pasted into a chat, a commit, a
screenshot, a log, or a shared document.

**Gemini**

1. Create a new key in AI Studio.
2. Update `GEMINI_API_KEY` in Vercel.
3. **Redeploy.**
4. Confirm `/api/health` returns `ok`.
5. **Delete the old key in AI Studio** — rotation is not complete until the old
   key stops working.

**monday.com**

1. In monday.com → Developers → My access tokens, regenerate the token.
2. Update `MONDAY_API_TOKEN` in Vercel, redeploy, verify `/api/health`.
3. Regenerating invalidates the old token automatically.

If a secret was ever committed, rotating it is mandatory — rewriting git history
alone does not make the exposed value safe.

---

## 11. Continuing development safely

Working on this repository, with or without an AI coding assistant:

1. Clone the repository and run `npm install`.
2. Read `README.md`, then this file.
3. Run `git status` before changing anything, so you know your starting point.
4. Keep secrets in `.env.local`. It is gitignored — never commit it.
5. Run `npm test` before touching anything in the protected areas below.
6. Run `npm run typecheck` and `npm run build` before deploying.
7. Review `git diff` before committing.

### Using an AI coding assistant

- Open the repository folder in the assistant and paste your task description
  into its session.
- **Never paste an API key or token into a prompt.** Refer to the variable name
  (`GEMINI_API_KEY`) instead of its value.
- When the assistant needs a file, give it the repository path rather than
  pasting contents that might contain secrets.
- Ask it to inspect the code before modifying it, and to run the test suite and
  show you a diff before you commit.
- State explicitly that these areas must not change without a demonstrated bug,
  because the correctness of every reported figure depends on them:

  ```
  src/lib/agent/run.ts        agent loop and tool orchestration
  src/lib/agent/tools.ts      the nine BI tools
  src/lib/agent/prompt.ts     grounding and caveat rules
  src/lib/analytics/          all arithmetic, coverage, date handling
  src/lib/normalize/          missing vs malformed, dedupe, data quality
  src/lib/monday/             read-only monday.com access
  src/lib/agent/providers/    provider adapters, incl. Gemini thought signatures
  ```

  In particular: arithmetic must never move into the language model, missing
  values must never be treated as zero, and coverage must always travel with a
  total.
