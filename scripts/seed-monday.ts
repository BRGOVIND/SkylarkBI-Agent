/**
 * One-time setup script: imports the supplied spreadsheets into monday.com.
 *
 * This is SETUP tooling, run manually from a terminal. It is not part of the
 * deployed application and is unreachable from it — the running agent uses
 * `MondayClient.query`, which refuses mutations outright. Mutations are allowed
 * here, and only here.
 *
 * The data is uploaded VERBATIM, including blanks, duplicate rows and the
 * repeated header rows present in the source files. The assignment's data is
 * meant to be messy, and cleaning it at import would move the problem out of
 * the agent, which is exactly what is being evaluated.
 *
 * RESUMABLE AND IDEMPOTENT. monday.com rate-limits aggressively, so a large
 * import will be interrupted. Re-running reuses the existing boards and inserts
 * only the rows that are actually missing — see `reconcile()` for how already
 * inserted rows are identified without relying on row position.
 *
 * Usage:
 *   npx tsx scripts/seed-monday.ts --inspect          # read-only status report
 *   npx tsx scripts/seed-monday.ts --dry-run          # column plan, no network
 *   npx tsx scripts/seed-monday.ts                    # create/resume both boards
 *   npx tsx scripts/seed-monday.ts --only deals       # one board at a time
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as XLSX from 'xlsx';
import { MondayClient, MondayApiError } from '../src/lib/monday/client';
import { fetchBoard, type RawBoard } from '../src/lib/monday/fetch';

/* --------------------------------- CLI ----------------------------------- */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const DRY_RUN = has('dry-run');
const INSPECT = has('inspect');
const ALLOW_UNMATCHED = has('allow-unmatched');
const ONLY = arg('only');

const TOKEN = process.env.MONDAY_API_TOKEN?.trim();
const WORKSPACE_ID = process.env.MONDAY_WORKSPACE_ID?.trim();

const DEALS_PATH = arg('deals') ?? 'Deal funnel Data.xlsx';
const WO_PATH = arg('work-orders') ?? 'Work_Order_Tracker Data.xlsx';

/** Milliseconds between successive mutations, before adaptive widening. */
const BASE_DELAY_MS = Number(arg('delay') ?? 400);
const MAX_DELAY_MS = 15_000;

/* ------------------------------ spreadsheet ------------------------------ */

