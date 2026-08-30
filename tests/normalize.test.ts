import { describe, expect, it } from 'vitest';
import { parseDate, parseNumber, cleanText, toISODate } from '@/lib/normalize/primitives';
import {
  normalizeSector,
  normalizeStage,
  normalizeDealStatus,
  normalizeExecutionStatus,
  normalizeProbability,
  nameKey,
} from '@/lib/normalize/taxonomy';
import { normalizeDeals, normalizeWorkOrders } from '@/lib/normalize';
import type { RawBoard } from '@/lib/monday/fetch';

describe('cleanText', () => {
  it('maps null sentinels to null', () => {
    for (const v of ['', '  ', '-', 'N/A', 'n/a', 'NULL', 'none', 'TBD', '#N/A', 'unknown']) {
      expect(cleanText(v)).toBeNull();
    }
  });
  it('collapses internal whitespace', () => {
    expect(cleanText('  Bugs   Bunny \n')).toBe('Bugs Bunny');
  });
  it('handles non-string input', () => {
    expect(cleanText(null)).toBeNull();
    expect(cleanText(undefined)).toBeNull();
    expect(cleanText(42)).toBe('42');
  });
});

describe('parseNumber', () => {
  it('parses plain and decimal numbers', () => {
    expect(parseNumber('489360').value).toBe(489360);
    expect(parseNumber('7832265.523200001').value).toBeCloseTo(7832265.5232);
  });
  it('strips currency, commas and units', () => {
    expect(parseNumber('₹ 1,23,456').value).toBe(123456);
    expect(parseNumber('Rs. 2,000').value).toBe(2000);
    expect(parseNumber('5360 HA').value).toBe(5360);
  });
  it('handles negatives including accounting notation', () => {
    expect(parseNumber('-82907.29608').value).toBeCloseTo(-82907.29608);
    expect(parseNumber('(1,234)').value).toBe(-1234);
  });
  it('distinguishes missing from malformed', () => {
    const missing = parseNumber('');
    expect(missing.value).toBeNull();
    expect(missing.invalid).toBe(false);

    const bad = parseNumber('to be confirmed');
    expect(bad.value).toBeNull();
    expect(bad.invalid).toBe(true);
  });
  it('does not coerce a null sentinel into zero', () => {
    expect(parseNumber('N/A').value).toBeNull();
    expect(parseNumber('-').value).toBeNull();
  });
});

describe('parseDate', () => {
  it('parses the ISO form used by the source boards', () => {
    expect(toISODate(parseDate('2025-07-31 00:00:00').value)).toBe('2025-07-31');
    expect(toISODate(parseDate('2026-01-12').value)).toBe('2026-01-12');
  });
  it('assumes day-first for ambiguous numeric dates', () => {
    expect(toISODate(parseDate('03/04/2025').value)).toBe('2025-04-03');
  });
  it('falls back to month-first when day-first is impossible', () => {
    expect(toISODate(parseDate('12/25/2025').value)).toBe('2025-12-25');
  });
  it('parses textual month formats', () => {
    expect(toISODate(parseDate('12 Mar 2025').value)).toBe('2025-03-12');
    expect(toISODate(parseDate('Mar 12, 2025').value)).toBe('2025-03-12');
    expect(toISODate(parseDate('12-Mar-25').value)).toBe('2025-03-12');
  });
  it('parses two-digit years', () => {
    expect(toISODate(parseDate('01/02/24').value)).toBe('2024-02-01');
  });
  it('rejects impossible dates as malformed, not missing', () => {
    const r = parseDate('45/45/2025');
    expect(r.value).toBeNull();
    expect(r.invalid).toBe(true);
  });
  it('treats blank as missing, not malformed', () => {
    const r = parseDate('');
    expect(r.value).toBeNull();
    expect(r.invalid).toBe(false);
  });
  it('parses Excel serial numbers', () => {
    expect(toISODate(parseDate('45000').value)).toBe('2023-03-15');
  });
});

