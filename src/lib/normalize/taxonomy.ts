import { cleanText } from './primitives';

/**
 * Canonical vocabularies for the categorical columns.
 *
 * The source boards mix ordered stage labels ("A. Lead Generated") with
 * unordered ones ("Project Completed"), and repeat header text as data. This
 * module maps everything onto a stable internal vocabulary while preserving the
 * original label for display.
 */

export type PipelineBucket = 'open' | 'won' | 'lost' | 'on_hold' | 'not_relevant' | 'unknown';
export type DealStatusCanon = 'open' | 'won' | 'dead' | 'on_hold' | 'unknown';
export type ExecutionStatusCanon =
  | 'not_started'
  | 'ongoing'
  | 'partial'
  | 'completed'
  | 'paused'
  | 'blocked_on_client'
  | 'unknown';

function key(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* ------------------------------ Deal stages ------------------------------ */

export interface StageInfo {
  /** Original label as stored on the board. */
  label: string;
  /** Sort order derived from the "A." .. "O." prefix; null when absent. */
  order: number | null;
  bucket: PipelineBucket;
}

const STAGE_BUCKETS: Array<{ match: RegExp; bucket: PipelineBucket }> = [
  { match: /leadgenerated|salesqualified|demodone|feasibility|proposal|commercials|negotiation|poc/, bucket: 'open' },
  { match: /projectwon|workorderreceived|invoicesent|amountaccrued|projectcompleted|completed/, bucket: 'won' },
  { match: /projectlost|lost/, bucket: 'lost' },
  { match: /onhold|hold/, bucket: 'on_hold' },
  { match: /notrelevant/, bucket: 'not_relevant' },
];

export function normalizeStage(raw: unknown): StageInfo | null {
  const label = cleanText(raw);
  if (label === null) return null;

  const prefix = label.match(/^([A-Za-z])\s*[.)]\s*/);
  const order = prefix ? prefix[1].toUpperCase().charCodeAt(0) - 64 : null;
  const body = key(prefix ? label.slice(prefix[0].length) : label);

  let bucket: PipelineBucket = 'unknown';
  for (const b of STAGE_BUCKETS) {
    if (b.match.test(body)) {
      bucket = b.bucket;
      break;
    }
  }
  return { label, order, bucket };
}

/* ------------------------------ Deal status ------------------------------ */

export function normalizeDealStatus(raw: unknown): { label: string; canon: DealStatusCanon } | null {
  const label = cleanText(raw);
  if (label === null) return null;
  const k = key(label);
  let canon: DealStatusCanon = 'unknown';
  if (/^won|closedwon/.test(k)) canon = 'won';
  else if (/^dead|lost|closedlost/.test(k)) canon = 'dead';
  else if (/hold/.test(k)) canon = 'on_hold';
  else if (/^open|active|inprogress/.test(k)) canon = 'open';
  return { label, canon };
}

/* --------------------------- Execution status ---------------------------- */

export function normalizeExecutionStatus(
  raw: unknown,
): { label: string; canon: ExecutionStatusCanon } | null {
  const label = cleanText(raw);
  if (label === null) return null;
  const k = key(label);
  let canon: ExecutionStatusCanon = 'unknown';
  if (/notstarted|yettostart/.test(k)) canon = 'not_started';
  else if (/partial/.test(k)) canon = 'partial';
  else if (/pause|struck|stuck|hold/.test(k)) canon = 'paused';
  else if (/detailspending|pendingfromclient|awaitingclient/.test(k)) canon = 'blocked_on_client';
  else if (/executeduntil|ongoing|inprogress|running/.test(k)) canon = 'ongoing';
  else if (/complete/.test(k)) canon = 'completed';
  return { label, canon };
}

/** Execution states that represent live, revenue-generating delivery work. */
export const ACTIVE_EXECUTION: ReadonlySet<ExecutionStatusCanon> = new Set([
  'ongoing',
  'partial',
  'not_started',
]);

/* --------------------------------- Sector -------------------------------- */

/**
 * Sector labels are close to consistent across the two boards but differ in
 * casing/spacing, and the boards use slightly different vocabularies
 * (Deals adds DSP, Tender, Aviation, Manufacturing, Security and Surveillance).
 * We canonicalise to Title Case and keep unknown values as-is rather than
 * forcing them into "Others" — silently reclassifying data would distort
 * sector analysis.
 */
const SECTOR_CANON: Record<string, string> = {
  mining: 'Mining',
  powerline: 'Powerline',
  powerlines: 'Powerline',
  transmission: 'Powerline',
  renewables: 'Renewables',
  renewable: 'Renewables',
  solar: 'Renewables',
  railways: 'Railways',
  railway: 'Railways',
  rail: 'Railways',
  construction: 'Construction',
  infra: 'Construction',
  infrastructure: 'Construction',
  aviation: 'Aviation',
  manufacturing: 'Manufacturing',
  dsp: 'DSP',
  tender: 'Tender',
  tenders: 'Tender',
  securityandsurveillance: 'Security and Surveillance',
  surveillance: 'Security and Surveillance',
  security: 'Security and Surveillance',
  others: 'Others',
  other: 'Others',
  misc: 'Others',
};

export function normalizeSector(raw: unknown): string | null {
  const label = cleanText(raw);
  if (label === null) return null;
  const canon = SECTOR_CANON[key(label)];
  if (canon) return canon;
  // Unrecognised sector: keep it, Title-Cased, so it stays visible in reports.
  return label
    .split(/\s+/)
    .map((w) => (w.length > 3 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toUpperCase()))
    .join(' ');
}

/* --------------------------- Closure probability -------------------------- */

/**
 * The board stores probability as High/Medium/Low, not a percentage. To produce
 * a weighted pipeline figure we must attach numbers. These weights are an
 * explicit modelling ASSUMPTION, surfaced with every weighted figure the agent
 * reports so a founder never mistakes them for CRM-derived probabilities.
 */
export const PROBABILITY_WEIGHTS = { high: 0.8, medium: 0.5, low: 0.2 } as const;

export type ProbabilityCanon = keyof typeof PROBABILITY_WEIGHTS;

export function normalizeProbability(
  raw: unknown,
): { label: string; canon: ProbabilityCanon; weight: number } | null {
  const label = cleanText(raw);
  if (label === null) return null;
  const k = key(label);
  let canon: ProbabilityCanon | null = null;
  if (/^high|^h$|verylikely/.test(k)) canon = 'high';
  else if (/^medium|^med|^m$/.test(k)) canon = 'medium';
  else if (/^low|^l$/.test(k)) canon = 'low';
  if (!canon) return null;
  return { label, canon, weight: PROBABILITY_WEIGHTS[canon] };
}

/**
 * Entity-name normalisation used for cross-board joins and grouping.
 * Case, punctuation and whitespace differences are collapsed; the display name
 * keeps its original form.
 */
export function nameKey(raw: unknown): string | null {
  const t = cleanText(raw);
  if (t === null) return null;
  const k = t
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|corp|co)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
  return k || null;
}
