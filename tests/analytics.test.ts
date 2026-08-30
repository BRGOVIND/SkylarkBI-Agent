import { describe, expect, it } from 'vitest';
import {
  pipelineMetrics,
  sectorAnalysis,
  operationalMetrics,
  riskAnalysis,
  crossBoardAnalysis,
  leadershipUpdate,
  filterDeals,
} from '@/lib/analytics';
import { financialQuarter, calendarQuarter, financialYear, resolvePeriod } from '@/lib/analytics/period';
import type { NormalizedDeal, NormalizedWorkOrder, BusinessDataset } from '@/lib/normalize/types';

const REF = new Date('2025-11-15T00:00:00Z');

function deal(p: Partial<NormalizedDeal>): NormalizedDeal {
  return {
    itemId: Math.random().toString(36).slice(2),
    dealName: 'Deal',
    dealNameKey: 'deal',
    ownerCode: 'OWNER_001',
    clientCode: 'COMPANY001',
    clientKey: 'company001',
    statusLabel: 'Open',
    status: 'open',
    stageLabel: 'B. Sales Qualified Leads',
    stageOrder: 2,
    stageBucket: 'open',
    sector: 'Mining',
    productDeal: null,
    probabilityLabel: null,
    probability: null,
    probabilityWeight: null,
    dealValue: null,
    createdDate: '2025-11-01',
    tentativeCloseDate: null,
    actualCloseDate: null,
    issues: [],
    ...p,
  };
}

function wo(p: Partial<NormalizedWorkOrder>): NormalizedWorkOrder {
  return {
    itemId: Math.random().toString(36).slice(2),
    serial: `S-${Math.random().toString(36).slice(2, 7)}`,
    dealName: 'Deal',
    dealNameKey: 'deal',
    customerCode: 'WOCOMPANY_001',
    ownerCode: 'OWNER_001',
    sector: 'Mining',
    natureOfWork: null,
    typeOfWork: null,
    platform: null,
    executionStatusLabel: 'Ongoing',
    executionStatus: 'ongoing',
    woStatus: null,
    invoiceStatus: null,
    billingStatus: null,
    arPriority: false,
    documentType: null,
    poDate: '2025-10-01',
    probableStartDate: null,
    probableEndDate: null,
    dataDeliveryDate: null,
    lastInvoiceDate: null,
    orderValueExGst: null,
    orderValueInclGst: null,
    billedExGst: null,
    billedInclGst: null,
    collectedInclGst: null,
    toBillExGst: null,
    receivable: null,
    qtyPerPo: null,
    qtyBilled: null,
    qtyBalance: null,
    issues: [],
    ...p,
  };
}

function dataset(deals: NormalizedDeal[], workOrders: NormalizedWorkOrder[]): BusinessDataset {
  const q = {
    board: '',
    boardId: '1',
    totalItemsFetched: 0,
    headerRowsDropped: 0,
    duplicateRowsDropped: 0,
    usableRecords: 0,
    fields: [],
    unresolvedColumns: [],
    unmappedColumns: [],
    warnings: [],
    truncated: false,
  };
  return {
    deals,
    workOrders,
    quality: { deals: { ...q, board: 'Deals' }, workOrders: { ...q, board: 'Work Orders' } },
    fetchedAt: REF.toISOString(),
  };
}

/* --------------------------------- periods -------------------------------- */

describe('period resolution', () => {
  it('treats "this quarter" as the Indian financial quarter', () => {
    // 15 Nov 2025 falls in FY26 Q3 (Oct-Dec).
    const q = financialQuarter(REF);
    expect(q.start).toBe('2025-10-01');
    expect(q.end).toBe('2025-12-31');
    expect(q.label).toContain('FY26 Q3');
  });
  it('rolls back across the financial year boundary', () => {
    const q = financialQuarter(new Date('2025-05-10T00:00:00Z'), -1);
    expect(q.start).toBe('2025-01-01');
    expect(q.end).toBe('2025-03-31');
  });
  it('offers a distinct calendar quarter', () => {
    const q = calendarQuarter(REF);
    expect(q.start).toBe('2025-10-01');
    expect(q.end).toBe('2025-12-31');
    expect(q.label).toContain('calendar');
  });
  it('computes the financial year', () => {
    const fy = financialYear(REF);
    expect(fy.start).toBe('2025-04-01');
    expect(fy.end).toBe('2026-03-31');
  });
  it('returns null for all_time', () => {
    expect(resolvePeriod('all_time', REF)).toBeNull();
  });
});

