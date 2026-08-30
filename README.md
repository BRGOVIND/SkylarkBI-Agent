# Skylark BI Agent

A conversational business intelligence agent that answers founder-level questions over two live monday.com boards — **Deals** (sales pipeline) and **Work Orders** (project execution, billing and collections).

Ask *"How is our pipeline looking this quarter?"* or *"Which customers have both active work and open opportunities?"* and get a grounded answer with the numbers, the reasoning, and — importantly — the data-quality caveats that make the numbers honest.

---

## What makes this different from a chatbot over a spreadsheet

**The model never does arithmetic.** Every figure comes from deterministic TypeScript in `src/lib/analytics`. The LLM interprets the question, picks tools, and writes the narrative. It cannot invent, round, or "estimate" a number, because it never sees enough raw data to try.

**Every total carries its coverage.** The supplied data is genuinely incomplete — only 57 of 134 open deals have a value recorded. A naive agent reports "₹73.9 Cr pipeline". This one reports ₹73.9 Cr *across 57 of 134 open deals, with 77 excluded for having no value*. Missing is never silently treated as zero.

**Missing and malformed are tracked separately.** A blank cell and the string `"ask finance"` are different data problems, and both are reported as such.

**It knows when a period is empty because of data coverage.** If you ask about a quarter the boards do not cover, it tells you the date range the data actually spans instead of reporting a confident zero.

---

## Architecture

```
Browser (React chat UI)
   │  NDJSON stream — text + live tool-activity chips
   ▼
/api/chat  ─────────────────────────────  server-only; secrets never cross this line
   │
   ▼
Agent orchestrator  (src/lib/agent)
   │  Gemini, Groq or Anthropic behind one adapter. Interprets, selects tools,
   │  synthesises, clarifies. Never computes.
   ▼
Tool layer  (src/lib/agent/tools.ts)
   │  9 tools returning compact pre-aggregated structures, never raw dumps
   ▼
Analytics  (src/lib/analytics)      ← all arithmetic lives here, pure & deterministic
   │  pipeline · sector · operational · risk · cross-board · leadership pack
   ▼
Normalisation  (src/lib/normalize)  ← the messy-data layer
   │  dates · numbers · sectors · stages · statuses · dedupe · header-echo removal
   │  emits a DataQualityReport alongside every dataset
   ▼
monday.com data layer  (src/lib/monday)
   │  GraphQL v2 · cursor pagination · retry/backoff · runtime column resolution
   ▼
monday.com API  (READ ONLY)
```

### Why these boundaries

| Boundary | Reason |
|---|---|
| LLM ↔ analytics | Language models are unreliable at arithmetic over many records. Splitting interpretation from calculation removes a whole class of confidently-wrong answers. |
| Normalisation ↔ analytics | Analytics can assume clean, typed records. All the mess is handled once, in one place, and reported. |
| Data layer ↔ everything | Column titles are resolved at runtime against alias lists, so the app survives boards being rebuilt or renamed. |
| Agent ↔ vendor | The only thing needed from a model vendor is tool calling, so it sits behind a small adapter and can be swapped with an env var. |

---

## LLM provider

The agent needs exactly one thing from a model vendor: **multi-turn tool calling**. It uses no structured-output mode, no vendor streaming, no prompt caching and no other vendor-specific feature, so the vendor sits behind a small adapter (`src/lib/agent/provider.ts`) and the BI layer is unaware of which one is answering.

| | Gemini (primary) | Groq | Anthropic |
|---|---|---|---|
| Model | `gemini-2.5-flash` | `openai/gpt-oss-120b` | `claude-sonnet-4-5` |
| Cost | Free tier | Free tier | Paid |
| Tool calling | Yes | Yes | Yes |
| Integration | OpenAI-compat endpoint | Native | Official SDK |

Selecting one is two environment variables — no code change:

```bash
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
```

**Only the selected provider's key is required.** If `LLM_PROVIDER` is omitted,
the first key present is used, in the order gemini -> groq -> anthropic.

### Why Gemini uses the OpenAI-compatibility endpoint

Google offers both a native SDK (`@google/genai`) and an OpenAI-compatible
endpoint. This adapter uses the latter, for one specific reason: the **native
Gemini API pairs a function response to its call by function *name*** —
`functionCall`/`functionResponse` parts carry no call id. This agent's neutral
interface pairs by id, which is what keeps two parallel calls to the *same*
tool (two sector queries with different filters, say) unambiguous. Adapting the
native shape would mean synthesising ids and re-associating them by name and
position — a correctness risk exactly where a BI agent can least afford one.

