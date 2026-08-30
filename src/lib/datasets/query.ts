import { LIMITS } from './limits';
import type {
  CellValue,
  Coverage,
  DatasetQuery,
  DatasetSnapshot,
  Filter,
  Metric,
  MetricResult,
  QueryResult,
} from './types';

/**
 * Deterministic query engine for uploaded datasets.
 *
 * This is the uploaded-data counterpart of the analytics layer: every number an
 * answer contains is produced here, in TypeScript, and the model only ever sees
 * the result. It cannot sum a column itself because it never receives the rows.
 *
 * Coverage is reported the same way the monday.com analytics report it —
 * {matched, counted, excluded} — so a total always arrives with how many rows
 * actually contributed. A blank cell reduces `counted`; it never contributes a
 * zero.
 */

export class QueryError extends Error {}

const MAX_GROUPS = 100;
const MAX_ROWS_RETURNED = 50;

function columnByRef(snapshot: DatasetSnapshot, ref: string) {
  const needle = ref.trim().toLowerCase();
  const col =
    snapshot.columns.find((c) => c.key.toLowerCase() === needle) ??
    snapshot.columns.find((c) => c.name.toLowerCase() === needle) ??
    snapshot.columns.find((c) => c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') === needle);
  if (!col) {
    throw new QueryError(
      `"${ref}" is not a column in "${snapshot.name}". Available columns: ${snapshot.columns
        .map((c) => c.name)
        .join(', ')}.`,
    );
  }
  return col;
}

/* -------------------------------- filtering ------------------------------- */

function matches(value: CellValue, f: Filter): boolean {
  if (f.op === 'is_missing') return value === null;
  if (f.op === 'is_present') return value !== null;
  // Every other comparison needs a value on both sides; a missing cell simply
  // does not match, rather than being coerced to zero or empty string.
  if (value === null) return false;
  if (f.value === undefined || f.value === null) return false;

  if (f.op === 'contains') {
    return String(value).toLowerCase().includes(String(f.value).toLowerCase());
  }

  const bothNumeric = typeof value === 'number' && typeof f.value !== 'boolean';
  const a: number | string = bothNumeric ? value : String(value).toLowerCase();
  const b: number | string = bothNumeric ? Number(f.value) : String(f.value).toLowerCase();
  if (bothNumeric && Number.isNaN(b as number)) return false;

  switch (f.op) {
    case 'eq':
      return a === b;
    case 'neq':
      return a !== b;
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
    default:
      return false;
  }
}

function selectRows(snapshot: DatasetSnapshot, filters: Filter[]): number[] {
  const resolved = filters.map((f) => ({ filter: f, col: columnByRef(snapshot, f.column) }));
  const idx: number[] = [];
  for (let i = 0; i < snapshot.rowCount; i++) {
    let ok = true;
    for (const { filter, col } of resolved) {
      if (!matches(snapshot.data[col.key][i], filter)) {
        ok = false;
        break;
      }
    }
    if (ok) idx.push(i);
  }
  return idx;
}

/* -------------------------------- metrics --------------------------------- */

function label(m: Metric, colName?: string): string {
  return m.op === 'count' ? 'count' : `${m.op}(${colName ?? m.column ?? '?'})`;
}

function computeMetric(snapshot: DatasetSnapshot, rows: number[], m: Metric): MetricResult {
  if (m.op === 'count') {
    return {
      metric: 'count',
      value: rows.length,
      coverage: { matched: rows.length, counted: rows.length, excluded: 0 },
    };
  }

  if (!m.column) throw new QueryError(`The "${m.op}" metric needs a column.`);
  const col = columnByRef(snapshot, m.column);
  const values = snapshot.data[col.key];

  if (m.op === 'count_distinct') {
    const seen = new Set<string>();
    let counted = 0;
    for (const i of rows) {
      const v = values[i];
      if (v === null) continue;
      counted++;
      seen.add(String(v));
    }
    return {
      metric: label(m, col.name),
      value: seen.size,
      coverage: { matched: rows.length, counted, excluded: rows.length - counted },
    };
  }

  // Numeric aggregates need numbers. A date or text column cannot be summed,
  // and saying so is better than returning a meaningless 0.
  if (col.type !== 'number' && (m.op === 'sum' || m.op === 'avg')) {
    throw new QueryError(
      `"${col.name}" holds ${col.type} values, so it cannot be ${m.op === 'sum' ? 'summed' : 'averaged'}.`,
    );
  }

  const nums: number[] = [];
  const strs: string[] = [];
  for (const i of rows) {
    const v = values[i];
    if (v === null) continue;
    if (typeof v === 'number') nums.push(v);
    else strs.push(String(v));
  }

  const counted = nums.length + (col.type === 'number' ? 0 : strs.length);
  const coverage: Coverage = {
    matched: rows.length,
    counted,
    excluded: rows.length - counted,
  };

  let value: number | string | null = null;
  if (col.type === 'number') {
    if (nums.length) {
      if (m.op === 'sum') value = nums.reduce((s, n) => s + n, 0);
      else if (m.op === 'avg') value = nums.reduce((s, n) => s + n, 0) / nums.length;
      else if (m.op === 'min') value = Math.min(...nums);
      else if (m.op === 'max') value = Math.max(...nums);
      if (typeof value === 'number') value = Math.round(value * 1e6) / 1e6;
    }
  } else if (strs.length && (m.op === 'min' || m.op === 'max')) {
    // Dates are ISO strings, so lexical order is chronological order.
    const sorted = [...strs].sort();
    value = m.op === 'min' ? sorted[0] : sorted[sorted.length - 1];
  }

  return { metric: label(m, col.name), value, coverage };
}

/* --------------------------------- runner --------------------------------- */

export function runQuery(snapshot: DatasetSnapshot, q: DatasetQuery): QueryResult {
  const filters = q.filters ?? [];
  const rows = filters.length
    ? selectRows(snapshot, filters)
    : Array.from({ length: snapshot.rowCount }, (_, i) => i);

  const caveats: string[] = [];
  if (snapshot.quality.truncated) {
    caveats.push(
      `Based on the first ${snapshot.rowCount.toLocaleString()} rows of ${snapshot.quality.totalRowsInFile.toLocaleString()} in the file.`,
    );
  }
  if (filters.length && !rows.length) {
    caveats.push('No rows match those filters, so there is nothing to report.');
  }

  const base = {
    dataset: snapshot.name,
    rowsMatched: rows.length,
    rowsInDataset: snapshot.rowCount,
    caveats,
  };

  /* ---- listing individual rows ---- */
  if (q.select?.length) {
    const cols = q.select.map((r) => columnByRef(snapshot, r));
    let idx = rows;

    if (q.sort) {
      const sortCol = columnByRef(snapshot, q.sort.by);
      const dir = q.sort.direction === 'asc' ? 1 : -1;
      const vals = snapshot.data[sortCol.key];
      idx = [...rows].sort((a, b) => {
        const va = vals[a];
        const vb = vals[b];
        // Rows with no value sort last regardless of direction, so they never
        // masquerade as the smallest or largest.
        if (va === null && vb === null) return 0;
        if (va === null) return 1;
        if (vb === null) return -1;
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });
    }

    const limit = Math.min(q.limit ?? 10, MAX_ROWS_RETURNED);
    const out = idx.slice(0, limit).map((i) => {
      const row: Record<string, CellValue> = {};
      for (const c of cols) row[c.name] = snapshot.data[c.key][i];
      return row;
    });

    if (idx.length > out.length) {
      caveats.push(`Showing ${out.length} of ${idx.length} matching rows.`);
    }
    return { ...base, rows: out, truncated: idx.length > out.length };
  }

  const metrics = q.metrics?.length ? q.metrics : [{ op: 'count' as const }];

  /* ---- grouped aggregation ---- */
  if (q.group_by) {
    const groupCol = columnByRef(snapshot, q.group_by);
    const values = snapshot.data[groupCol.key];
    const buckets = new Map<string | null, number[]>();

    for (const i of rows) {
      const v = values[i];
      // Rows with no group value get their own bucket rather than being
      // dropped, so the reader can see how much is unattributed.
      const key = v === null ? null : String(v);
      const b = buckets.get(key);
      if (b) b.push(i);
      else buckets.set(key, [i]);
    }

    let groups = [...buckets.entries()].map(([group, idx]) => ({
      group,
      rowCount: idx.length,
      metrics: metrics.map((m) => computeMetric(snapshot, idx, m)),
    }));

    // Sort by the first numeric metric when there is one, else by size.
    groups.sort((a, b) => {
      const av = a.metrics[0]?.value;
      const bv = b.metrics[0]?.value;
      if (typeof av === 'number' && typeof bv === 'number') return bv - av;
      return b.rowCount - a.rowCount;
    });
    if (q.sort?.direction === 'asc') groups.reverse();

    const limit = Math.min(q.limit ?? MAX_GROUPS, MAX_GROUPS);
    const truncated = groups.length > limit;
    if (truncated) caveats.push(`Showing the top ${limit} of ${groups.length} groups.`);
    groups = groups.slice(0, limit);

    const unattributed = buckets.get(null)?.length ?? 0;
    if (unattributed) {
      caveats.push(
        `${unattributed} row(s) have no value for "${groupCol.name}" and are grouped separately rather than dropped.`,
      );
    }

    return { ...base, groups, truncated };
  }

  /* ---- ungrouped aggregation ---- */
  const results = metrics.map((m) => computeMetric(snapshot, rows, m));
  for (const r of results) {
    if (r.coverage.excluded > 0) {
      caveats.push(
        `${r.metric} is based on ${r.coverage.counted} of ${r.coverage.matched} rows; ${r.coverage.excluded} have no value and are excluded rather than counted as zero.`,
      );
    }
  }
  return { ...base, metrics: results };
}

/** Compact description used to tell the agent what a dataset contains. */
export function describeDataset(snapshot: DatasetSnapshot) {
  return {
    name: snapshot.name,
    fileName: snapshot.fileName,
    format: snapshot.format,
    sheetName: snapshot.sheetName,
    rows: snapshot.rowCount,
    columns: snapshot.columns.map((c) => ({
      name: c.name,
      type: c.type,
      populated: `${c.present}/${snapshot.rowCount}`,
      completeness: c.completeness,
      missing: c.missing,
      malformed: c.malformed,
      distinct: c.distinctCount,
      min: c.min,
      max: c.max,
      examples: c.sample,
    })),
    dataQuality: snapshot.quality,
  };
}

/** The preview the UI shows: a handful of real rows, nothing more. */
export function previewRows(snapshot: DatasetSnapshot, n: number = LIMITS.previewRows) {
  const count = Math.min(n, snapshot.rowCount);
  return Array.from({ length: count }, (_, i) => {
    const row: Record<string, CellValue> = {};
    for (const c of snapshot.columns) row[c.name] = snapshot.data[c.key][i];
    return row;
  });
}
