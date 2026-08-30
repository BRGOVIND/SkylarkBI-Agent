import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as XLSX from 'xlsx';
import { normalizeDeals, normalizeWorkOrders } from '@/lib/normalize';
import {
  pipelineMetrics,
  operationalMetrics,
  sectorAnalysis,
  crossBoardAnalysis,
  riskAnalysis,
  leadershipUpdate,
} from '@/lib/analytics';
import type { RawBoard } from '@/lib/monday/fetch';
import type { BusinessDataset } from '@/lib/normalize/types';

/**
 * End-to-end verification against the ACTUAL supplied spreadsheets.
 *
 * These files are the assignment's sample data. They are NOT bundled into the
 * application — the app only ever reads monday.com. They are used here as a
 * fixture to prove the normalisation and analytics layers behave correctly on
 * the real mess (repeated header rows, duplicates, blanks, mixed formats)
 * before that data is ever loaded into monday.com.
 *
 * The suite skips itself when the files are not present, so CI and other
 * machines are unaffected.
 */

const DEALS_XLSX = process.env.FIXTURE_DEALS ?? 'C:\\Users\\LOQ\\Downloads\\Deal funnel Data.xlsx';
const WO_XLSX = process.env.FIXTURE_WORK_ORDERS ?? 'C:\\Users\\LOQ\\Downloads\\Work_Order_Tracker Data.xlsx';

const available = fs.existsSync(DEALS_XLSX) && fs.existsSync(WO_XLSX);
const maybe = available ? describe : describe.skip;

/** Converts a spreadsheet into the exact shape `fetchBoard` returns. */
function sheetAsBoard(file: string, boardId: string, boardName: string): RawBoard {
  const wb = XLSX.readFile(file, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, raw: false });

  let headerIdx = 0;
  let best = -1;
  for (let i = 0; i < Math.min(5, grid.length); i++) {
    const filled = (grid[i] ?? []).filter((c) => String(c ?? '').trim()).length;
    if (filled > best) {
      best = filled;
      headerIdx = i;
    }
  }
  const headers = (grid[headerIdx] ?? []).map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);

  const items = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (!row.some((c) => String(c ?? '').trim())) continue;
    const values: Record<string, string | null> = {};
    headers.forEach((h, i) => {
      const v = String(row[i] ?? '').trim();
      values[h] = v === '' ? null : v;
    });
    items.push({ id: String(items.length + 1), name: values[headers[0]] ?? '', values });
  }

  return {
    boardId,
    boardName,
    columns: headers.map((t, i) => ({ id: `c${i}`, title: t, type: 'text' })),
    items,
    truncated: false,
  };
}