The compatibility endpoint speaks the same `tool_calls` / `tool_call_id`
dialect the neutral interface already models, needs no new dependency, and
shares its translation code with the Groq adapter (`providers/openai-wire.ts`).
It is documented as beta; because it sits behind the adapter, switching to the
native SDK later would touch one file.

### Token footprint

Every request re-sends the system prompt (~1,075 tokens) plus all nine tool
schemas (~1,759), so each carries a **~2,834-token base**. One question costs
two requests, so roughly **7,000–10,000 tokens**.

That is comfortable on Gemini, and tight on Groq's 8,000 tokens/minute free
tier. The base is not padding — the tool schemas are what let the model pick
the right tool, and trimming them would trade correctness for tokens. No
second routing call is used: one model turn selects the tool directly, which is
cheaper than a router plus an executor.

Check your live limits with `npm run smoke:llm -- --probe` (one minimal request).

### Choosing a Gemini model

Gemini model availability differs by API key, project and region — an id listed
in Google's public docs is not guaranteed to resolve for a given key, and a
missing one surfaces as a 404. To find what a key can actually use:

```bash
npm run gemini:models              # list, with context sizes and chat support
npm run gemini:models -- --verify  # also make one real tool-calling request
```

It ranks candidates for this agent (Flash-class preferred: Pro has tighter free
-tier quotas, Lite gives up the instruction following the caveat rules rely on),
prints the exact `GEMINI_MODEL=` line to set, and can prove tool calling works
against the real adapter before you change anything. The key travels in a
header, never a URL, and is never printed.

Switching is two environment variables — no code change:

```bash
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...
```

Adding a third vendor means writing one adapter with a single `complete()` method; nothing in the tools, analytics or prompt layer changes.

## Features

- **Conversational BI** over both boards, with multi-turn context
- **Cross-board analysis** — joins pipeline to delivery per account
- **Pipeline metrics** — open/won/lost, weighted pipeline, win rate, stage breakdown
- **Sector analysis** — pipeline value, win rate, order book and billing per sector
- **Operational metrics** — execution status, order book, billed, collected, receivables
- **Risk detection** — overdue work orders, stalled deals, stuck invoicing, priority receivables
- **Leadership update** — one-call briefing pack (see below)
- **Data-quality reporting** — per-field completeness, dropped rows, unresolved columns
- **Graceful degradation** — stale-cache fallback when monday.com is unreachable, actionable errors otherwise
- **Live tool transparency** — the UI shows which data tools ran for each answer

### The "leadership updates" feature

Interpreted as: *prepare the data layer of a leadership update, not the prose*. `generate_leadership_update` assembles headline pipeline and revenue figures, sector performance, top open deals, operational status, ranked risks, key accounts and consolidated data-quality caveats in a single deterministic call. The model then writes the briefing from that structure. Rationale is in the Decision Log.

---

## Setup

### Prerequisites

- Node.js 20+
- A monday.com account
- An LLM API key: **Google Gemini** (free tier, primary), Groq, or Anthropic

### 1. Install

```bash
npm install
```

### 2. Configure monday.com

**Get an API token** — monday.com → your avatar → *Developers* → *My access tokens*. A **read-only** token is sufficient and recommended for running the app. (Board creation via the seed script needs write scope; see below.)

**Create the boards.** Either import the two spreadsheets through monday.com's UI, or use the included script:

```bash
# Column-type plan only — no network, no token
npx tsx scripts/seed-monday.ts --dry-run

# Read-only status: which boards exist and how many rows are already imported
npx tsx scripts/seed-monday.ts --inspect

# Create or resume both boards (needs a write-scoped token)
npx tsx scripts/seed-monday.ts
```

The script prints the two board IDs when it finishes. It uploads the data **verbatim** — blanks, duplicates and all — because cleaning it at import would defeat the point of the exercise.

**It is resumable and idempotent.** monday.com rate-limits aggressively and a 346-row import will usually be interrupted at least once. Re-running the same command is always safe:

