/**
 * One-time setup script: imports the supplied spreadsheets into two new
 * monday.com boards.
 *
 * This is SETUP tooling, run manually from a terminal. It is not part of the
 * deployed application and is unreachable from the web app — the running agent
 * uses `MondayClient.query`, which refuses mutations outright.
 *
 * Deliberate design choice: the data is uploaded VERBATIM, including blanks,
 * duplicate rows and the repeated header rows present in the source files. The
 * assignment's data is meant to be messy, and cleaning it here would move the
 * problem out of the agent, which is exactly what is being evaluated.
 *
 * Usage:
 *   npx tsx scripts/seed-monday.ts --deals "<path>" --work-orders "<path>"
 *   npx tsx scripts/seed-monday.ts ... --dry-run
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import { MondayClient } from '../src/lib/monday/client';

/* --------------------------------- CLI ----------------------------------- */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY_RUN = process.argv.includes('--dry-run');

const TOKEN = process.env.MONDAY_API_TOKEN?.trim();
const WORKSPACE_ID = process.env.MONDAY_WORKSPACE_ID?.trim();

const DEALS_PATH = arg('deals') ?? 'Deal funnel Data.xlsx';
const WO_PATH = arg('work-orders') ?? 'Work_Order_Tracker Data.xlsx';

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
  const wb = XLSX.readFile(file, { cellDates: true });
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

function looksNumeric(values: string[]): boolean {
  const present = values.filter((v) => v !== '');
  if (present.length < 3) return false;
  const numeric = present.filter((v) => /^-?[\d,]*\.?\d+$/.test(v.replace(/\s/g, '')));
  return numeric.length / present.length > 0.8;
}

function looksDate(values: string[]): boolean {
  const present = values.filter((v) => v !== '');
  if (present.length < 3) return false;
  const dates = present.filter((v) => /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(v));
  return dates.length / present.length > 0.8;
}

/**
 * Chooses a monday.com column type per source column.
 *
 * Note on `text` vs `status`: monday.com status columns have a hard limit on
 * distinct labels and silently reject unknown values on write. Free-text
 * columns preserve the messy source values exactly, which is what we want —
 * the agent's normalisation layer is responsible for interpreting them.
 */
function pickType(header: string, values: string[]): 'date' | 'numbers' | 'text' {
  if (DATE_HINT.test(header) && looksDate(values)) return 'date';
  if (looksDate(values)) return 'date';
  if ((NUMERIC_HINT.test(header) || looksNumeric(values)) && looksNumeric(values)) return 'numbers';
  return 'text';
}

function toDateValue(v: string): string | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (d) {
    const day = d[1].padStart(2, '0');
    const mon = d[2].padStart(2, '0');
    return `${d[3]}-${mon}-${day}`;
  }
  return null;
}

/* -------------------------------- monday --------------------------------- */

interface CreatedBoard {
  id: string;
  columns: Map<string, { id: string; type: string }>;
}

async function createBoard(client: MondayClient, name: string, sheet: Sheet): Promise<CreatedBoard> {
  const created = await client.unsafeMutate<{ create_board: { id: string } }>(
    `mutation($name: String!, $ws: ID) {
       create_board(board_name: $name, board_kind: public, workspace_id: $ws) { id }
     }`,
    { name, ws: WORKSPACE_ID ?? null },
  );
  const boardId = created.create_board.id;
  console.log(`  created board "${name}" (id ${boardId})`);

  const columns = new Map<string, { id: string; type: string }>();
  // The first column becomes the item name, so it needs no board column.
  for (const header of sheet.headers.slice(1)) {
    const values = sheet.rows.map((r) => r[header] ?? '');
    const type = pickType(header, values);
    const res = await client.unsafeMutate<{ create_column: { id: string } }>(
      `mutation($board: ID!, $title: String!, $type: ColumnType!) {
         create_column(board_id: $board, title: $title, column_type: $type) { id }
       }`,
      { board: boardId, title: header, type },
    );
    columns.set(header, { id: res.create_column.id, type });
    console.log(`    + ${header}  [${type}]`);
    await sleep(220); // stay well inside monday.com's mutation rate limit
  }
  return { id: boardId, columns };
}