interface Sheet {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/**
 * Reads the first sheet, locating the header row rather than assuming row 0 —
 * the Work Order tracker has a title/blank row above its real header.
 */
function readSheet(file: string): Sheet {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${path.resolve(file)}`);
  const wb = XLSX.readFile(file, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, raw: false });

  let headerIdx = 0;
  let best = -1;
  for (let i = 0; i < Math.min(5, grid.length); i++) {
    const filled = (grid[i] ?? []).filter((c) => String(c ?? '').trim()).length;
    if (filled > best) {
      best = filled;
      headerIdx = i;
    }
  }

  const headers = (grid[headerIdx] ?? []).map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
  const rows: Array<Record<string, string>> = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (!row.some((c) => String(c ?? '').trim())) continue;
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      const v = row[i];
      rec[h] = v === undefined || v === null ? '' : String(v).trim();
    });
    rows.push(rec);
  }
  return { headers, rows };
}

/* --------------------------- column type mapping -------------------------- */

const DATE_HINT = /\bdate\b/i;
const NUMERIC_HINT = /amount|value|quantity|quantities|balance|probability\s*%|receivable/i;

type ColType = 'date' | 'numbers' | 'text';

function looksNumeric(values: string[]): boolean {
  const present = values.filter((v) => v !== '');
  if (present.length < 3) return false;
  const numeric = present.filter((v) => /^-?[\d,]*\.?\d+$/.test(v.replace(/\s/g, '')));
  return numeric.length / present.length > 0.8;
}

function looksDate(values: string[]): boolean {
  const present = values.filter((v) => v !== '');
  if (present.length < 3) return false;
  const dates = present.filter(
    (v) => /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(v),
  );
  return dates.length / present.length > 0.8;
}

/**
 * Chooses a monday.com column type per source column.
 *
 * Note on `text` vs `status`: monday.com status columns have a hard limit on
 * distinct labels and silently reject unknown values on write. Free-text
 * columns preserve the messy source values exactly, which is what we want —
 * the agent's normalisation layer interprets them.
 */
function pickType(header: string, values: string[]): ColType {
  if (DATE_HINT.test(header) && looksDate(values)) return 'date';
  if (looksDate(values)) return 'date';
  if ((NUMERIC_HINT.test(header) || looksNumeric(values)) && looksNumeric(values)) return 'numbers';
  return 'text';
}

function toDateValue(v: string): string | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (d) return `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`;
  return null;
}

/* ------------------------- canonical row projection ----------------------- */

/**
 * The value we intend monday.com to hold for a given source cell, expressed as
 * the string monday.com will hand back when read. Producing one canonical form
 * for both sides is what makes resume comparisons reliable: a date written as
 * "2025-07-31 00:00:00" reads back as "2025-07-31", and a number may round-trip
 * with different formatting.
 */
function canonicalCell(raw: string, type: ColType): string {
  const v = raw.trim();
  if (!v) return '';
  if (type === 'date') return toDateValue(v) ?? '';
  if (type === 'numbers') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? String(n) : '';
  }
  return v;
}

/** Board-side counterpart of `canonicalCell`, applied to what monday.com returns. */
function canonicalBoardCell(raw: string | null, type: ColType): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  if (type === 'date') return toDateValue(v) ?? '';
  if (type === 'numbers') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? String(n) : '';
  }
  return v;
}

/**
 * Item names must also be position-independent. The previous version of this
 * script named value-less rows "(unnamed 47)", baking the row index into the
 * board. Those names are folded back to a single canonical form so rows created
 * by the earlier run still reconcile.
 */
function canonicalName(raw: string): string {
  const v = raw.trim();
  if (!v) return '(unnamed)';
  return /^\(unnamed(\s+\d+)?\)$/i.test(v) ? '(unnamed)' : v;
}

/**
 * Content fingerprint of a row: the item name plus every mapped column value,
 * in a stable order. Two rows share a fingerprint exactly when they would
 * produce identical monday.com items — which is precisely when it is safe to
 * treat one as already representing the other.
 *
 * Deliberately content-derived, never position-derived, so a resume is correct
 * even if rows were inserted out of order or the sheet is re-read.
 */
function fingerprint(name: string, cells: Array<[string, string]>): string {
  const payload = JSON.stringify([canonicalName(name), [...cells].sort((a, b) => a[0].localeCompare(b[0]))]);
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

interface PlannedRow {
  name: string;
  /** header -> canonical value */
  cells: Map<string, string>;
  fp: string;
  source: Record<string, string>;
}

function planRows(sheet: Sheet, types: Map<string, ColType>): PlannedRow[] {
  const nameHeader = sheet.headers[0];
  return sheet.rows.map((row) => {
    const cells = new Map<string, string>();
    for (const [header, type] of types) {
      cells.set(header, canonicalCell(row[header] ?? '', type));
    }
    const name = canonicalName(row[nameHeader] ?? '');
    return { name, cells, fp: fingerprint(name, [...cells]), source: row };
  });
}

/* --------------------------- rate-limit throttle -------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Adaptive spacing between mutations. Widens hard on a rate-limit signal and
 * recovers slowly, so a long import settles near the fastest rate monday.com
 * will actually tolerate instead of repeatedly slamming into the limit.
 */
class Throttle {
  private delay: number;
  private streak = 0;
  rateLimitHits = 0;

  constructor(private readonly base: number, private readonly max: number) {
    this.delay = base;
  }

  get currentMs(): number {
    return Math.round(this.delay);
  }

  async pace(): Promise<void> {
    await sleep(this.delay);
  }

  onRateLimit(): void {
    this.rateLimitHits++;
    this.streak = 0;
    this.delay = Math.min(this.max, Math.max(this.base, this.delay) * 2);
  }

  onSuccess(): void {
    if (++this.streak >= 25 && this.delay > this.base) {
      this.delay = Math.max(this.base, this.delay * 0.8);
      this.streak = 0;
    }
  }
}

/* -------------------------------- monday --------------------------------- */

interface BoardHandle {
  id: string;
  name: string;
  /** header -> monday column id + type */
  columns: Map<string, { id: string; type: ColType }>;
}

async function findBoardByName(client: MondayClient, name: string): Promise<string | null> {
  const res = await client.query<{ boards: Array<{ id: string; name: string }> | null }>(
    `query { boards(limit: 200, state: active) { id name } }`,
  );
  const matches = (res.boards ?? []).filter((b) => b.name.trim() === name.trim());
  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} boards named "${name}" (ids ${matches.map((m) => m.id).join(', ')}). ` +
        `Pass the intended one explicitly with --deals-board / --work-orders-board to avoid writing to the wrong board.`,
    );
  }
  return matches[0]?.id ?? null;
}

