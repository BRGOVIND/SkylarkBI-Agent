import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { LIMITS, UploadError } from './limits';
import type { DatasetFormat } from './types';

/**
 * File bytes -> a raw grid of strings. No typing, no cleaning; that is the
 * normaliser's job. This layer only has to read the file safely.
 *
 * Everything here treats the upload as hostile input:
 *   - formulas are never evaluated, only their last cached value is read
 *   - macros are never executed (SheetJS does not run VBA, and we do not ask
 *     it to retain the macro blob)
 *   - nothing is written to disk, so a filename can never become a path
 *   - individual cells are truncated, so one enormous cell cannot blow up the
 *     request payload
 *
 * CSV and TSV go through papaparse rather than SheetJS: it handles quoting and
 * embedded newlines properly and has a much smaller surface on untrusted text.
 */

export interface RawGrid {
  headers: string[];
  rows: string[][];
  format: DatasetFormat;
  sheetName?: string;
  otherSheets?: string[];
  /** True when the row cap stopped us before the end of the file. */
  truncated: boolean;
  totalRowsInFile: number;
}

const EXT_FORMAT: Record<string, DatasetFormat> = {
  csv: 'csv',
  tsv: 'tsv',
  tab: 'tsv',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xls: 'xls',
  ods: 'ods',
};

/**
 * Format comes from the extension. A browser-supplied MIME type is not
 * trustworthy — it is attacker-controlled and inconsistent across platforms —
 * so it is never the deciding factor.
 */
export function detectFormat(fileName: string): DatasetFormat {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const fmt = EXT_FORMAT[ext];
  if (!fmt) {
    throw new UploadError(
      `Skylark can read CSV, TSV, XLSX, XLS and ODS files. "${safeName(fileName)}" is not one of those.`,
    );
  }
  return fmt;
}

/** Filenames are only ever shown, never resolved — strip anything path-like. */
export function safeName(fileName: string): string {
  const cleaned = Array.from(fileName)
    .map((ch) => (ch === String.fromCharCode(92) || ch === '/' ? ' ' : ch))
    // drop control characters, which have no place in a displayed name
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join('')
    .split('..')
    .join('.')
    .trim();
  return cleaned.slice(0, 120) || 'dataset';
}


const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.length > LIMITS.cellChars ? s.slice(0, LIMITS.cellChars) : s;
};

/* --------------------------------- text ---------------------------------- */

function parseDelimited(text: string, format: DatasetFormat): RawGrid {
  const out = Papa.parse<string[]>(text, {
    delimiter: format === 'tsv' ? '\t' : '',
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    header: false,
  });

  const grid = (out.data ?? []).filter(Array.isArray) as string[][];
  if (!grid.length) throw new UploadError('That file has no rows Skylark can read.');

  const headers = (grid[0] ?? []).map(cell);
  const body = grid.slice(1);
  const truncated = body.length > LIMITS.rows;

  return {
    headers,
    rows: body.slice(0, LIMITS.rows).map((r) => r.map(cell)),
    format,
    truncated,
    totalRowsInFile: body.length,
  };
}

/* ------------------------------- workbooks -------------------------------- */

function parseWorkbook(bytes: Uint8Array, format: DatasetFormat): RawGrid {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, {
      type: 'array',
      // Read values only. Formulas are not evaluated and the formula text is
      // not retained; we take the value the file was saved with.
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      // Dates come through as text and are typed by the normaliser, so the
      // same date rules apply to spreadsheets and CSVs alike.
      raw: false,
      dense: false,
    });
  } catch {
    throw new UploadError(
      'Skylark could not read that workbook. It may be password-protected or corrupted — try re-saving it as CSV or XLSX.',
    );
  }

  const sheetNames = wb.SheetNames ?? [];
  if (!sheetNames.length) throw new UploadError('That workbook has no sheets.');

  // Read the first sheet that actually has content, and report the rest.
  let chosen = '';
  let grid: string[][] = [];
  for (const name of sheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      raw: false,
      defval: '',
    }) as unknown[][];
    if (rows.some((r) => r.some((c) => cell(c).trim()))) {
      chosen = name;
      grid = rows.map((r) => r.map(cell));
      break;
    }
  }

  if (!chosen) throw new UploadError('Every sheet in that workbook is empty.');

  const headers = grid[0] ?? [];
  const body = grid.slice(1);
  const truncated = body.length > LIMITS.rows;

  return {
    headers,
    rows: body.slice(0, LIMITS.rows),
    format,
    sheetName: sheetNames.length > 1 ? chosen : undefined,
    otherSheets: sheetNames.filter((n) => n !== chosen),
    truncated,
    totalRowsInFile: body.length,
  };
}

/* --------------------------------- entry ---------------------------------- */

export function parseFile(fileName: string, bytes: Uint8Array): RawGrid {
  if (!bytes.byteLength) throw new UploadError('That file is empty.');
  if (bytes.byteLength > LIMITS.fileBytes) {
    throw new UploadError(
      `That file is larger than the ${Math.round(LIMITS.fileBytes / (1024 * 1024))} MB limit.`,
    );
  }

  const format = detectFormat(fileName);
  const grid =
    format === 'csv' || format === 'tsv'
      ? parseDelimited(new TextDecoder('utf-8').decode(bytes), format)
      : parseWorkbook(bytes, format);

  if (!grid.headers.length || grid.headers.every((h) => !h.trim())) {
    throw new UploadError(
      'Skylark could not find a header row. The first row should name the columns.',
    );
  }
  if (grid.headers.length > LIMITS.columns) {
    throw new UploadError(
      `That file has ${grid.headers.length} columns, more than the ${LIMITS.columns} Skylark can hold.`,
    );
  }
  if (!grid.rows.length) throw new UploadError('That file has a header row but no data rows.');

  return grid;
}
