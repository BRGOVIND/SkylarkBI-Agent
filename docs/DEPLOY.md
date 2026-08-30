# Deploying the hosted prototype

The application is complete and builds cleanly. Deployment needs three
credentials that must come from you — they cannot be provisioned from source.

## What you need

1. **monday.com API token** — monday.com → avatar → *Developers* → *My access tokens*
2. **Two board IDs** — create the boards first (below)
3. **Anthropic API key** — https://console.anthropic.com

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
vercel env add ANTHROPIC_API_KEY production
vercel --prod          # redeploy so the new vars take effect
```

## Step 4 — confirm

Open `https://<your-deployment>/api/health`. A healthy deployment returns
`"status": "ok"` with record counts for both boards and an empty
`unresolvedColumns` list.

If it returns `not_configured`, the listed variables are missing. If it returns
`error`, the message states exactly what monday.com rejected.

## Notes

- A **read-only** monday.com token is sufficient for running the app, and is
  recommended. Write scope is only needed once, for the seeding step.
- The app requires a server runtime. It cannot be exported as a static site —
  that would place secrets in the browser.