/**
 * Resolves the target board without ever creating a second copy: an explicit
 * id wins, then the environment, then an exact name match, and only then is a
 * new board created.
 */
async function resolveBoard(
  client: MondayClient,
  opts: { explicitId?: string; envId?: string; name: string; sheet: Sheet; types: Map<string, ColType>; create: boolean },
): Promise<BoardHandle | null> {
  let boardId = opts.explicitId || opts.envId || null;
  let origin = opts.explicitId ? 'command line' : opts.envId ? 'environment' : '';

  if (!boardId) {
    boardId = await findBoardByName(client, opts.name);
    if (boardId) origin = 'existing board matched by name';
  }

  if (!boardId) {
    if (!opts.create) return null;
    console.log(`  no existing board named "${opts.name}" — creating it`);
    const created = await client.unsafeMutate<{ create_board: { id: string } }>(
      `mutation($name: String!, $ws: ID) {
         create_board(board_name: $name, board_kind: public, workspace_id: $ws) { id }
       }`,
      { name: opts.name, ws: WORKSPACE_ID ?? null },
    );
    boardId = created.create_board.id;
    console.log(`  created board (id ${boardId})`);
  } else {
    console.log(`  reusing board ${boardId} (${origin})`);
  }

  const existing = await client.query<{
    boards: Array<{ id: string; name: string; columns: Array<{ id: string; title: string; type: string }> }> | null;
  }>(`query($ids: [ID!]) { boards(ids: $ids) { id name columns { id title type } } }`, { ids: [boardId] });

  const board = existing.boards?.[0];
  if (!board) {
    throw new Error(
      `Board ${boardId} was not found or is not accessible with this token. ` +
        `Check the id and that the token's user is a subscriber of the board.`,
    );
  }

  const byTitle = new Map(board.columns.map((c) => [c.title.trim(), c]));
  const columns = new Map<string, { id: string; type: ColType }>();
  let created = 0;

  // The first sheet column becomes the item name, so it needs no board column.
  for (const header of opts.sheet.headers.slice(1)) {
    const type = opts.types.get(header) ?? 'text';
    const hit = byTitle.get(header.trim());
    if (hit) {
      columns.set(header, { id: hit.id, type });
      continue;
    }
    if (!opts.create) continue;
    const res = await client.unsafeMutate<{ create_column: { id: string } }>(
      `mutation($board: ID!, $title: String!, $type: ColumnType!) {
         create_column(board_id: $board, title: $title, column_type: $type) { id }
       }`,
      { board: boardId, title: header, type },
    );
    columns.set(header, { id: res.create_column.id, type });
    created++;
    await sleep(250);
  }

  console.log(
    `  columns: ${columns.size} mapped` + (created ? `, ${created} newly created` : ', none needed creating'),
  );
  return { id: boardId, name: board.name, columns };
}

