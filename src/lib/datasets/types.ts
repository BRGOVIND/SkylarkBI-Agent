/**
 * A user-uploaded tabular dataset, in the shape the agent reasons over.
 *
 * The design mirrors the monday.com path deliberately: values are parsed with
 * the same primitives, missing is never conflated with zero, and every column
 * carries how much of it is actually usable. An answer drawn from an uploaded
 * file gets the same honesty as one drawn from a board.
 *
 * Storage is columnar rather than row-oriented because the snapshot travels in
 * the body of every chat request — repeating column names per row would roughly
 * double the payload for no benefit.
 */

export type ColumnType = 'string' | 'number' | 'date' | 'boolean' | 'categorical';

/** A parsed cell. `null` means no usable value — never zero, never empty string. */
export type CellValue = string | number | boolean | null;

export interface ColumnSchema {
  /** Stable machine key, unique within the dataset. */
  key: string;
  /** The header exactly as it appeared in the file. */
  name: string;
  type: ColumnType;

  /** Cells carrying a usable value. */
  present: number;
  /** Cells that were blank or an explicit null token ("N/A", "-", "none"). */
  missing: number;
  /** Cells that held something, but not something this column's type accepts. */
  malformed: number;
  /** present / rowCount, to one decimal place. */
  completeness: number;

  /** Distinct usable values, when cheap enough to be worth reporting. */
  distinctCount?: number;
  /** Range for number and date columns. Dates are ISO strings. */
  min?: number | string;
  max?: number | string;
  /** A few real values, so the agent can see what the column looks like. */
  sample: string[];
}

export interface DatasetQuality {
  totalRowsInFile: number;
  usableRows: number;
  emptyRowsDropped: number;
  /** Identical rows seen. They are KEPT — see normalize.ts for why. */
  duplicateRowsFound: number;
  /** True when the row cap was hit and later rows were not read. */
  truncated: boolean;
  /** Plain-language notes the agent is expected to pass on to the reader. */
  warnings: string[];
}

export interface DatasetSnapshot {
  id: string;
  /** Display name, derived from the filename. */
  name: string;
  fileName: string;
  format: DatasetFormat;
  /** Set when a workbook had more than one sheet and we read one of them. */
  sheetName?: string;
  /** Other sheets present but not read, so the agent can say so. */
  otherSheets?: string[];

  rowCount: number;
  columns: ColumnSchema[];
  /** column key -> values, aligned by row index. */
  data: Record<string, CellValue[]>;

  quality: DatasetQuality;
  createdAt: string;
}

export type DatasetFormat = 'csv' | 'tsv' | 'xlsx' | 'xls' | 'ods';

/** Matches the analytics layer's coverage semantics exactly. */
export interface Coverage {
  matched: number;
  counted: number;
  excluded: number;
}

/* ------------------------------ query model ------------------------------- */

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'is_missing'
  | 'is_present';

export interface Filter {
  column: string;
  op: FilterOp;
  value?: string | number | boolean;
}

export type MetricOp = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct';

export interface Metric {
  op: MetricOp;
  /** Required for every op except `count`. */
  column?: string;
}

export interface DatasetQuery {
  dataset: string;
  filters?: Filter[];
  group_by?: string;
  metrics?: Metric[];
  /** Return individual rows instead of aggregates. */
  select?: string[];
  sort?: { by: string; direction?: 'asc' | 'desc' };
  limit?: number;
}

export interface MetricResult {
  metric: string;
  value: number | string | null;
  coverage: Coverage;
}

export interface QueryResult {
  dataset: string;
  rowsMatched: number;
  rowsInDataset: number;
  groups?: Array<{ group: string | null; rowCount: number; metrics: MetricResult[] }>;
  metrics?: MetricResult[];
  rows?: Array<Record<string, CellValue>>;
  truncated?: boolean;
  caveats: string[];
}
