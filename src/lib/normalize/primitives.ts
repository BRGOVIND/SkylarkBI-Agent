/**
 * Field-level coercion primitives.
 *
 * Every parser returns the parsed value *and* whether the raw input was
 * present-but-unparseable. That distinction matters: "missing" and "malformed"
 * are different data-quality problems and the agent reports them separately.
 */

export interface Parsed<T> {
  value: T | null;
  /** Raw input was non-empty but could not be interpreted. */
  invalid: boolean;
  raw: string | null;
}

const NULL_TOKENS = new Set([
  '',
  '-',
  '--',
  'n/a',
  'na',
  'nil',
  'null',
  'none',
  'nan',
  'tbd',
  'tba',
  'unknown',
  '#n/a',
  '#value!',
  '#ref!',
  'not available',
  'not applicable',
  'to be decided',
  'pending',
  '?',
]);

/** Collapses whitespace and maps common null sentinels to null. */
export function cleanText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (NULL_TOKENS.has(s.toLowerCase())) return null;
  return s;
}

/**
 * Parses a number that may arrive as a string with currency symbols, commas,
 * Indian-format separators, percent signs, or parenthesised negatives.
 */
export function parseNumber(raw: unknown): Parsed<number> {
  const text = cleanText(raw);
  if (text === null) return { value: null, invalid: false, raw: null };

  let s = text;
  let negative = false;

  // (1,234) accounting notation
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  s = s
    .replace(/[₹$€£]/g, '')
    // Currency words, including a trailing period ("Rs." / "INR.").
    .replace(/\b(?:INR|Rs|Rupees)\b\.?/gi, '')
    .replace(/,/g, '')
    .replace(/%/g, '')
    .trim();

  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1).trim();
  }

  // Trailing unit suffixes seen in quantity columns, e.g. "5360 HA".
  const unitMatch = s.match(/^([0-9]*\.?[0-9]+)\s*[a-zA-Z%]*$/);
  if (unitMatch) s = unitMatch[1];

  if (!/^[0-9]*\.?[0-9]+$/.test(s)) {
    return { value: null, invalid: true, raw: text };
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return { value: null, invalid: true, raw: text };
  return { value: negative ? -n : n, invalid: false, raw: text };
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

function utc(y: number, m: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, m, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
  return dt;
}

/**
 * Parses the several date shapes present in the source data.
 *
 * Ambiguity policy: for pure-numeric separated dates we assume DD/MM/YYYY
 * (Indian convention, matching the source business) and only fall back to
 * MM/DD/YYYY when the first component cannot be a day. This assumption is
 * surfaced in the README and Decision Log rather than hidden.
 */
export function parseDate(raw: unknown): Parsed<Date> {
  const text = cleanText(raw);
  if (text === null) return { value: null, invalid: false, raw: null };

  const s = text.replace(/\s+\d{2}:\d{2}(:\d{2})?(\.\d+)?$/, '').trim();

  // ISO-ish: YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const d = utc(+m[1], +m[2] - 1, +m[3]);
    return d ? { value: d, invalid: false, raw: text } : { value: null, invalid: true, raw: text };
  }

  // D/M/YYYY, D-M-YY, D.M.YYYY
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (m) {
    let a = +m[1];
    let b = +m[2];
    let y = +m[3];
    if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
    // Prefer day-first; swap only when the first part cannot be a day.
    if (a > 12 && b > 12) return { value: null, invalid: true, raw: text };
    if (a > 12) {
      // a is unambiguously a day -> already day-first
    } else if (b > 12) {
      // b cannot be a month -> input was month-first
      [a, b] = [b, a];
    }
    const d = utc(y, b - 1, a);
    return d ? { value: d, invalid: false, raw: text } : { value: null, invalid: true, raw: text };
  }

  // "12 Mar 2025", "12-Mar-25", "Mar 12, 2025", "March 2025"
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-](\d{2}|\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    let y = +m[3];
    if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
    if (mo !== undefined) {
      const d = utc(y, mo, +m[1]);
      if (d) return { value: d, invalid: false, raw: text };
    }
    return { value: null, invalid: true, raw: text };
  }

  m = s.match(/^([A-Za-z]{3,9})[\s-](\d{1,2}),?[\s-](\d{2}|\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    let y = +m[3];
    if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
    if (mo !== undefined) {
      const d = utc(y, mo, +m[2]);
      if (d) return { value: d, invalid: false, raw: text };
    }
    return { value: null, invalid: true, raw: text };
  }

  // Excel serial numbers (days since 1899-12-30), occasionally leak through.
  if (/^\d{5}$/.test(s)) {
    const serial = +s;
    if (serial > 20000 && serial < 60000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
      return { value: d, invalid: false, raw: text };
    }
  }

  return { value: null, invalid: true, raw: text };
}

/** Bare month names such as "Dec" / "November" used in billing-month columns. */
export function parseMonthName(raw: unknown): Parsed<number> {
  const text = cleanText(raw);
  if (text === null) return { value: null, invalid: false, raw: null };
  const mo = MONTHS[text.toLowerCase()];
  return mo === undefined
    ? { value: null, invalid: true, raw: text }
    : { value: mo, invalid: false, raw: text };
}

export function toISODate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