/* ----------------------------- reconciliation ----------------------------- */

interface Reconciliation {
  boardItems: number;
  matched: number;
  pending: PlannedRow[];
  /** Board items that correspond to no remaining source row. */
  unmatched: Array<{ id: string; name: string }>;
}

/**
 * Determines what still needs inserting, by comparing content fingerprints as
 * MULTISETS rather than by position or by name.
 *
 * Multiset counting is what makes the 12 genuine duplicate rows in the source
 * data survive a resume: if the sheet holds three identical rows and the board
 * holds one, exactly two are still pending — not zero (which would lose data)
 * and not three (which would duplicate it).
 */
function reconcile(planned: PlannedRow[], board: RawBoard, columns: BoardHandle['columns']): Reconciliation {
  const boardCounts = new Map<string, string[]>();

  for (const item of board.items) {
    const cells: Array<[string, string]> = [];
    for (const [header, col] of columns) {
      cells.push([header, canonicalBoardCell(item.values[header] ?? null, col.type)]);
    }
    const fp = fingerprint(item.name, cells);
    const bucket = boardCounts.get(fp);
    if (bucket) bucket.push(item.id);
    else boardCounts.set(fp, [item.id]);
  }

  const remaining = new Map([...boardCounts].map(([fp, ids]) => [fp, ids.length]));
  const pending: PlannedRow[] = [];
  let matched = 0;

  for (const row of planned) {
    const left = remaining.get(row.fp) ?? 0;
    if (left > 0) {
      remaining.set(row.fp, left - 1);
      matched++;
    } else {
      pending.push(row);
    }
  }

  const unmatched: Array<{ id: string; name: string }> = [];
  for (const [fp, left] of remaining) {
    if (left <= 0) continue;
    const ids = boardCounts.get(fp) ?? [];
    for (const id of ids.slice(ids.length - left)) {
      const item = board.items.find((i) => i.id === id);
      unmatched.push({ id, name: item?.name ?? id });
    }
  }

  return { boardItems: board.items.length, matched, pending, unmatched };
}

/* ------------------------------- insertion -------------------------------- */

