/**
 * Upload limits.
 *
 * These are not arbitrary. The parsed snapshot travels in the body of every
 * chat request, and Vercel caps a serverless request body at roughly 4.5 MB, so
 * the binding constraint is the serialized snapshot rather than the file on
 * disk: a 3 MB CSV of short strings can outgrow a 6 MB spreadsheet once parsed.
 *
 * SNAPSHOT_BYTES is therefore checked after normalisation and is the limit that
 * actually protects the request. The others fail earlier and more cheaply.
 */

const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const LIMITS = {
  /** Uploaded file size. */
  get fileBytes() {
    return num('MAX_UPLOAD_MB', 8) * 1024 * 1024;
  },
  /** Data rows read, excluding the header. */
  get rows() {
    return num('MAX_ROWS', 20_000);
  },
  get columns() {
    return num('MAX_COLUMNS', 60);
  },
  /**
   * Serialized snapshot ceiling. Well under Vercel's ~4.5 MB body limit, since
   * the conversation travels alongside it.
   */
  get snapshotBytes() {
    return num('MAX_SNAPSHOT_MB', 1.5) * 1024 * 1024;
  },
  /** Datasets held at once. */
  get datasets() {
    return num('MAX_DATASETS', 5);
  },
  /** A single cell is truncated beyond this, so one huge cell cannot blow up the payload. */
  cellChars: 2_000,
  /** Rows shown in the UI preview. */
  previewRows: 8,
} as const;

export const SUPPORTED_EXTENSIONS = ['csv', 'tsv', 'xlsx', 'xls', 'ods'] as const;

/** Human-readable, for error messages and the UI. */
export function describeLimits() {
  return {
    maxFileMb: Math.round(LIMITS.fileBytes / (1024 * 1024)),
    maxRows: LIMITS.rows,
    maxColumns: LIMITS.columns,
    maxDatasets: LIMITS.datasets,
    formats: SUPPORTED_EXTENSIONS,
  };
}

export class UploadError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}