describe('taxonomy normalisation', () => {
  it('canonicalises sectors across casing and spacing', () => {
    expect(normalizeSector('mining')).toBe('Mining');
    expect(normalizeSector('  MINING ')).toBe('Mining');
    expect(normalizeSector('Renewable')).toBe('Renewables');
    expect(normalizeSector('Security and Surveillance')).toBe('Security and Surveillance');
  });
  it('keeps unrecognised sectors visible rather than folding them into Others', () => {
    expect(normalizeSector('Agritech')).toBe('Agritech');
  });
  it('derives stage order and bucket from lettered labels', () => {
    const s = normalizeStage('B. Sales Qualified Leads');
    expect(s?.order).toBe(2);
    expect(s?.bucket).toBe('open');
    expect(normalizeStage('L. Project Lost')?.bucket).toBe('lost');
    expect(normalizeStage('M. Projects On Hold')?.bucket).toBe('on_hold');
    expect(normalizeStage('O. Not Relevant at all')?.bucket).toBe('not_relevant');
  });
  it('handles the unlettered stage present in the real data', () => {
    const s = normalizeStage('Project Completed');
    expect(s?.order).toBeNull();
    expect(s?.bucket).toBe('won');
  });
  it('canonicalises deal and execution statuses', () => {
    expect(normalizeDealStatus('Won')?.canon).toBe('won');
    expect(normalizeDealStatus('Dead')?.canon).toBe('dead');
    expect(normalizeDealStatus('On Hold')?.canon).toBe('on_hold');
    expect(normalizeExecutionStatus('Pause / struck')?.canon).toBe('paused');
    expect(normalizeExecutionStatus('Executed until current month')?.canon).toBe('ongoing');
    expect(normalizeExecutionStatus('Details pending from Client')?.canon).toBe('blocked_on_client');
    expect(normalizeExecutionStatus('Partial Completed')?.canon).toBe('partial');
  });
  it('maps probability labels to documented weights', () => {
    expect(normalizeProbability('High')?.weight).toBe(0.8);
    expect(normalizeProbability('medium')?.weight).toBe(0.5);
    expect(normalizeProbability('LOW')?.weight).toBe(0.2);
    expect(normalizeProbability('55%')).toBeNull();
  });
  it('normalises names for joining across boards', () => {
    expect(nameKey('Scooby-Doo')).toBe(nameKey('scooby doo'));
    expect(nameKey('  Bugs Bunny ')).toBe('bugsbunny');
  });
});

/* ------------------------- board-level normalisation ----------------------- */

function dealsBoard(rows: Array<Record<string, string | null>>): RawBoard {
  const titles = [
    'Deal Name',
    'Owner code',
    'Client Code',
    'Deal Status',
    'Close Date (A)',
    'Closure Probability',
    'Masked Deal value',
    'Tentative Close Date',
    'Deal Stage',
    'Product deal',
    'Sector/service',
    'Created Date',
  ];
  return {
    boardId: '1',
    boardName: 'Deals',
    columns: titles.map((t, i) => ({ id: `c${i}`, title: t, type: 'text' })),
    items: rows.map((r, i) => ({
      id: String(i + 1),
      name: r['Deal Name'] ?? '',
      values: Object.fromEntries(titles.map((t) => [t, r[t] ?? null])),
    })),
    truncated: false,
  };
}

const baseDeal = {
  'Deal Name': 'Naruto',
  'Owner code': 'OWNER_001',
  'Client Code': 'COMPANY089',
  'Deal Status': 'Open',
  'Masked Deal value': '1000',
  'Deal Stage': 'B. Sales Qualified Leads',
  'Sector/service': 'Mining',
  'Created Date': '2025-11-01 00:00:00',
};