/* -------------------------------- pipeline -------------------------------- */

describe('pipelineMetrics', () => {
  it('sums only open deals into open pipeline value', () => {
    const m = pipelineMetrics(
      [
        deal({ dealValue: 100, stageBucket: 'open' }),
        deal({ dealValue: 200, stageBucket: 'open' }),
        deal({ dealValue: 900, stageBucket: 'won', stageLabel: 'G. Project Won' }),
      ],
      {},
      REF,
    );
    expect(m.openPipelineValue).toBe(300);
    expect(m.wonValue).toBe(900);
    expect(m.openDeals).toBe(2);
  });

  it('excludes value-less deals from totals and reports the exclusion', () => {
    const m = pipelineMetrics(
      [deal({ dealValue: 500 }), deal({ dealValue: null }), deal({ dealValue: null })],
      {},
      REF,
    );
    expect(m.openPipelineValue).toBe(500);
    expect(m.openPipelineCoverage).toEqual({ matched: 3, counted: 1, excluded: 2 });
    expect(m.caveats.some((c) => /2 have no deal value/.test(c))).toBe(true);
  });

  it('never treats a missing value as zero in the average', () => {
    const m = pipelineMetrics([deal({ dealValue: 400 }), deal({ dealValue: null })], {}, REF);
    // Average over the ONE deal that had a value, not over both.
    expect(m.averageOpenDealValue).toBe(400);
  });

  it('weights pipeline only where both value and probability exist', () => {
    const m = pipelineMetrics(
      [
        deal({ dealValue: 1000, probability: 'high', probabilityWeight: 0.8 }),
        deal({ dealValue: 1000, probability: 'low', probabilityWeight: 0.2 }),
        deal({ dealValue: 1000, probability: null, probabilityWeight: null }),
        deal({ dealValue: null, probability: 'high', probabilityWeight: 0.8 }),
      ],
      {},
      REF,
    );
    expect(m.weightedPipelineValue).toBe(1000); // 800 + 200
    expect(m.weightedCoverage).toEqual({ matched: 4, counted: 2, excluded: 2 });
    expect(m.weightingAssumption).toMatch(/assumed/i);
  });

  it('computes win rate from decided deals only', () => {
    const m = pipelineMetrics(
      [
        deal({ stageBucket: 'won' }),
        deal({ stageBucket: 'won' }),
        deal({ stageBucket: 'won' }),
        deal({ stageBucket: 'lost' }),
        deal({ stageBucket: 'open' }),
        deal({ stageBucket: 'on_hold' }),
      ],
      {},
      REF,
    );
    expect(m.winRateByCount).toBe(75); // 3 of 4 decided
  });

  it('returns a null win rate rather than 0 when nothing is decided', () => {
    const m = pipelineMetrics([deal({ stageBucket: 'open' })], {}, REF);
    expect(m.winRateByCount).toBeNull();
    expect(m.caveats.some((c) => /win rate cannot be computed/i.test(c))).toBe(true);
  });

  it('filters by sector case-insensitively', () => {
    const m = pipelineMetrics(
      [deal({ sector: 'Mining', dealValue: 10 }), deal({ sector: 'Railways', dealValue: 90 })],
      { sector: 'mining' },
      REF,
    );
    expect(m.openPipelineValue).toBe(10);
  });

  it('filters by period on the chosen date field', () => {
    const deals = [
      deal({ dealValue: 10, createdDate: '2025-11-05' }), // in FY26 Q3
      deal({ dealValue: 90, createdDate: '2025-06-05' }), // FY26 Q1
    ];
    const m = pipelineMetrics(deals, { period: 'this_quarter', dateField: 'createdDate' }, REF);
    expect(m.totalDeals).toBe(1);
    expect(m.openPipelineValue).toBe(10);
    expect(m.period).toContain('FY26 Q3');
  });

  it('excludes records with no date when a period filter is applied', () => {
    const { rows } = filterDeals(
      [deal({ createdDate: null }), deal({ createdDate: '2025-11-05' })],
      { period: 'this_quarter', dateField: 'createdDate' },
      REF,
    );
    expect(rows).toHaveLength(1);
  });

  it('explains an empty period instead of implying zero activity', () => {
    const m = pipelineMetrics(
      [deal({ dealValue: 100, createdDate: '2024-05-01' })],
      { period: 'this_quarter', dateField: 'createdDate' },
      REF,
    );
    expect(m.totalDeals).toBe(0);
    expect(m.openPipelineValue).toBe(0);
    expect(m.caveats[0]).toMatch(/No records fall in/);
    expect(m.caveats[0]).toMatch(/2024-05-01/);
    expect(m.caveats[0]).toMatch(/not necessarily an absence of business activity/);
  });

  it('does not add the empty-period caveat when the dataset itself is empty', () => {
    const m = pipelineMetrics([], { period: 'this_quarter' }, REF);
    expect(m.caveats.some((c) => /No records fall in/.test(c))).toBe(false);
  });

  it('handles an empty dataset without dividing by zero', () => {
    const m = pipelineMetrics([], {}, REF);
    expect(m.openPipelineValue).toBe(0);
    expect(m.averageOpenDealValue).toBeNull();
    expect(m.winRateByCount).toBeNull();
  });
});

