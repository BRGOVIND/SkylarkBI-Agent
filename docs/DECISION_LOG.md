# Decision Log — Skylark BI Agent

## 1. What I optimised for

The assignment tests whether an agent can be **trusted with real business data**, not whether it can chat. The data is deliberately incomplete: only 57 of 134 open deals carry a value. An agent that answers "₹73.9 Cr pipeline" is confidently wrong; one that answers "₹73.9 Cr across 57 of 134 open deals — 77 have no value recorded" is useful. Every significant decision below follows from that.

## 2. Architecture and stack

**Next.js 15 + TypeScript on Vercel.** One deployable serving both the chat UI and the server-side API, so credentials never reach the browser and there is no CORS or second service to operate. Vercel gives zero-config Next.js deploys and first-class environment variables — the fastest reliable route to a hosted prototype. TypeScript because the value of this system is in typed, testable domain logic.

**The critical boundary: the LLM never does arithmetic.** All calculation lives in pure TypeScript (`src/lib/analytics`). The model interprets the question, selects tools, and writes the narrative. Tools return compact pre-aggregated structures — never raw record dumps — so the model cannot re-derive numbers, and context stays small and cheap. This removes an entire class of plausible-but-wrong answers.

**Layering:** monday.com client → normalisation → analytics → tools → agent → UI. Normalisation is the only layer that knows the data is messy; analytics can assume clean typed records.

## 3. Monday.com integration: API, not MCP

I used the **GraphQL API v2 directly**. MCP would have meant running an MCP client inside a serverless function — an extra process, extra latency, and a failure mode I could not control — to wrap what is fundamentally one authenticated POST. Direct API access gave me exact control over pagination, retry/backoff, timeouts, and error classification, which is where reliability actually comes from here.

**Read-only is enforced in code, not by convention.** `MondayClient.query` rejects any operation containing `mutation`. No runtime path — however the model is prompted — can write to monday.com. There is a separate `unsafeMutate` used *only* by the offline seed script, which is not part of the deployed app. This is covered by tests.

**Columns are resolved at runtime by title**, matched against alias lists rather than hardcoded column IDs. Boards can be rebuilt, renamed or reordered and the agent keeps working; unresolvable columns are reported so a metric degrades honestly instead of silently returning zero.

## 4. Data normalisation strategy

Built from an actual profile of the two spreadsheets, which revealed: header rows repeated *inside* the data (2 in Deals), 12 exact duplicate rows, ~52% of deal values missing, ~75% of closure probabilities missing, stage labels that are mostly ordered (`A.`–`O.`) but not always (`Project Completed`), and quantities stored with unit suffixes (`5360 HA`).

Principles applied:

- **Missing ≠ malformed.** A blank cell and `"ask finance"` are tracked separately. Every parser returns the value *and* whether the input was present-but-unparseable.
- **Nothing is silently fixed.** Rows dropped as duplicates or header echoes are counted and reported. Unrecognised sectors are kept and Title-Cased rather than folded into "Others", which would distort sector analysis.
- **Coverage travels with every total.** Aggregates return `{matched, counted, excluded}`. The agent is required by its system prompt to disclose material gaps.
- **Records are never discarded for incompleteness** — only excluded from the specific metrics they cannot support.

## 5. Key assumptions

| Assumption | Why | Exposure |
|---|---|---|
| Probability High/Medium/Low = **0.8 / 0.5 / 0.2** | Board stores a label, not a percentage; a weighted pipeline needs numbers | Labelled as an assumption on every weighted figure |
| "This quarter" = **Indian financial quarter** (Apr–Mar) | Indian business | Stated in every answer; calendar quarters available and offered |
| Ambiguous `DD/MM/YYYY` read **day-first** | Indian convention | Source data is ISO, so this is a safety net |
| Cross-board join on **masked deal name** | The boards use *different customer code spaces* (`COMPANY089` vs `WOCOMPANY_002`) — there is no shared customer key | Agent states the join basis whenever an account answer depends on it |
| "Revenue" is ambiguous | Board distinguishes order book / billed / collected | Agent names which it is reporting and notes the others |

The deal-name join is the most assumption-laden step in the system: 52 of ~58 work-order names match the Deals board, but deal names are not unique there, so an "account" can over-group. I chose to surface this rather than present a cleaner-looking but less honest join.

## 6. Trade-offs

**Full board fetch + short server-side cache, not per-query filtering.** monday.com's API cannot express these aggregations, and the boards are small (332 deals, 176 work orders). Fetching once per 5 minutes and computing in memory is simpler, faster across a multi-tool turn, and avoids exhausting the API budget. It costs snapshot freshness — so snapshot age travels with every tool result.

**Stale data over no data.** If monday.com becomes unreachable and a cached snapshot exists, it is served with its age attached, rather than failing the conversation. A hard failure would be more "correct" and less useful.

**Text columns, not monday.com status columns**, when seeding. Status columns cap distinct labels and silently reject unknown values — they would have destroyed exactly the messiness the agent is meant to handle.

**Answer with a stated assumption rather than interrogate.** The agent asks at most one clarifying question, and only when readings differ materially. A founder would rather have an answer with its assumption named than a question back.

**Depth over breadth in tests.** 105 tests concentrated on wrong-answer paths — parsing, coverage accounting, API failure modes, and a full end-to-end run against the real spreadsheets — rather than broad coverage of glue code.

## 7. How I interpreted "leadership updates"

As **preparing the data layer of a leadership update, not writing the prose**. The hard, error-prone part of a board update is assembling consistent, correctly-scoped, caveat-aware figures from messy sources — not the wording.

`generate_leadership_update` returns, in one deterministic call: headline pipeline and revenue figures, sector performance, top open deals by value, operational status, risks ranked by severity and exposure, key cross-board accounts, and consolidated data-quality caveats. The model writes the narrative *from that structure*.

This means the update is reproducible, every number is traceable to a computation rather than a generation, and the caveats are attached rather than remembered. A founder can paste it into a board deck; the figures will not have drifted between two askings.

## 8. What I would do differently with more time

- **A shared account identity.** The strongest structural improvement would be a reconciliation table mapping `COMPANY*` to `WOCOMPANY_*` codes, replacing the name-based join and its over-grouping risk.
- **Trend and movement analysis.** Everything is currently a point-in-time snapshot. Period-over-period movement ("pipeline up ₹4 Cr on last quarter, driven by Railways") is what a founder actually acts on, and needs either board snapshots over time or monday.com activity logs.
- **Streaming token-level output.** The response currently streams per content block; token streaming would make long answers feel materially faster.
- **An eval suite over the agent layer.** I tested the deterministic layers hard, but agent behaviour — tool selection, clarification, caveat disclosure — is verified by manual scenario testing. A scored eval set would catch regressions in prompt changes.
- **Per-user monday.com OAuth** instead of a single service token, so board access follows the viewer's own permissions.
- **Configurable risk thresholds** surfaced in the UI, rather than fixed rules.

## 9. Known limitations

- Cross-board joins may over-group accounts sharing a deal name (§5).
- Weighted pipeline rests on assumed probability weights.
- Risk detection is rule-based, not predictive, and depends on date hygiene — records with missing dates cannot be flagged and may hide real risk.
- Sector coverage differs between boards by construction: DSP, Tender, Aviation and Manufacturing appear only in Deals, so those sectors show pipeline with no delivery data.
- The cache can serve data up to its TTL old, and deliberately older if monday.com is down.
- Agent quality depends on an external LLM API; if it is unreachable the app reports the failure rather than degrading to a non-conversational mode.
- No authentication on the hosted prototype — appropriate for an evaluation deployment, not for real business data.
