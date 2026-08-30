import { parseDate, parseNumber, toISODate } from '../normalize/primitives';
import { LIMITS, UploadError } from './limits';
import { safeName, type RawGrid } from './parse';
import type {
  CellValue,
  ColumnSchema,
  ColumnType,
  DatasetQuality,
  DatasetSnapshot,
} from './types';

/**
 * A raw grid becomes a typed, columnar snapshot with a quality report.
 *
 * Numbers and dates are parsed with the same primitives the monday.com path
 * uses, so an uploaded file inherits the rules proven there: a value that is
 * present but unparseable is malformed rather than missing, and both are
 * counted so an answer can state what it is actually based on.
 *
 * What counts as blank is NOT shared — see BLANK_TOKENS below for why a generic
 * spreadsheet needs a narrower rule than a known board does.
 */

const BOOL_TRUE = new Set(['true', 'yes', 'y', '1']);
const BOOL_FALSE = new Set(['false', 'no', 'n', '0']);

/**
 * What counts as "no value" in an arbitrary user file.
 *
 * Deliberately narrower than the monday.com token list, which also treats words
 * like "pending", "tbd" and "unknown" as empty. That is right for those boards,
 * where they mean a field was never filled in — but in someone else's
 * spreadsheet "Pending" is usually a real status, and silently reading it as
 * missing would corrupt their counts. Only unambiguous emptiness markers and
 * spreadsheet error values qualify here.
 */
const BLANK_TOKENS = new Set([
  '-',
  '--',
  'n/a',
  'na',
  'null',
  'nil',
  'none',
  'nan',
  '#n/a',
  '#na',
  '#value!',
  '#ref!',
  '#div/0!',
  '#name?',
  '#null!',
  '#num!',
]);

/** Trimmed text, or null when the cell genuinely holds no value. */
function datasetText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return BLANK_TOKENS.has(s.toLowerCase()) ? null : s;
}