/* --------------------------------- sectors -------------------------------- */

describe('sectorAnalysis', () => {
  it('combines deal and work-order figures per sector', () => {
    const a = sectorAnalysis(
      dataset(
        [
          deal({ sector: 'Mining', dealValue: 500 }),
          deal({ sector: 'Railways', dealValue: 100 }),
        ],
        [wo({ sector: 'Mining', orderValueExGst: 2000, billedExGst: 500 })],
      ),
      {},
      REF,
    );
    const mining = a.rows.find((r) => r.sector === 'Mining');
    expect(mining?.openPipelineValue).toBe(500);
    expect(mining?.orderBookValue).toBe(2000);
    expect(mining?.billedValue).toBe(500);
    expect(a.rows[0].sector).toBe('Mining'); // ranked by pipeline value
  });

  it('groups missing sectors as Unspecified instead of redistributing them', () => {
    const a = sectorAnalysis(dataset([deal({ sector: null, dealValue: 300 })], []), {}, REF);
    const un = a.rows.find((r) => r.sector === 'Unspecified');
    expect(un?.openPipelineValue).toBe(300);
    expect(a.caveats.some((c) => /Unspecified/.test(c))).toBe(true);
  });
});

/* ------------------------------- operations ------------------------------- */

describe('operationalMetrics', () => {
  it('computes order book, billed and collected with coverage', () => {
    const m = operationalMetrics(
      [
        wo({ orderValueExGst: 1000, billedExGst: 400, collectedInclGst: 200 }),
        wo({ orderValueExGst: 1000, billedExGst: 600, collectedInclGst: null }),
        wo({ orderValueExGst: null }),
      ],
      {},
      REF,
    );
    expect(m.orderBookValue).toBe(2000);
    expect(m.orderBookCoverage.excluded).toBe(1);
    expect(m.billedValue).toBe(1000);
    expect(m.billedPctOfOrderBook).toBe(50);
    expect(m.collectedValue).toBe(200);
    // Two of the three work orders carry no collection figure.
    expect(m.collectedCoverage.excluded).toBe(2);
  });

  it('counts active work orders across the active execution states', () => {
    const m = operationalMetrics(
      [
        wo({ executionStatus: 'ongoing' }),
        wo({ executionStatus: 'partial' }),
        wo({ executionStatus: 'not_started' }),
        wo({ executionStatus: 'completed' }),
        wo({ executionStatus: 'paused' }),
      ],
      {},
      REF,
    );
    expect(m.activeWorkOrders).toBe(3);
    expect(m.completedWorkOrders).toBe(1);
  });

  it('warns that GST bases differ', () => {
    const m = operationalMetrics([wo({ orderValueExGst: 1 })], {}, REF);
    expect(m.caveats.some((c) => /GST/.test(c))).toBe(true);
  });
});

/* ---------------------------------- risks --------------------------------- */