function buildColumnValues(row: PlannedRow, columns: BoardHandle['columns']): string {
  const out: Record<string, unknown> = {};
  for (const [header, col] of columns) {
    const value = row.cells.get(header) ?? '';
    if (!value) continue; // leave blanks genuinely blank
    if (col.type === 'date') out[col.id] = { date: value };
    else out[col.id] = value;
  }
  return JSON.stringify(out);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function insertRows(
  client: MondayClient,
  board: BoardHandle,
  rows: PlannedRow[],
  throttle: Throttle,
): Promise<{ inserted: number; failed: PlannedRow[] }> {
  const started = Date.now();
  let inserted = 0;
  const failed: PlannedRow[] = [];

  for (const [i, row] of rows.entries()) {
    try {
      await client.unsafeMutate(
        `mutation($board: ID!, $name: String!, $vals: JSON!) {
           create_item(board_id: $board, item_name: $name, column_values: $vals, create_labels_if_missing: true) { id }
         }`,
        { board: board.id, name: row.name, vals: buildColumnValues(row, board.columns) },
      );
      inserted++;
      throttle.onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push(row);
      console.log(`    ! row ${i + 1} ("${row.name}") failed: ${msg}`);
      // Retries are exhausted inside the client. Give up on a sustained limit
      // rather than hammering an API that is clearly refusing us.
      if (err instanceof MondayApiError && err.status === 429 && failed.length >= 5) {
        console.log('\n  Stopping early: monday.com is still rate limiting after repeated backoff.');
        console.log('  Nothing is lost — re-run the same command later to resume from here.');
        break;
      }
    }

    const done = i + 1;
    if (done % 20 === 0 || done === rows.length) {
      const elapsed = Date.now() - started;
      const eta = done ? (elapsed / done) * (rows.length - done) : 0;
      console.log(
        `    ${done}/${rows.length} (${Math.round((done / rows.length) * 100)}%)` +
          ` · inserted ${inserted}` +
          (failed.length ? ` · failed ${failed.length}` : '') +
          ` · ${throttle.currentMs}ms spacing` +
          ` · elapsed ${fmtDuration(elapsed)}` +
          (done < rows.length ? ` · eta ${fmtDuration(eta)}` : ''),
      );
    }
    await throttle.pace();
  }

  return { inserted, failed };
}

/* --------------------------------- flow ---------------------------------- */

interface Dataset {
  key: 'deals' | 'work-orders';
  label: string;
  boardName: string;
  sheet: Sheet;
  types: Map<string, ColType>;
  explicitId?: string;
  envId?: string;
  envVar: string;
}

function buildTypes(sheet: Sheet): Map<string, ColType> {
  const types = new Map<string, ColType>();
  for (const header of sheet.headers.slice(1)) {
    types.set(header, pickType(header, sheet.rows.map((r) => r[header] ?? '')));
  }
  return types;
}

async function processDataset(client: MondayClient, ds: Dataset, write: boolean): Promise<string | null> {
  console.log(`\n=== ${ds.label} ===`);
  const planned = planRows(ds.sheet, ds.types);

  const board = await resolveBoard(client, {
    explicitId: ds.explicitId,
    envId: ds.envId,
    name: ds.boardName,
    sheet: ds.sheet,
    types: ds.types,
    create: write,
  });

  if (!board) {
    console.log(`  board "${ds.boardName}" does not exist yet (nothing to inspect).`);
    return null;
  }

  const raw = await fetchBoard(client, board.id);
  const rec = reconcile(planned, raw, board.columns);

  console.log(`  source rows        ${planned.length}`);
  console.log(`  rows on board      ${rec.boardItems}`);
  console.log(`  already imported   ${rec.matched}`);
  console.log(`  still to import    ${rec.pending.length}`);
  if (rec.unmatched.length) {
    console.log(`  unrecognised rows  ${rec.unmatched.length}  <-- on the board but not in the sheet`);
    for (const u of rec.unmatched.slice(0, 5)) console.log(`      · ${u.name} (item ${u.id})`);
    if (rec.unmatched.length > 5) console.log(`      · …and ${rec.unmatched.length - 5} more`);
  }

  if (!write) return board.id;

  if (rec.pending.length === 0) {
    console.log('  nothing to do — this board is fully imported.');
    return board.id;
  }

  // A board row we cannot account for means our understanding of the board is
  // wrong; inserting on top of that is how duplicates get created.
  if (rec.unmatched.length && !ALLOW_UNMATCHED) {
    console.log(
      `\n  REFUSING TO WRITE. ${rec.unmatched.length} row(s) on the board do not correspond to any\n` +
        `  row in the spreadsheet, so the board's contents cannot be fully accounted for.\n` +
        `  Inspect them above. If they are expected, re-run with --allow-unmatched.`,
    );
    return board.id;
  }

  console.log(`  importing ${rec.pending.length} rows at ${BASE_DELAY_MS}ms base spacing…`);
  const throttle = new Throttle(BASE_DELAY_MS, MAX_DELAY_MS);
  clientThrottle = throttle;
  const { inserted, failed } = await insertRows(client, board, rec.pending, throttle);

  console.log(`  inserted ${inserted}/${rec.pending.length}` + (failed.length ? `, ${failed.length} failed` : ''));
  if (throttle.rateLimitHits) console.log(`  absorbed ${throttle.rateLimitHits} rate-limit pause(s)`);
  if (failed.length) console.log('  re-run the same command to retry the remaining rows.');
  return board.id;
}

/** Set while a dataset is importing so client retries can widen the spacing. */
let clientThrottle: Throttle | null = null;

async function main() {
  console.log('Skylark BI — monday.com board seeding\n');

  const deals = readSheet(DEALS_PATH);
  const wos = readSheet(WO_PATH);

  console.log(`Deals sheet:       ${deals.rows.length} rows, ${deals.headers.length} columns`);
  console.log(`Work Orders sheet: ${wos.rows.length} rows, ${wos.headers.length} columns`);

  const dealTypes = buildTypes(deals);
  const woTypes = buildTypes(wos);

  if (DRY_RUN) {
    for (const [label, sheet, types] of [
      ['Deals', deals, dealTypes],
      ['Work Orders', wos, woTypes],
    ] as const) {
      console.log(`\n${label} column plan:`);
      sheet.headers.slice(1).forEach((h) => console.log(`  ${(types.get(h) ?? 'text').padEnd(8)} ${h}`));
      console.log(`  (item name column: "${sheet.headers[0]}")`);
    }
    console.log('\nDry run only — nothing was written to monday.com.');
    return;
  }

  if (!TOKEN) {
    console.error('\nMONDAY_API_TOKEN is not set. Export it and re-run, or use --dry-run.');
    process.exit(1);
  }

  const client = new MondayClient({
    token: TOKEN,
    apiVersion: '2024-10',
    // Long imports must outlast monday.com's per-minute rate-limit window, so
    // the seeder retries more times and waits far longer than the web app does.
    maxAttempts: 8,
    maxBackoffMs: 75_000,
    onRetry: ({ attempt, maxAttempts, delayMs, serverDirected, error }) => {
      if (error.status === 429 || /complexity|rate limit|budget/i.test(error.message)) {
        clientThrottle?.onRateLimit();
      }
      console.log(
        `    … rate limited, waiting ${Math.round(delayMs / 1000)}s` +
          `${serverDirected ? ' (server-directed)' : ''} — retry ${attempt}/${maxAttempts - 1}`,
      );
    },
  });

  const datasets: Dataset[] = [
    {
      key: 'deals',
      label: 'Deals',
      boardName: 'Skylark — Deals',
      sheet: deals,
      types: dealTypes,
      explicitId: arg('deals-board'),
      envId: process.env.MONDAY_DEALS_BOARD_ID?.trim(),
      envVar: 'MONDAY_DEALS_BOARD_ID',
    },
    {
      key: 'work-orders',
      label: 'Work Orders',
      boardName: 'Skylark — Work Orders',
      sheet: wos,
      types: woTypes,
      explicitId: arg('work-orders-board'),
      envId: process.env.MONDAY_WORK_ORDERS_BOARD_ID?.trim(),
      envVar: 'MONDAY_WORK_ORDERS_BOARD_ID',
    },
  ];

  const selected = ONLY ? datasets.filter((d) => d.key === ONLY) : datasets;
  if (!selected.length) {
    console.error(`\n--only must be one of: ${datasets.map((d) => d.key).join(', ')}`);
    process.exit(1);
  }

  const ids: Array<[string, string]> = [];
  for (const ds of selected) {
    const id = await processDataset(client, ds, !INSPECT);
    if (id) ids.push([ds.envVar, id]);
    clientThrottle = null;
  }

  if (INSPECT) {
    console.log('\nInspection only — nothing was written to monday.com.');
  }
  if (ids.length) {
    console.log('\nSet these in your environment:');
    for (const [k, v] of ids) console.log(`  ${k}=${v}`);
  }
}

main().catch((err) => {
  console.error('\nSeeding failed:', err instanceof Error ? err.message : err);
  console.error('Re-run the same command to resume; already-imported rows will be skipped.');
  process.exit(1);
});
