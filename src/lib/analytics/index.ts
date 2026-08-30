import type { NormalizedDeal, NormalizedWorkOrder, BusinessDataset } from '../normalize/types';
import { ACTIVE_EXECUTION, PROBABILITY_WEIGHTS } from '../normalize/taxonomy';
import { inPeriod, resolvePeriod, type Period, type PeriodName } from './period';

export * from './period';

/**
 * All business arithmetic lives here, in deterministic TypeScript. The language
 * model selects and interprets these functions but never computes the numbers
 * itself.
 *
 * Every aggregate that sums a nullable field also reports coverage: how many
 * records contributed and how many were excluded for lack of data. That pairing
 * is what lets the agent state a figure without overstating its reliability.
 */

export interface Coverage {
  /** Records matching the filter. */
  matched: number;
  /** Records that had a usable value and contributed to the total. */
  counted: number;
  /** Records excluded because the value was missing/unparseable. */
  excluded: number;
}

function sumWithCoverage(
  values: Array<number | null>,
): { total: number; coverage: Coverage } {
  let total = 0;
  let counted = 0;
  for (const v of values) {
    if (v === null) continue;
    total += v;
    counted++;
  }
  return {
    total: round(total),
    coverage: { matched: values.length, counted, excluded: values.length - counted },
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

function dateRange(values: Array<string | null>): { from: string; to: string } | null {
  const d = values.filter((v): v is string => !!v).sort();
  return d.length ? { from: d[0], to: d[d.length - 1] } : null;
}

/**
 * A period filter that matches nothing is the single easiest way for a BI agent
 * to report a confidently wrong "zero". When it happens we say what date range
 * the board actually covers, so the agent explains the gap instead of implying
 * the business did nothing.
 */
function emptyPeriodCaveat(
  matched: number,
  totalRecords: number,
  period: Period | null,
  range: { from: string; to: string } | null,
  noun: string,
): string | null {
  if (matched > 0 || totalRecords === 0 || !period) return null;
  const where = range ? ` The board's ${noun} range from ${range.from} to ${range.to}.` : '';
  return `No records fall in ${period.label} (${period.start} to ${period.end}), although the board holds ${totalRecords} ${noun}.${where} This is a gap in the data's coverage, not necessarily an absence of business activity.`;
}

/* ------------------------------ Filtering -------------------------------- */

export interface DealFilter {
  sector?: string;
  status?: string;
  stageBucket?: string;
  ownerCode?: string;
  clientCode?: string;
  probability?: string;
  /** Which date field the period applies to. */
  dateField?: 'createdDate' | 'tentativeCloseDate' | 'actualCloseDate';
  period?: PeriodName;
  minValue?: number;
}

export interface WorkOrderFilter {
  sector?: string;
  executionStatus?: string;
  ownerCode?: string;
  customerCode?: string;
  dateField?: 'poDate' | 'probableStartDate' | 'probableEndDate' | 'lastInvoiceDate';
  period?: PeriodName;
}

const eqi = (a: string | null, b: string | undefined) =>
  b === undefined || (a !== null && a.toLowerCase() === b.toLowerCase());

export function filterDeals(
  deals: NormalizedDeal[],
  f: DealFilter,
  ref: Date = new Date(),
): { rows: NormalizedDeal[]; period: Period | null } {
  const period = f.period ? resolvePeriod(f.period, ref) : null;
  const field = f.dateField ?? 'createdDate';
  const rows = deals.filter((d) => {
    if (!eqi(d.sector, f.sector)) return false;
    if (!eqi(d.status, f.status)) return false;
    if (!eqi(d.stageBucket, f.stageBucket)) return false;
    if (!eqi(d.ownerCode, f.ownerCode)) return false;
    if (!eqi(d.clientCode, f.clientCode)) return false;
    if (!eqi(d.probability, f.probability)) return false;
    if (f.minValue !== undefined && (d.dealValue === null || d.dealValue < f.minValue)) return false;
    if (period && !inPeriod(d[field], period)) return false;
    return true;
  });
  return { rows, period };
}

export function filterWorkOrders(
  wos: NormalizedWorkOrder[],
  f: WorkOrderFilter,
  ref: Date = new Date(),
): { rows: NormalizedWorkOrder[]; period: Period | null } {
  const period = f.period ? resolvePeriod(f.period, ref) : null;
  const field = f.dateField ?? 'poDate';
  const rows = wos.filter((w) => {
    if (!eqi(w.sector, f.sector)) return false;
    if (!eqi(w.executionStatus, f.executionStatus)) return false;
    if (!eqi(w.ownerCode, f.ownerCode)) return false;
    if (!eqi(w.customerCode, f.customerCode)) return false;
    if (period && !inPeriod(w[field], period)) return false;
    return true;
  });
  return { rows, period };
}

/* ---------------------------- Pipeline metrics ---------------------------- */

export interface PipelineMetrics {
  period: string;
  dateBasis: string;
  totalDeals: number;
  openDeals: number;
  wonDeals: number;
  lostDeals: number;
  onHoldDeals: number;
  openPipelineValue: number;
  openPipelineCoverage: Coverage;
  weightedPipelineValue: number;
  weightedCoverage: Coverage;
  weightingAssumption: string;
  wonValue: number;
  wonCoverage: Coverage;
  winRateByCount: number | null;
  averageOpenDealValue: number | null;
  byStage: Array<{ stage: string; count: number; value: number; valueCoverage: Coverage }>;
  caveats: string[];
}

export function pipelineMetrics(
  deals: NormalizedDeal[],
  f: DealFilter = {},
  ref: Date = new Date(),
): PipelineMetrics {
  const { rows, period } = filterDeals(deals, f, ref);
  const open = rows.filter((d) => d.stageBucket === 'open');
  const won = rows.filter((d) => d.stageBucket === 'won');
  const lost = rows.filter((d) => d.stageBucket === 'lost');
  const hold = rows.filter((d) => d.stageBucket === 'on_hold');

  const openSum = sumWithCoverage(open.map((d) => d.dealValue));
  const wonSum = sumWithCoverage(won.map((d) => d.dealValue));

  // Weighted pipeline only counts deals that have BOTH a value and a
  // probability — anything else would be an invented number.
  const weightable = open.filter((d) => d.dealValue !== null && d.probabilityWeight !== null);
  const weighted = round(
    weightable.reduce((s, d) => s + (d.dealValue as number) * (d.probabilityWeight as number), 0),
  );

  const byStageMap = new Map<string, NormalizedDeal[]>();
  for (const d of rows) {
    const k = d.stageLabel ?? 'Unspecified stage';
    const arr = byStageMap.get(k);
    if (arr) arr.push(d);
    else byStageMap.set(k, [d]);
  }
  const byStage = [...byStageMap.entries()]
    .map(([stage, ds]) => {
      const s = sumWithCoverage(ds.map((d) => d.dealValue));
      return { stage, count: ds.length, value: s.total, valueCoverage: s.coverage };
    })
    .sort((a, b) => b.value - a.value);

  const decided = won.length + lost.length;
  const caveats: string[] = [];
  if (openSum.coverage.excluded) {
    caveats.push(
      `Open pipeline value is based on ${openSum.coverage.counted} of ${openSum.coverage.matched} open deals; ${openSum.coverage.excluded} have no deal value recorded.`,
    );
  }
  if (open.length - weightable.length > 0) {
    caveats.push(
      `Weighted pipeline covers ${weightable.length} of ${open.length} open deals — the rest lack a value, a closure probability, or both.`,
    );
  }
  if (decided === 0) {
    caveats.push('No won or lost deals in this selection, so a win rate cannot be computed.');
  }
  const emptyPeriod = emptyPeriodCaveat(
    rows.length,
    deals.length,
    period,
    dateRange(deals.map((d) => d[f.dateField ?? 'createdDate'])),
    `deal ${f.dateField ?? 'createdDate'} values`,
  );
  if (emptyPeriod) caveats.unshift(emptyPeriod);

  return {
    period: period?.label ?? 'all time',
    dateBasis: f.dateField ?? 'createdDate',
    totalDeals: rows.length,
    openDeals: open.length,
    wonDeals: won.length,
    lostDeals: lost.length,
    onHoldDeals: hold.length,
    openPipelineValue: openSum.total,
    openPipelineCoverage: openSum.coverage,
    weightedPipelineValue: weighted,
    weightedCoverage: {
      matched: open.length,
      counted: weightable.length,
      excluded: open.length - weightable.length,
    },
    weightingAssumption: `High=${PROBABILITY_WEIGHTS.high}, Medium=${PROBABILITY_WEIGHTS.medium}, Low=${PROBABILITY_WEIGHTS.low} (assumed; the board stores probability as a label, not a percentage)`,
    wonValue: wonSum.total,
    wonCoverage: wonSum.coverage,
    winRateByCount: decided ? pct(won.length, decided) : null,
    averageOpenDealValue: openSum.coverage.counted
      ? round(openSum.total / openSum.coverage.counted)
      : null,
    byStage,
    caveats,
  };
}

/* ----------------------------- Sector analysis ---------------------------- */

export interface SectorRow {
  sector: string;
  dealCount: number;
  openDeals: number;
  wonDeals: number;
  lostDeals: number;
  openPipelineValue: number;
  openValueCoverage: Coverage;
  wonValue: number;
  winRateByCount: number | null;
  workOrderCount: number;
  orderBookValue: number;
  orderBookCoverage: Coverage;
  billedValue: number;
  activeWorkOrders: number;
}

export interface SectorAnalysis {
  period: string;
  rows: SectorRow[];
  caveats: string[];
}

export function sectorAnalysis(
  data: { deals: NormalizedDeal[]; workOrders: NormalizedWorkOrder[] },
  f: DealFilter = {},
  ref: Date = new Date(),
): SectorAnalysis {
  const { rows: deals, period } = filterDeals(data.deals, f, ref);
  const woFilter: WorkOrderFilter = {
    sector: f.sector,
    period: f.period,
    dateField: 'poDate',
  };
  const { rows: wos } = filterWorkOrders(data.workOrders, woFilter, ref);

  const sectors = new Set<string>();
  for (const d of deals) sectors.add(d.sector ?? 'Unspecified');
  for (const w of wos) sectors.add(w.sector ?? 'Unspecified');

  const rows: SectorRow[] = [...sectors].map((sector) => {
    const ds = deals.filter((d) => (d.sector ?? 'Unspecified') === sector);
    const ws = wos.filter((w) => (w.sector ?? 'Unspecified') === sector);
    const open = ds.filter((d) => d.stageBucket === 'open');
    const won = ds.filter((d) => d.stageBucket === 'won');
    const lost = ds.filter((d) => d.stageBucket === 'lost');
    const openSum = sumWithCoverage(open.map((d) => d.dealValue));
    const wonSum = sumWithCoverage(won.map((d) => d.dealValue));
    const orderSum = sumWithCoverage(ws.map((w) => w.orderValueExGst));
    const billedSum = sumWithCoverage(ws.map((w) => w.billedExGst));
    const decided = won.length + lost.length;
    return {
      sector,
      dealCount: ds.length,
      openDeals: open.length,
      wonDeals: won.length,
      lostDeals: lost.length,
      openPipelineValue: openSum.total,
      openValueCoverage: openSum.coverage,
      wonValue: wonSum.total,
      winRateByCount: decided ? pct(won.length, decided) : null,
      workOrderCount: ws.length,
      orderBookValue: orderSum.total,
      orderBookCoverage: orderSum.coverage,
      billedValue: billedSum.total,
      activeWorkOrders: ws.filter((w) => ACTIVE_EXECUTION.has(w.executionStatus)).length,
    };
  });

  rows.sort((a, b) => b.openPipelineValue - a.openPipelineValue || b.dealCount - a.dealCount);

  const caveats: string[] = [];
  const unspecified = rows.find((r) => r.sector === 'Unspecified');
  if (unspecified) {
    caveats.push(
      `${unspecified.dealCount} deal(s) and ${unspecified.workOrderCount} work order(s) have no sector recorded and are grouped as "Unspecified" rather than redistributed.`,
    );
  }
  caveats.push(
    'Sector comparisons mix deal counts with values; sectors with many low-value or value-less deals can rank differently by count than by value.',
  );

  return { period: period?.label ?? 'all time', rows, caveats };
}

/* --------------------------- Operational metrics -------------------------- */

export interface OperationalMetrics {
  period: string;
  totalWorkOrders: number;
  byExecutionStatus: Array<{ status: string; count: number; orderValue: number }>;
  activeWorkOrders: number;
  completedWorkOrders: number;
  orderBookValue: number;
  orderBookCoverage: Coverage;
  billedValue: number;
  billedCoverage: Coverage;
  collectedValue: number;
  collectedCoverage: Coverage;
  unbilledValue: number;
  unbilledCoverage: Coverage;
  receivableValue: number;
  receivableCoverage: Coverage;
  billedPctOfOrderBook: number | null;
  collectedPctOfBilled: number | null;
  arPriorityAccounts: number;
  caveats: string[];
}

export function operationalMetrics(
  wos: NormalizedWorkOrder[],
  f: WorkOrderFilter = {},
  ref: Date = new Date(),
): OperationalMetrics {
  const { rows, period } = filterWorkOrders(wos, f, ref);

  const order = sumWithCoverage(rows.map((w) => w.orderValueExGst));
  const billed = sumWithCoverage(rows.map((w) => w.billedExGst));
  const collected = sumWithCoverage(rows.map((w) => w.collectedInclGst));
  const unbilled = sumWithCoverage(rows.map((w) => w.toBillExGst));
  const receivable = sumWithCoverage(rows.map((w) => w.receivable));

  const statusMap = new Map<string, NormalizedWorkOrder[]>();
  for (const w of rows) {
    const k = w.executionStatusLabel ?? 'Unspecified';
    const arr = statusMap.get(k);
    if (arr) arr.push(w);
    else statusMap.set(k, [w]);
  }

  const caveats: string[] = [];
  if (order.coverage.excluded) {
    caveats.push(
      `Order book covers ${order.coverage.counted} of ${order.coverage.matched} work orders; ${order.coverage.excluded} have no order value.`,
    );
  }
  if (collected.coverage.excluded) {
    caveats.push(
      `Collections cover ${collected.coverage.counted} of ${collected.coverage.matched} work orders; the rest have no collection figure recorded, so collected totals are a floor, not a complete picture.`,
    );
  }
  caveats.push(
    'Order book and billed figures are excluding GST; collections and receivables are including GST, so the two are not directly comparable.',
  );
  const emptyPeriod = emptyPeriodCaveat(
    rows.length,
    wos.length,
    period,
    dateRange(wos.map((w) => w[f.dateField ?? 'poDate'])),
    `work order ${f.dateField ?? 'poDate'} values`,
  );
  if (emptyPeriod) caveats.unshift(emptyPeriod);

  return {
    period: period?.label ?? 'all time',
    totalWorkOrders: rows.length,
    byExecutionStatus: [...statusMap.entries()]
      .map(([status, ws]) => ({
        status,
        count: ws.length,
        orderValue: sumWithCoverage(ws.map((w) => w.orderValueExGst)).total,
      }))
      .sort((a, b) => b.count - a.count),
    activeWorkOrders: rows.filter((w) => ACTIVE_EXECUTION.has(w.executionStatus)).length,
    completedWorkOrders: rows.filter((w) => w.executionStatus === 'completed').length,
    orderBookValue: order.total,
    orderBookCoverage: order.coverage,
    billedValue: billed.total,
    billedCoverage: billed.coverage,
    collectedValue: collected.total,
    collectedCoverage: collected.coverage,
    unbilledValue: unbilled.total,
    unbilledCoverage: unbilled.coverage,
    receivableValue: receivable.total,
    receivableCoverage: receivable.coverage,
    billedPctOfOrderBook: order.total ? pct(billed.total, order.total) : null,
    collectedPctOfBilled: billed.total ? pct(collected.total, billed.total) : null,
    arPriorityAccounts: rows.filter((w) => w.arPriority).length,
    caveats,
  };
}

/* -------------------------------- Risks ---------------------------------- */

export interface RiskItem {
  kind: string;
  severity: 'high' | 'medium' | 'low';
  entity: string;
  detail: string;
  value: number | null;
}

export interface RiskReport {
  asOf: string;
  risks: RiskItem[];
  summary: Array<{ kind: string; count: number; exposure: number }>;
  caveats: string[];
}

/**
 * Rule-based risk detection. Thresholds are explicit and reported alongside the
 * findings so the founder can calibrate rather than trust a black box.
 */
export function riskAnalysis(data: BusinessDataset, ref: Date = new Date()): RiskReport {
  const today = ref.toISOString().slice(0, 10);
  const risks: RiskItem[] = [];

  for (const d of data.deals) {
    if (d.stageBucket !== 'open') continue;

    if (d.tentativeCloseDate && d.tentativeCloseDate < today) {
      risks.push({
        kind: 'Deal past expected close date',
        severity: d.probability === 'high' ? 'high' : 'medium',
        entity: d.dealName ?? `Deal ${d.itemId}`,
        detail: `Still open with a tentative close date of ${d.tentativeCloseDate}, which has passed. Stage: ${d.stageLabel ?? 'unknown'}.`,
        value: d.dealValue,
      });
    }
    if (d.dealValue === null) {
      risks.push({
        kind: 'Open deal with no value',
        severity: 'low',
        entity: d.dealName ?? `Deal ${d.itemId}`,
        detail: `Open at stage "${d.stageLabel ?? 'unknown'}" but no deal value is recorded, so it is invisible to pipeline totals.`,
        value: null,
      });
    }
    if (d.tentativeCloseDate === null && d.dealValue !== null) {
      risks.push({
        kind: 'Open deal with no close date',
        severity: 'low',
        entity: d.dealName ?? `Deal ${d.itemId}`,
        detail: 'Open deal with a value but no tentative close date, so it cannot be forecast into any period.',
        value: d.dealValue,
      });
    }
  }

  for (const w of data.workOrders) {
    if (w.probableEndDate && w.probableEndDate < today && ACTIVE_EXECUTION.has(w.executionStatus)) {
      risks.push({
        kind: 'Work order overdue',
        severity: 'high',
        entity: w.dealName ?? w.serial ?? `WO ${w.itemId}`,
        detail: `Execution status is "${w.executionStatusLabel}" but the probable end date ${w.probableEndDate} has passed.`,
        value: w.orderValueExGst,
      });
    }
    if (w.executionStatus === 'paused') {
      risks.push({
        kind: 'Work order paused or stuck',
        severity: 'high',
        entity: w.dealName ?? w.serial ?? `WO ${w.itemId}`,
        detail: `Execution status is "${w.executionStatusLabel}".`,
        value: w.orderValueExGst,
      });
    }
    if (w.executionStatus === 'blocked_on_client') {
      risks.push({
        kind: 'Blocked awaiting client',
        severity: 'medium',
        entity: w.dealName ?? w.serial ?? `WO ${w.itemId}`,
        detail: `Execution status is "${w.executionStatusLabel}" — delivery cannot progress without client input.`,
        value: w.orderValueExGst,
      });
    }
    if (w.receivable !== null && w.receivable > 0 && w.arPriority) {
      risks.push({
        kind: 'Priority receivable outstanding',
        severity: 'high',
        entity: w.dealName ?? w.serial ?? `WO ${w.itemId}`,
        detail: 'Flagged as an AR priority account with an outstanding receivable balance.',
        value: w.receivable,
      });
    }
    if (w.invoiceStatus && /stuck/i.test(w.invoiceStatus)) {
      risks.push({
        kind: 'Invoicing stuck',
        severity: 'medium',
        entity: w.dealName ?? w.serial ?? `WO ${w.itemId}`,
        detail: `Invoice status is "${w.invoiceStatus}".`,
        value: w.toBillExGst,
      });
    }
    if (
      w.executionStatus === 'completed' &&
      w.toBillExGst !== null &&
      w.toBillExGst > 0
    ) {
      risks.push({
        kind: 'Completed but not fully billed',
        severity: 'medium',
        entity: w.dealName ?? w.serial ?? `WO ${w.itemId}`,
        detail: 'Delivery is complete but an amount remains to be billed.',
        value: w.toBillExGst,
      });
    }
  }

  const order: Record<RiskItem['severity'], number> = { high: 0, medium: 1, low: 2 };
  risks.sort(
    (a, b) => order[a.severity] - order[b.severity] || (b.value ?? 0) - (a.value ?? 0),
  );

  const summaryMap = new Map<string, { count: number; exposure: number }>();
  for (const r of risks) {
    const s = summaryMap.get(r.kind) ?? { count: 0, exposure: 0 };
    s.count++;
    s.exposure += r.value ?? 0;
    summaryMap.set(r.kind, s);
  }

  return {
    asOf: today,
    risks,
    summary: [...summaryMap.entries()]
      .map(([kind, s]) => ({ kind, count: s.count, exposure: round(s.exposure) }))
      .sort((a, b) => b.exposure - a.exposure),
    caveats: [
      'Risks are derived from rules over board fields, not from a predictive model.',
      'Overdue detection depends on date fields being maintained; records with missing dates cannot be flagged and may hide real risk.',
      'Exposure sums only records that carry a value; value-less records are counted but contribute nothing to exposure.',
    ],
  };
}

/* --------------------------- Cross-board analysis ------------------------- */

export interface CustomerView {
  name: string;
  dealNames: string[];
  clientCodes: string[];
  customerCodes: string[];
  openDeals: number;
  openPipelineValue: number;
  wonDeals: number;
  workOrders: number;
  activeWorkOrders: number;
  orderBookValue: number;
  billedValue: number;
  receivableValue: number;
  hasBoth: boolean;
}

export interface CrossBoardAnalysis {
  matchKey: string;
  customers: CustomerView[];
  dealsOnly: number;
  workOrdersOnly: number;
  both: number;
  caveats: string[];
}

/**
 * The two boards do NOT share a customer identifier: Deals use COMPANYnnn codes
 * and Work Orders use WOCOMPANY_nnn codes, which are different code spaces.
 * The only reliable link is the (masked) deal name, which appears on both
 * boards. We join on a normalised deal name and say so explicitly, because the
 * join is the single most assumption-laden step in the whole system.
 */
export function crossBoardAnalysis(data: BusinessDataset): CrossBoardAnalysis {
  const byKey = new Map<
    string,
    { display: string; deals: NormalizedDeal[]; wos: NormalizedWorkOrder[] }
  >();

  const bucket = (k: string | null, display: string | null) => {
    if (!k) return null;
    let b = byKey.get(k);
    if (!b) {
      b = { display: display ?? k, deals: [], wos: [] };
      byKey.set(k, b);
    }
    return b;
  };

  for (const d of data.deals) bucket(d.dealNameKey, d.dealName)?.deals.push(d);
  for (const w of data.workOrders) bucket(w.dealNameKey, w.dealName)?.wos.push(w);

  const customers: CustomerView[] = [...byKey.values()].map((b) => {
    const open = b.deals.filter((d) => d.stageBucket === 'open');
    return {
      name: b.display,
      dealNames: [...new Set(b.deals.map((d) => d.dealName).filter((x): x is string => !!x))],
      clientCodes: [...new Set(b.deals.map((d) => d.clientCode).filter((x): x is string => !!x))],
      customerCodes: [...new Set(b.wos.map((w) => w.customerCode).filter((x): x is string => !!x))],
      openDeals: open.length,
      openPipelineValue: sumWithCoverage(open.map((d) => d.dealValue)).total,
      wonDeals: b.deals.filter((d) => d.stageBucket === 'won').length,
      workOrders: b.wos.length,
      activeWorkOrders: b.wos.filter((w) => ACTIVE_EXECUTION.has(w.executionStatus)).length,
      orderBookValue: sumWithCoverage(b.wos.map((w) => w.orderValueExGst)).total,
      billedValue: sumWithCoverage(b.wos.map((w) => w.billedExGst)).total,
      receivableValue: sumWithCoverage(b.wos.map((w) => w.receivable)).total,
      hasBoth: b.deals.length > 0 && b.wos.length > 0,
    };
  });

  customers.sort(
    (a, b) =>
      Number(b.hasBoth) - Number(a.hasBoth) ||
      b.openPipelineValue + b.orderBookValue - (a.openPipelineValue + a.orderBookValue),
  );

  return {
    matchKey: 'normalised deal name',
    customers,
    dealsOnly: customers.filter((c) => c.workOrders === 0).length,
    workOrdersOnly: customers.filter((c) => c.openDeals === 0 && c.wonDeals === 0).length,
    both: customers.filter((c) => c.hasBoth).length,
    caveats: [
      'The Deals and Work Orders boards use different customer code spaces (e.g. COMPANY089 vs WOCOMPANY_002), so they are joined on the masked deal name instead.',
      'Deal names are not unique on the Deals board — the same name can cover several deals — so a "customer" here means all records sharing a deal name, which may over-group.',
      'Work orders whose deal name never appears on the Deals board are reported separately rather than dropped.',
    ],
  };
}

/* ---------------------------- Leadership update --------------------------- */

export interface LeadershipUpdate {
  generatedAt: string;
  period: string;
  headline: {
    openPipelineValue: number;
    weightedPipelineValue: number;
    openDeals: number;
    orderBookValue: number;
    billedValue: number;
    collectedValue: number;
    receivableValue: number;
    activeWorkOrders: number;
  };
  pipeline: PipelineMetrics;
  operations: OperationalMetrics;
  topSectors: SectorRow[];
  topOpenDeals: Array<{ name: string; sector: string | null; value: number; stage: string | null; probability: string | null; closeDate: string | null }>;
  risks: RiskReport;
  crossBoard: { customersWithBoth: number; topAccounts: CustomerView[] };
  dataQuality: string[];
}

/**
 * Assembles every deterministic figure a leadership update needs, in one call.
 * The narrative is written by the model from this structure; the numbers are
 * not the model's to invent.
 */
export function leadershipUpdate(
  data: BusinessDataset,
  period: PeriodName = 'this_quarter',
  ref: Date = new Date(),
): LeadershipUpdate {
  const pipeline = pipelineMetrics(data.deals, { period, dateField: 'createdDate' }, ref);
  const operations = operationalMetrics(data.workOrders, {}, ref);
  const sectors = sectorAnalysis(data, {}, ref);
  const risks = riskAnalysis(data, ref);
  const cross = crossBoardAnalysis(data);

  const topOpenDeals = data.deals
    .filter((d) => d.stageBucket === 'open' && d.dealValue !== null)
    .sort((a, b) => (b.dealValue as number) - (a.dealValue as number))
    .slice(0, 10)
    .map((d) => ({
      name: d.dealName ?? `Deal ${d.itemId}`,
      sector: d.sector,
      value: d.dealValue as number,
      stage: d.stageLabel,
      probability: d.probabilityLabel,
      closeDate: d.tentativeCloseDate,
    }));

  const dataQuality = [
    ...data.quality.deals.warnings,
    ...data.quality.workOrders.warnings,
    ...pipeline.caveats,
    ...operations.caveats,
  ];

  return {
    generatedAt: new Date().toISOString(),
    period: pipeline.period,
    headline: {
      openPipelineValue: pipeline.openPipelineValue,
      weightedPipelineValue: pipeline.weightedPipelineValue,
      openDeals: pipeline.openDeals,
      orderBookValue: operations.orderBookValue,
      billedValue: operations.billedValue,
      collectedValue: operations.collectedValue,
      receivableValue: operations.receivableValue,
      activeWorkOrders: operations.activeWorkOrders,
    },
    pipeline,
    operations,
    topSectors: sectors.rows.slice(0, 6),
    topOpenDeals,
    risks: { ...risks, risks: risks.risks.slice(0, 15) },
    crossBoard: { customersWithBoth: cross.both, topAccounts: cross.customers.slice(0, 8) },
    dataQuality,
  };
}

/* ------------------------------ Data quality ------------------------------ */

export function dataQualitySummary(data: BusinessDataset) {
  return {
    fetchedAt: data.fetchedAt,
    deals: data.quality.deals,
    workOrders: data.quality.workOrders,
    dealsWithIssues: data.deals.filter((d) => d.issues.length).length,
    workOrdersWithIssues: data.workOrders.filter((w) => w.issues.length).length,
    sampleIssues: [
      ...data.deals.flatMap((d) => d.issues.map((i) => `Deal "${d.dealName ?? d.itemId}": ${i}`)),
      ...data.workOrders.flatMap((w) => w.issues.map((i) => `WO "${w.dealName ?? w.itemId}": ${i}`)),
    ].slice(0, 25),
  };
}