describe('riskAnalysis', () => {
  it('flags an active work order past its end date', () => {
    const r = riskAnalysis(
      dataset([], [wo({ probableEndDate: '2025-01-01', executionStatus: 'ongoing', orderValueExGst: 500 })]),
      REF,
    );
    const hit = r.risks.find((x) => x.kind === 'Work order overdue');
    expect(hit?.severity).toBe('high');
    expect(hit?.value).toBe(500);
  });

  it('does not flag a completed work order as overdue', () => {
    const r = riskAnalysis(
      dataset([], [wo({ probableEndDate: '2025-01-01', executionStatus: 'completed' })]),
      REF,
    );
    expect(r.risks.some((x) => x.kind === 'Work order overdue')).toBe(false);
  });

  it('flags stalled open deals past their tentative close date', () => {
    const r = riskAnalysis(
      dataset([deal({ stageBucket: 'open', tentativeCloseDate: '2025-02-01', dealValue: 100 })], []),
      REF,
    );
    expect(r.risks.some((x) => x.kind === 'Deal past expected close date')).toBe(true);
  });

  it('does not flag won deals with past close dates', () => {
    const r = riskAnalysis(
      dataset([deal({ stageBucket: 'won', tentativeCloseDate: '2025-02-01' })], []),
      REF,
    );
    expect(r.risks).toHaveLength(0);
  });

  it('flags priority receivables and stuck invoicing', () => {
    const r = riskAnalysis(
      dataset([], [wo({ arPriority: true, receivable: 5000, invoiceStatus: 'Stuck' })]),
      REF,
    );
    expect(r.risks.some((x) => x.kind === 'Priority receivable outstanding')).toBe(true);
    expect(r.risks.some((x) => x.kind === 'Invoicing stuck')).toBe(true);
  });

  it('ranks high severity first and aggregates exposure', () => {
    const r = riskAnalysis(
      dataset(
        [deal({ stageBucket: 'open', dealValue: null })],
        [wo({ executionStatus: 'paused', orderValueExGst: 900 })],
      ),
      REF,
    );
    expect(r.risks[0].severity).toBe('high');
    expect(r.summary.find((s) => s.kind === 'Work order paused or stuck')?.exposure).toBe(900);
  });
});

/* ------------------------------- cross-board ------------------------------ */

describe('crossBoardAnalysis', () => {
  it('joins the boards on normalised deal name', () => {
    const a = crossBoardAnalysis(
      dataset(
        [deal({ dealName: 'Scooby-Doo', dealNameKey: 'scoobydoo', dealValue: 300 })],
        [wo({ dealName: 'scooby doo', dealNameKey: 'scoobydoo', orderValueExGst: 700 })],
      ),
    );
    expect(a.both).toBe(1);
    const c = a.customers[0];
    expect(c.openPipelineValue).toBe(300);
    expect(c.orderBookValue).toBe(700);
    expect(c.hasBoth).toBe(true);
  });

  it('keeps accounts that appear on only one board', () => {
    const a = crossBoardAnalysis(
      dataset(
        [deal({ dealName: 'Naruto', dealNameKey: 'naruto' })],
        [wo({ dealName: 'Whale', dealNameKey: 'whale' })],
      ),
    );
    expect(a.both).toBe(0);
    expect(a.customers).toHaveLength(2);
  });

  it('states the join assumption in its caveats', () => {
    const a = crossBoardAnalysis(dataset([], []));
    expect(a.matchKey).toBe('normalised deal name');
    expect(a.caveats.some((c) => /different customer code spaces/i.test(c))).toBe(true);
  });
});

/* ---------------------------- leadership update --------------------------- */

describe('leadershipUpdate', () => {
  it('assembles headline figures, risks and caveats in one structure', () => {
    const d = dataset(
      [
        deal({ dealValue: 1000, probability: 'high', probabilityWeight: 0.8, createdDate: '2025-11-01' }),
        deal({ dealValue: 500, stageBucket: 'won', createdDate: '2025-11-02' }),
      ],
      [wo({ orderValueExGst: 4000, billedExGst: 1000, executionStatus: 'paused' })],
    );
    const u = leadershipUpdate(d, 'this_quarter', REF);
    expect(u.headline.openPipelineValue).toBe(1000);
    expect(u.headline.weightedPipelineValue).toBe(800);
    expect(u.headline.orderBookValue).toBe(4000);
    expect(u.topOpenDeals[0].value).toBe(1000);
    expect(u.risks.risks.length).toBeGreaterThan(0);
    expect(u.period).toContain('FY26 Q3');
  });

  it('produces a usable structure on an empty dataset', () => {
    const u = leadershipUpdate(dataset([], []), 'this_quarter', REF);
    expect(u.headline.openPipelineValue).toBe(0);
    expect(u.topOpenDeals).toHaveLength(0);
    expect(u.risks.risks).toHaveLength(0);
  });
});