- **Boards are reused, never duplicated** — resolved by explicit `--deals-board` / `--work-orders-board` id, then the environment, then an exact board-name match, and only created if none of those find one. Missing columns are added to an existing board; existing ones are reused.
- **Already-imported rows are detected by content**, not by position. Each row is fingerprinted from its item name plus every canonicalised column value, and source rows are matched against board items as a *multiset*. So if the sheet holds three identical rows and the board holds one, exactly two are still pending — the 12 genuine duplicate rows in the source data survive a resume intact.
- **Rate limits are absorbed** — the seeder honours monday.com's `Retry-After` header and the "retry in N seconds" text inside complexity errors, backs off exponentially up to 75s, retries a bounded 8 times, and adaptively widens the spacing between mutations so a long import settles at the fastest rate the API will tolerate.
- **It refuses to write into a board it cannot account for.** If any board row matches no source row, the script stops and reports those rows rather than risking duplicates. Override with `--allow-unmatched` once you have checked them.

Useful flags: `--only deals` / `--only work-orders` to do one board at a time, `--delay <ms>` to set the base spacing between mutations (default 400).

> The seed script is manual setup tooling. It is not part of the deployed app and is unreachable from it. The running agent uses `MondayClient.query`, which **refuses any GraphQL mutation outright**.

**Find board IDs manually** from the board URL: `monday.com/boards/`**`1234567890`**