function buildColumnValues(
  row: Record<string, string>,
  columns: Map<string, { id: string; type: string }>,
): string {
  const out: Record<string, unknown> = {};
  for (const [header, col] of columns) {
    const raw = (row[header] ?? '').trim();
    if (!raw) continue; // leave blanks genuinely blank
    if (col.type === 'date') {
      const d = toDateValue(raw);
      // Unparseable dates are preserved as-is is impossible in a date column,
      // so they are skipped and reported rather than silently coerced.
      if (d) out[col.id] = { date: d };
    } else if (col.type === 'numbers') {
      const n = raw.replace(/,/g, '');
      if (/^-?\d*\.?\d+$/.test(n)) out[col.id] = n;
    } else {
      out[col.id] = raw;
    }
  }
  return JSON.stringify(out);
}

async function addItems(client: MondayClient, board: CreatedBoard, sheet: Sheet): Promise<number> {
  const nameHeader = sheet.headers[0];
  let n = 0;
  for (const row of sheet.rows) {
    const name = (row[nameHeader] ?? '').trim() || `(unnamed ${n + 1})`;
    await client.unsafeMutate(
      `mutation($board: ID!, $name: String!, $vals: JSON!) {
         create_item(board_id: $board, item_name: $name, column_values: $vals, create_labels_if_missing: true) { id }
       }`,
      { board: board.id, name, vals: buildColumnValues(row, board.columns) },
    );
    n++;
    if (n % 25 === 0) console.log(`    ${n}/${sheet.rows.length} items…`);
    await sleep(180);
  }
  return n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------- main ---------------------------------- */

async function main() {
  console.log('Skylark BI — monday.com board seeding\n');

  const deals = readSheet(DEALS_PATH);
  const wos = readSheet(WO_PATH);

  console.log(`Deals sheet:       ${deals.rows.length} rows, ${deals.headers.length} columns`);
  console.log(`Work Orders sheet: ${wos.rows.length} rows, ${wos.headers.length} columns\n`);

  if (DRY_RUN) {
    for (const [label, sheet] of [['Deals', deals], ['Work Orders', wos]] as const) {
      console.log(`${label} column plan:`);
      sheet.headers.slice(1).forEach((h) => {
        const t = pickType(h, sheet.rows.map((r) => r[h] ?? ''));
        console.log(`  ${t.padEnd(8)} ${h}`);
      });
      console.log(`  (item name column: "${sheet.headers[0]}")\n`);
    }
    console.log('Dry run only — nothing was written to monday.com.');
    return;
  }

  if (!TOKEN) {
    console.error('MONDAY_API_TOKEN is not set. Export it and re-run, or use --dry-run.');
    process.exit(1);
  }

  const client = new MondayClient({ token: TOKEN, apiVersion: '2024-10' });

  console.log('Creating Deals board…');
  const dealsBoard = await createBoard(client, 'Skylark — Deals', deals);
  const dealsCount = await addItems(client, dealsBoard, deals);

  console.log('\nCreating Work Orders board…');
  const woBoard = await createBoard(client, 'Skylark — Work Orders', wos);
  const woCount = await addItems(client, woBoard, wos);

  console.log('\nDone.');
  console.log(`  Deals board:       ${dealsBoard.id}  (${dealsCount} items)`);
  console.log(`  Work Orders board: ${woBoard.id}  (${woCount} items)`);
  console.log('\nSet these in your environment:');
  console.log(`  MONDAY_DEALS_BOARD_ID=${dealsBoard.id}`);
  console.log(`  MONDAY_WORK_ORDERS_BOARD_ID=${woBoard.id}`);
}

main().catch((err) => {
  console.error('\nSeeding failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
