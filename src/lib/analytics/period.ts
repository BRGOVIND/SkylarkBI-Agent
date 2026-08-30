/**
 * Period resolution.
 *
 * Skylark is an Indian business, so "this quarter" is ambiguous: it can mean a
 * calendar quarter or an Indian financial-year quarter (Apr-Mar). We default to
 * the FINANCIAL year and always state which convention was used, so the founder
 * can redirect. The agent is instructed to ask when the distinction is material.
 */

export interface Period {
  start: string; // inclusive, YYYY-MM-DD
  end: string; // inclusive, YYYY-MM-DD
  label: string;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function mk(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}

/** Indian FY: FY26 runs 2025-04-01 .. 2026-03-31. Q1 = Apr-Jun. */
export function financialQuarter(ref: Date, offset = 0): Period {
  const m = ref.getUTCMonth();
  const y = ref.getUTCFullYear();
  const fyStartYear = m >= 3 ? y : y - 1;
  const qIndex = Math.floor(((m - 3 + 12) % 12) / 3); // 0..3
  let q = qIndex + offset;
  let sy = fyStartYear;
  while (q < 0) {
    q += 4;
    sy -= 1;
  }
  while (q > 3) {
    q -= 4;
    sy += 1;
  }
  const startMonth = 3 + q * 3;
  const start = mk(sy + Math.floor(startMonth / 12), startMonth % 12, 1);
  const endMonthAbs = startMonth + 3;
  const end = new Date(mk(sy + Math.floor(endMonthAbs / 12), endMonthAbs % 12, 1).getTime() - 86_400_000);
  const fyLabel = `FY${String((sy + 1) % 100).padStart(2, '0')}`;
  return { start: iso(start), end: iso(end), label: `${fyLabel} Q${q + 1} (financial year, Apr-Mar)` };
}

export function calendarQuarter(ref: Date, offset = 0): Period {
  const y = ref.getUTCFullYear();
  let q = Math.floor(ref.getUTCMonth() / 3) + offset;
  let sy = y;
  while (q < 0) {
    q += 4;
    sy -= 1;
  }
  while (q > 3) {
    q -= 4;
    sy += 1;
  }
  const start = mk(sy, q * 3, 1);
  const end = new Date(mk(sy + (q === 3 ? 1 : 0), q === 3 ? 0 : q * 3 + 3, 1).getTime() - 86_400_000);
  return { start: iso(start), end: iso(end), label: `${sy} Q${q + 1} (calendar quarter)` };
}

export function financialYear(ref: Date, offset = 0): Period {
  const m = ref.getUTCMonth();
  const y = ref.getUTCFullYear();
  const sy = (m >= 3 ? y : y - 1) + offset;
  return {
    start: iso(mk(sy, 3, 1)),
    end: iso(mk(sy + 1, 2, 31)),
    label: `FY${String((sy + 1) % 100).padStart(2, '0')} (Apr ${sy} - Mar ${sy + 1})`,
  };
}

export function monthPeriod(ref: Date, offset = 0): Period {
  const base = mk(ref.getUTCFullYear(), ref.getUTCMonth() + offset, 1);
  const end = new Date(mk(base.getUTCFullYear(), base.getUTCMonth() + 1, 1).getTime() - 86_400_000);
  const name = base.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return { start: iso(base), end: iso(end), label: `${name} ${base.getUTCFullYear()}` };
}

export function lastNDays(ref: Date, n: number): Period {
  const end = ref;
  const start = new Date(end.getTime() - (n - 1) * 86_400_000);
  return { start: iso(start), end: iso(end), label: `last ${n} days` };
}

export type PeriodName =
  | 'this_quarter'
  | 'last_quarter'
  | 'next_quarter'
  | 'this_calendar_quarter'
  | 'this_financial_year'
  | 'last_financial_year'
  | 'this_month'
  | 'last_month'
  | 'next_month'
  | 'last_30_days'
  | 'last_90_days'
  | 'all_time';

export function resolvePeriod(name: PeriodName, ref: Date = new Date()): Period | null {
  switch (name) {
    case 'this_quarter':
      return financialQuarter(ref, 0);
    case 'last_quarter':
      return financialQuarter(ref, -1);
    case 'next_quarter':
      return financialQuarter(ref, 1);
    case 'this_calendar_quarter':
      return calendarQuarter(ref, 0);
    case 'this_financial_year':
      return financialYear(ref, 0);
    case 'last_financial_year':
      return financialYear(ref, -1);
    case 'this_month':
      return monthPeriod(ref, 0);
    case 'last_month':
      return monthPeriod(ref, -1);
    case 'next_month':
      return monthPeriod(ref, 1);
    case 'last_30_days':
      return lastNDays(ref, 30);
    case 'last_90_days':
      return lastNDays(ref, 90);
    case 'all_time':
      return null;
  }
}

export function inPeriod(dateISO: string | null, period: Period | null): boolean {
  if (!period) return true;
  if (!dateISO) return false;
  return dateISO >= period.start && dateISO <= period.end;
}