describe('normalizeDeals', () => {
  it('drops rows that are repeated header text', () => {
    const board = dealsBoard([
      baseDeal,
      {
        'Deal Name': 'Deal Name',
        'Deal Status': 'Deal Status',
        'Deal Stage': 'Deal Stage',
        'Sector/service': 'Sector/service',
      },
    ]);
    const { deals, quality } = normalizeDeals(board);
    expect(quality.headerRowsDropped).toBe(1);
    expect(deals).toHaveLength(1);
    expect(deals[0].dealName).toBe('Naruto');
  });

  it('drops exact duplicate rows and reports the count', () => {
    const { deals, quality } = normalizeDeals(dealsBoard([baseDeal, { ...baseDeal }, { ...baseDeal }]));
    expect(deals).toHaveLength(1);
    expect(quality.duplicateRowsDropped).toBe(2);
    expect(quality.warnings.some((w) => /duplicate/i.test(w))).toBe(true);
  });

  it('keeps records with missing values rather than discarding them', () => {
    const { deals, quality } = normalizeDeals(
      dealsBoard([baseDeal, { ...baseDeal, 'Deal Name': 'Sasuke', 'Masked Deal value': null }]),
    );
    expect(deals).toHaveLength(2);
    expect(deals[1].dealValue).toBeNull();
    expect(quality.warnings.some((w) => /no deal value/i.test(w))).toBe(true);
  });

  it('flags malformed values as record-level issues', () => {
    const { deals } = normalizeDeals(
      dealsBoard([{ ...baseDeal, 'Masked Deal value': 'ask finance', 'Created Date': 'someday' }]),
    );
    expect(deals[0].issues.some((i) => /not a number/i.test(i))).toBe(true);
    expect(deals[0].issues.some((i) => /created date/i.test(i))).toBe(true);
  });

  it('reports per-field completeness', () => {
    const { quality } = normalizeDeals(
      dealsBoard([baseDeal, { ...baseDeal, 'Deal Name': 'Sakura', 'Sector/service': null }]),
    );
    const sector = quality.fields.find((f) => f.field === 'sector');
    expect(sector?.present).toBe(1);
    expect(sector?.missing).toBe(1);
    expect(sector?.completeness).toBe(50);
  });

  it('detects a chronologically impossible close date', () => {
    const { deals } = normalizeDeals(
      dealsBoard([
        { ...baseDeal, 'Created Date': '2025-11-01', 'Tentative Close Date': '2025-01-01' },
      ]),
    );
    expect(deals[0].issues.some((i) => /precedes created date/i.test(i))).toBe(true);
  });

  it('resolves columns even when titles differ from the defaults', () => {
    const board: RawBoard = {
      boardId: '1',
      boardName: 'Deals',
      columns: [
        { id: 'a', title: 'Deal', type: 'text' },
        { id: 'b', title: 'Stage', type: 'text' },
        { id: 'c', title: 'Deal Value', type: 'numbers' },
        { id: 'd', title: 'Industry', type: 'text' },
      ],
      items: [
        {
          id: '1',
          name: 'Luffy',
          values: { Deal: 'Luffy', Stage: 'F. Negotiations', 'Deal Value': '5000', Industry: 'Railways' },
        },
      ],
      truncated: false,
    };
    const { deals } = normalizeDeals(board);
    expect(deals[0].dealValue).toBe(5000);
    expect(deals[0].sector).toBe('Railways');
    expect(deals[0].stageBucket).toBe('open');
  });

  it('reports columns it could not resolve', () => {
    const board: RawBoard = {
      boardId: '1',
      boardName: 'Deals',
      columns: [{ id: 'a', title: 'Deal Name', type: 'text' }],
      items: [{ id: '1', name: 'Zoro', values: { 'Deal Name': 'Zoro' } }],
      truncated: false,
    };
    const { quality } = normalizeDeals(board);
    expect(quality.unresolvedColumns).toContain('dealValue');
    expect(quality.warnings.some((w) => /not found on the board/i.test(w))).toBe(true);
  });
});

describe('normalizeWorkOrders', () => {
  const titles = [
    'Deal name masked',
    'Customer Name Code',
    'Serial #',
    'Execution Status',
    'Sector',
    'Amount in Rupees (Excl of GST) (Masked)',
    'Billed Value in Rupees (Excl of GST.) (Masked)',
    'Amount Receivable (Masked)',
    'Probable Start Date',
    'Probable End Date',
    'AR Priority account',
  ];
  const board = (rows: Array<Record<string, string | null>>): RawBoard => ({
    boardId: '2',
    boardName: 'Work Orders',
    columns: titles.map((t, i) => ({ id: `w${i}`, title: t, type: 'text' })),
    items: rows.map((r, i) => ({
      id: String(i + 1),
      name: r['Deal name masked'] ?? '',
      values: Object.fromEntries(titles.map((t) => [t, r[t] ?? null])),
    })),
    truncated: false,
  });

  const baseWo = {
    'Deal name masked': 'Appa',
    'Customer Name Code': 'WOCOMPANY_038',
    'Serial #': 'SDPLDEAL-101',
    'Execution Status': 'Ongoing',
    Sector: 'Mining',
    'Amount in Rupees (Excl of GST) (Masked)': '100000',
  };

  it('deduplicates on serial number', () => {
    const { workOrders, quality } = normalizeWorkOrders(board([baseWo, { ...baseWo }]));
    expect(workOrders).toHaveLength(1);
    expect(quality.duplicateRowsDropped).toBe(1);
  });

  it('flags billing that exceeds the order value', () => {
    const { workOrders } = normalizeWorkOrders(
      board([{ ...baseWo, 'Billed Value in Rupees (Excl of GST.) (Masked)': '250000' }]),
    );
    expect(workOrders[0].issues.some((i) => /exceeds order value/i.test(i))).toBe(true);
  });

  it('flags an end date before the start date', () => {
    const { workOrders } = normalizeWorkOrders(
      board([{ ...baseWo, 'Probable Start Date': '2025-06-01', 'Probable End Date': '2025-05-01' }]),
    );
    expect(workOrders[0].issues.some((i) => /precedes start date/i.test(i))).toBe(true);
  });

  it('reads the AR priority flag', () => {
    const { workOrders } = normalizeWorkOrders(
      board([{ ...baseWo, 'AR Priority account': 'Priority' }, { ...baseWo, 'Serial #': 'X-2' }]),
    );
    expect(workOrders[0].arPriority).toBe(true);
    expect(workOrders[1].arPriority).toBe(false);
  });

  it('handles a completely empty board without throwing', () => {
    const { workOrders, quality } = normalizeWorkOrders(board([]));
    expect(workOrders).toHaveLength(0);
    expect(quality.usableRecords).toBe(0);
  });
});