/** Stable, unique machine key per column. */
function makeKeys(headers: string[]): string[] {
  const used = new Map<string, number>();
  return headers.map((h, i) => {
    const base =
      datasetText(h)
        ?.toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || `column_${i + 1}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen ? `${base}_${seen + 1}` : base;
  });
}

/**
 * Decides a column's type from what most of its populated cells look like.
 *
 * Sampling the whole column rather than the first few rows matters: real
 * exports often start with blanks or a stray note before the data proper.
 */
function inferType(values: string[]): ColumnType {
  const populated = values.filter((v) => datasetText(v) !== null);
  if (!populated.length) return 'string';

  let numeric = 0;
  let dates = 0;
  let bools = 0;
  for (const v of populated) {
    if (parseNumber(v).value !== null) numeric++;
    if (parseDate(v).value !== null) dates++;
    const t = v.trim().toLowerCase();
    if (BOOL_TRUE.has(t) || BOOL_FALSE.has(t)) bools++;
  }

  const n = populated.length;
  if (bools / n > 0.9) return 'boolean';

  // A 70% majority decides the type. Real exports carry a few junk values in
  // otherwise numeric columns, and a stricter threshold would retype the whole
  // column as text — which loses the ability to total it at all, and hides the
  // bad values instead of counting them as malformed.
  //
  // Dates must also beat numbers outright: a column of bare years parses as
  // both, and is far more useful as a number.
  if (dates / n > 0.7 && dates >= numeric) return 'date';
  if (numeric / n > 0.7) return 'number';

  const distinct = new Set(populated.map((v) => v.trim().toLowerCase()));
  if (distinct.size <= 25 && n >= distinct.size * 2) return 'categorical';
  return 'string';
}

/** Parses one cell to the column's type. Returns the value and why it is absent. */
function coerce(raw: string, type: ColumnType): { value: CellValue; malformed: boolean } {
  const text = datasetText(raw);
  if (text === null) return { value: null, malformed: false };

  switch (type) {
    case 'number': {
      const p = parseNumber(text);
      return { value: p.value, malformed: p.value === null };
    }
    case 'date': {
      const p = parseDate(text);
      return { value: toISODate(p.value), malformed: p.value === null };
    }
    case 'boolean': {
      const t = text.toLowerCase();
      if (BOOL_TRUE.has(t)) return { value: true, malformed: false };
      if (BOOL_FALSE.has(t)) return { value: false, malformed: false };
      return { value: null, malformed: true };
    }
    default:
      return { value: text, malformed: false };
  }
}

export function buildSnapshot(grid: RawGrid, fileName: string, id: string): DatasetSnapshot {
  const keys = makeKeys(grid.headers);
  const width = grid.headers.length;

  // Blank rows are dropped; identical rows are NOT.
  //
  // On the monday.com boards a repeated row is an artefact of the export, so
  // removing it is right. In someone else's spreadsheet two identical rows are
  // usually two real events — two invoices for the same amount on the same day —
  // and silently removing one would undercount their business. They are counted
  // and reported instead, so the reader can decide.
  const seen = new Set<string>();
  let emptyRowsDropped = 0;
  let duplicateRowsFound = 0;
  const rows: string[][] = [];

  for (const raw of grid.rows) {
    const row = Array.from({ length: width }, (_, i) => raw[i] ?? '');
    if (row.every((c) => datasetText(c) === null)) {
      emptyRowsDropped++;
      continue;
    }
    // JSON rather than a joined string: unambiguous, and no separator a cell
    // could contain by accident.
    const fingerprint = JSON.stringify(row);
    if (seen.has(fingerprint)) duplicateRowsFound++;
    else seen.add(fingerprint);
    rows.push(row);
  }

  if (!rows.length) {
    throw new UploadError('Every row in that file is empty.');
  }

  const data: Record<string, CellValue[]> = {};
  const columns: ColumnSchema[] = [];

  for (let c = 0; c < width; c++) {
    const key = keys[c];
    const rawValues = rows.map((r) => r[c]);
    const type = inferType(rawValues);

    const values: CellValue[] = [];
    let present = 0;
    let missing = 0;
    let malformed = 0;
    const distinct = new Set<string>();
    const sample: string[] = [];

    for (const raw of rawValues) {
      const { value, malformed: bad } = coerce(raw, type);
      values.push(value);
      if (value === null) {
        if (bad) malformed++;
        else missing++;
      } else {
        present++;
        if (distinct.size <= 5000) distinct.add(String(value));
        if (sample.length < 3) sample.push(String(value));
      }
    }

    let min: number | string | undefined;
    let max: number | string | undefined;
    if (type === 'number') {
      const nums = values.filter((v): v is number => typeof v === 'number');
      if (nums.length) {
        min = Math.min(...nums);
        max = Math.max(...nums);
      }
    } else if (type === 'date') {
      const ds = values.filter((v): v is string => typeof v === 'string').sort();
      if (ds.length) {
        min = ds[0];
        max = ds[ds.length - 1];
      }
    }

    data[key] = values;
    columns.push({
      key,
      name: datasetText(grid.headers[c]) ?? `Column ${c + 1}`,
      type,
      present,
      missing,
      malformed,
      completeness: rows.length ? Math.round((present / rows.length) * 1000) / 10 : 0,
      distinctCount: distinct.size <= 5000 ? distinct.size : undefined,
      min,
      max,
      sample,
    });
  }

  const warnings: string[] = [];
  if (grid.truncated) {
    warnings.push(
      `Only the first ${rows.length.toLocaleString()} rows were read; the file contains ${grid.totalRowsInFile.toLocaleString()}. Totals cover the rows read, not the whole file.`,
    );
  }
  if (duplicateRowsFound) {
    warnings.push(
      `${duplicateRowsFound} row(s) are exact duplicates of an earlier row. They are counted, not removed — if they are double entries rather than genuine repeats, totals will be overstated.`,
    );
  }
  for (const col of columns) {
    if (col.completeness < 90 && col.missing) {
      warnings.push(
        `"${col.name}" has a value in ${col.present} of ${rows.length} rows; the rest are blank and are excluded from totals rather than counted as zero.`,
      );
    }
    if (col.malformed) {
      warnings.push(
        `"${col.name}" has ${col.malformed} value(s) that could not be read as ${col.type}.`,
      );
    }
  }
  if (grid.otherSheets?.length) {
    warnings.push(
      `Only the "${grid.sheetName}" sheet was read. Also in the workbook: ${grid.otherSheets.join(', ')}.`,
    );
  }

  const quality: DatasetQuality = {
    totalRowsInFile: grid.totalRowsInFile,
    usableRows: rows.length,
    emptyRowsDropped,
    duplicateRowsFound,
    truncated: grid.truncated,
    warnings,
  };

  const display = safeName(fileName).replace(/\.[a-z0-9]+$/i, '') || 'Dataset';

  const snapshot: DatasetSnapshot = {
    id,
    name: display,
    fileName: safeName(fileName),
    format: grid.format,
    sheetName: grid.sheetName,
    otherSheets: grid.otherSheets?.length ? grid.otherSheets : undefined,
    rowCount: rows.length,
    columns,
    data,
    quality,
    createdAt: new Date().toISOString(),
  };

  // The snapshot travels in every chat request, so its serialized size is the
  // limit that actually matters. Checked here, where the true cost is known.
  const bytes = JSON.stringify(snapshot).length;
  if (bytes > LIMITS.snapshotBytes) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const cap = (LIMITS.snapshotBytes / (1024 * 1024)).toFixed(1);
    throw new UploadError(
      `That file holds ${rows.length.toLocaleString()} rows across ${width} columns, which comes to ${mb} MB of data — above the ${cap} MB Skylark can work with. Try fewer rows or fewer columns.`,
    );
  }

  return snapshot;
}