### 3. Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Required | Description |
|---|---|---|
| `MONDAY_API_TOKEN` | yes | monday.com personal API token. Read-only is sufficient. |
| `MONDAY_DEALS_BOARD_ID` | yes | Numeric ID of the Deals board |
| `MONDAY_WORK_ORDERS_BOARD_ID` | yes | Numeric ID of the Work Orders board |
| `LLM_PROVIDER` | no | `gemini`, `groq` or `anthropic`. Inferred from whichever key is set. |
| `GEMINI_API_KEY` | if using Gemini | Google AI Studio key |
| `GEMINI_MODEL` | no | Defaults to `gemini-2.5-flash` |
| `GROQ_API_KEY` | if using Groq | Groq API key (free tier available) |
| `GROQ_MODEL` | no | Defaults to `openai/gpt-oss-120b` |
| `ANTHROPIC_API_KEY` | if using Anthropic | Anthropic API key |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-sonnet-4-5` |
| `MONDAY_API_VERSION` | no | Defaults to `2024-10` |
| `DATA_CACHE_TTL_SECONDS` | no | Board snapshot cache TTL, default `300` |
| `MONDAY_WORKSPACE_ID` | no | Seed script only — target workspace |

**Only the selected provider's key is required** — a Groq deployment never asks for an Anthropic key.

All are read **server-side only**. None is exposed to the browser.

### 4. Verify the connection

```bash
npm run check:monday
```

Prints record counts, dropped rows, per-field completeness and sanity metrics for both boards. Run this before deploying — it catches a wrong board ID or a token without board access immediately.

### 5. Run

```bash
npm run dev     # http://localhost:3000
```

`GET /api/health` reports setup and connection state without exposing any board content.

---

## Board configuration

Columns are resolved **at runtime by title**, matched against alias lists in `src/lib/monday/schema.ts` — first by exact normalised match, then by containment. Casing, spacing and punctuation differences do not matter.

This means:

- You can rename or reorder columns and the agent keeps working.
- Columns it cannot resolve are reported in `/api/health` and to the agent, which then says a metric is unavailable rather than returning a wrong one.
- To support a differently-named column, add an alias to the relevant list — no other code changes.

The boards created by the seed script use the source spreadsheet headers verbatim, which the default aliases already cover.

**Column types.** The seed script infers `date` / `numbers` / `text` per column from the data. Categorical columns are created as free **text**, not monday.com status columns, deliberately: status columns cap distinct labels and silently reject unknown values, which would destroy exactly the messiness the agent is meant to handle.

---

## Testing

```bash
npm test          # 242 tests
npm run typecheck
```

Coverage is concentrated on the parts that can produce a wrong business answer:

| Suite | What it protects |
|---|---|
| `tests/normalize.test.ts` | Date/number parsing across every format in the source data, null-sentinel handling, missing-vs-malformed, sector/stage/status canonicalisation, duplicate and header-echo removal, column resolution |
| `tests/analytics.test.ts` | Pipeline/sector/operational maths, coverage accounting, weighted pipeline, win-rate edge cases, risk rules, cross-board join, empty-period explanation, division-by-zero |
| `tests/monday.test.ts` | Mutation refusal, 401/429/5xx handling, retry policy, malformed JSON, network failure, pagination, missing board, empty board |
| `tests/gemini.test.ts` | Gemini request shape, tool-call decoding, parallel and same-tool calls, quota/404/auth errors, key never leaving the Authorization header, provider selection |
| `tests/gemini-agent.test.ts` | All six founder scenarios end to end through a real GeminiProvider with stubbed fetch: tool selection, deterministic figures reaching the model intact, coverage and caveat propagation, cross-board join |
| `tests/provider.test.ts` | Tool-schema translation to both vendor formats, message/tool-result encoding, argument parsing, Groq auth/rate-limit/network errors, provider selection |
| `tests/agent-loop.test.ts` | The full agent loop against real analytics with a scripted provider: tool selection, tool-result feedback, parallel calls, cross-board queries, caveat propagation, round cap |
| `tests/pipeline-fixture.test.ts` | **End-to-end against the real supplied spreadsheets** — every column resolves, zero malformed dates or values, sector totals reconcile with pipeline totals, duplicates and header rows removed |

The fixture suite reads the assignment's spreadsheets as a *test fixture only* — they are never bundled into the application, which reads monday.com exclusively. It skips itself if the files are absent. Point it elsewhere with `FIXTURE_DEALS` / `FIXTURE_WORK_ORDERS`.

---

## Deployment

Built for **Vercel** (zero-config for Next.js, first-class env vars, serverless API routes).

```bash
npm i -g vercel
vercel            # preview
vercel --prod     # production
```

Then set the four required environment variables in *Project → Settings → Environment Variables* and redeploy. Any Node host works — `npm run build && npm start` — but the app needs a **server runtime**; it cannot be exported as a static site, because that would put secrets in the browser.

After deploying, hit `/api/health` to confirm the boards are reachable.

---

## Example questions

| Question | Demonstrates |
|---|---|
| How is our pipeline looking this quarter? | Period handling, coverage disclosure |
| Which sectors are performing best? | Cross-board sector comparison |
| What's our pipeline exposure to the energy sector? | Clarification — "energy" isn't a sector in this data |
| What is our expected revenue? | Distinguishes order book / billed / collected |
| Which customers have both active work and pipeline opportunities? | Cross-board join |
| What operational risks should leadership know about? | Rule-based risk detection |
| Give me a leadership update. | Full briefing pack |
| How reliable is this data? | Data-quality reporting |

---

## Security

- **Read-only by construction.** `MondayClient.query` rejects any operation containing `mutation`, so no runtime code path — however prompted — can modify monday.com. Enforced in code and covered by tests, not just by convention.
- **Secrets stay server-side.** All env access happens in server components and API routes. Nothing reaches the client bundle. `.env*` is gitignored.
- **Input validation** on `/api/chat`: role/type checks, message-count and per-message length caps.
- **No secret leakage in errors.** Failures report *what* went wrong and what to check, never token values.
- **`/api/health` exposes only counts and setup state** — never board content.
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`.
- **Bounded work per turn** — page cap on fetches, max tool rounds per conversation turn.
- Board data is treated as untrusted input and is never interpolated into executable context.

---

## Known limitations

- **Cross-board joins go through the masked deal name.** The two boards use different customer code spaces (`COMPANY089` vs `WOCOMPANY_002`), so no shared customer key exists. Deal names are not unique on the Deals board, so an "account" may over-group. The agent states this whenever it matters.
- **Probability weights are assumed** (High/Medium/Low = 0.8/0.5/0.2). The board stores a label, not a percentage. Every weighted figure is labelled as assumption-based.
- **"This quarter" defaults to the Indian financial year** (Apr–Mar). The calendar reading is available and offered.
- **Ambiguous numeric dates are read day-first** (DD/MM/YYYY), matching Indian convention. The source data is ISO-formatted, so this path is a safety net rather than a live risk.
- **Sector coverage differs between boards.** Deals carry sectors the Work Orders board never uses (DSP, Tender, Aviation, Manufacturing), so some sectors have pipeline but no delivery data by construction.
- **The cache can serve stale data** for up to `DATA_CACHE_TTL_SECONDS`, and deliberately serves a stale snapshot if monday.com becomes unreachable. Snapshot age travels with every tool result.
- **Risk detection is rule-based**, not predictive, and depends on date fields being maintained. Records with missing dates cannot be flagged and may hide real risk.