maybe('end-to-end against the supplied spreadsheets', () => {
  const dealsSet = normalizeDeals(sheetAsBoard(DEALS_XLSX, '1', 'Deals'));
  const woSet = normalizeWorkOrders(sheetAsBoard(WO_XLSX, '2', 'Work Orders'));
  const data: BusinessDataset = {
    deals: dealsSet.deals,
    workOrders: woSet.workOrders,
    quality: { deals: dealsSet.quality, workOrders: woSet.quality },
    fetchedAt: new Date().toISOString(),
  };

  it('resolves every expected column on both boards', () => {
    expect(dealsSet.quality.unresolvedColumns).toEqual([]);
    expect(woSet.quality.unresolvedColumns).toEqual([]);
  });

  it('removes the repeated header rows embedded in the deals data', () => {
    // The source file echoes its header at two points inside the data.
    expect(dealsSet.quality.headerRowsDropped).toBeGreaterThanOrEqual(2);
  });

  it('removes the duplicate deal rows', () => {
    expect(dealsSet.quality.duplicateRowsDropped).toBeGreaterThanOrEqual(12);
  });

  it('keeps the large majority of rows as usable records', () => {
    expect(dealsSet.deals.length).toBeGreaterThan(300);
    expect(woSet.workOrders.length).toBeGreaterThan(150);
  });

  it('parses every deal value that is present, with none malformed', () => {
    const v = dealsSet.quality.fields.find((f) => f.field === 'dealValue');
    expect(v).toBeDefined();
    expect(v!.malformed).toBe(0);
    expect(v!.present).toBeGreaterThan(100);
    // A large share genuinely have no value — that is the real data, and the
    // agent must disclose it rather than treat blanks as zero.
    expect(v!.missing).toBeGreaterThan(100);
  });

  it('parses every date that is present, with none malformed', () => {
    for (const f of ['createdDate', 'tentativeCloseDate', 'actualCloseDate']) {
      expect(dealsSet.quality.fields.find((x) => x.field === f)?.malformed).toBe(0);
    }
    for (const f of ['poDate', 'probableStartDate', 'probableEndDate']) {
      expect(woSet.quality.fields.find((x) => x.field === f)?.malformed).toBe(0);
    }
  });

  it('classifies every deal stage into a known bucket', () => {
    const unknown = dealsSet.deals.filter((d) => d.stageLabel && d.stageBucket === 'unknown');
    expect(unknown).toEqual([]);
  });

  it('classifies every execution status into a known bucket', () => {
    const unknown = woSet.workOrders.filter(
      (w) => w.executionStatusLabel && w.executionStatus === 'unknown',
    );
    expect(unknown).toEqual([]);
  });

  it('canonicalises sectors to the known vocabulary', () => {
    const known = new Set([
      'Mining', 'Powerline', 'Renewables', 'Railways', 'Construction', 'Others',
      'Aviation', 'Manufacturing', 'DSP', 'Tender', 'Security and Surveillance',
    ]);
    for (const d of dealsSet.deals) if (d.sector) expect(known.has(d.sector)).toBe(true);
    for (const w of woSet.workOrders) if (w.sector) expect(known.has(w.sector)).toBe(true);
  });

  it('produces a pipeline value that equals the sum of its open deals', () => {
    const m = pipelineMetrics(data.deals);
    const manual = data.deals
      .filter((d) => d.stageBucket === 'open' && d.dealValue !== null)
      .reduce((s, d) => s + (d.dealValue as number), 0);
    expect(m.openPipelineValue).toBeCloseTo(Math.round(manual * 100) / 100, 2);
    expect(m.openPipelineCoverage.counted + m.openPipelineCoverage.excluded).toBe(
      m.openPipelineCoverage.matched,
    );
  });

  it('never counts a deal in more than one pipeline bucket', () => {
    const m = pipelineMetrics(data.deals);
    expect(m.openDeals + m.wonDeals + m.lostDeals + m.onHoldDeals).toBeLessThanOrEqual(m.totalDeals);
  });

  it('produces an order book equal to the sum of work order values', () => {
    const o = operationalMetrics(data.workOrders);
    const manual = data.workOrders
      .filter((w) => w.orderValueExGst !== null)
      .reduce((s, w) => s + (w.orderValueExGst as number), 0);
    expect(o.orderBookValue).toBeCloseTo(Math.round(manual * 100) / 100, 2);
  });

  it('sector totals reconcile with the overall pipeline total', () => {
    const a = sectorAnalysis(data);
    const sectorSum = a.rows.reduce((s, r) => s + r.openPipelineValue, 0);
    const overall = pipelineMetrics(data.deals).openPipelineValue;
    expect(sectorSum).toBeCloseTo(overall, 2);
  });

  it('joins a meaningful number of accounts across the two boards', () => {
    const c = crossBoardAnalysis(data);
    // The boards share masked deal names; roughly 50 of the ~58 work order
    // names appear on the deals board.
    expect(c.both).toBeGreaterThan(30);
    expect(c.matchKey).toBe('normalised deal name');
  });

  it('detects real operational risks in the data', () => {
    const r = riskAnalysis(data);
    expect(r.risks.length).toBeGreaterThan(0);
    const kinds = new Set(r.risks.map((x) => x.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });

  it('builds a complete leadership update from the real data', () => {
    const u = leadershipUpdate(data, 'all_time');
    expect(u.headline.openPipelineValue).toBeGreaterThan(0);
    expect(u.headline.orderBookValue).toBeGreaterThan(0);
    expect(u.topSectors.length).toBeGreaterThan(0);
    expect(u.topOpenDeals.length).toBeGreaterThan(0);
    expect(u.dataQuality.length).toBeGreaterThan(0);
  });

  it('surfaces data-quality warnings rather than hiding them', () => {
    const all = [...dealsSet.quality.warnings, ...woSet.quality.warnings].join(' ');
    expect(all).toMatch(/duplicate/i);
    expect(all).toMatch(/no deal value/i);
  });
});
