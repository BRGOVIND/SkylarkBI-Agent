import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseFile, detectFormat, safeName } from '@/lib/datasets/parse';
import { buildSnapshot } from '@/lib/datasets/normalize';
import { runQuery, describeDataset, previewRows, QueryError } from '@/lib/datasets/query';
import { UploadError, LIMITS } from '@/lib/datasets/limits';
import type { DatasetSnapshot } from '@/lib/datasets/types';

/**
 * Parsing, normalisation and the deterministic query engine for uploaded files.
 *
 * The behaviour that matters most here is the same one the monday.com path
 * guarantees: a blank cell is missing, not zero, and every total says how many
 * rows actually contributed to it.
 */

const bytes = (s: string) => new TextEncoder().encode(s);

const CSV = [
  'Customer,Region,Invoice Date,Revenue,Status',
  'Acme Corp,North,2025-01-15,125000,Paid',
  'Bolt Industries,South,2025-02-03,89000.50,Paid',
  'Corvid Ltd,North,2025-02-19,,Pending',
  'Delta Works,West,2025-03-01,240000,Paid',
  'Echo Systems,South,N/A,54000,Pending',
  'Foxtrot GmbH,North,2025-03-22,not recorded,Paid',
  'Golf Partners,West,2025-04-18,72000,Overdue',
].join('\n');

function load(text = CSV, name = 'Revenue Q3.csv'): DatasetSnapshot {
  return buildSnapshot(parseFile(name, bytes(text)), name, 'ds_test');
}

/* -------------------------------- parsing --------------------------------- */

describe('format detection', () => {
  it('recognises every supported extension', () => {
    expect(detectFormat('a.csv')).toBe('csv');
    expect(detectFormat('a.tsv')).toBe('tsv');
    expect(detectFormat('a.TSV')).toBe('tsv');
    expect(detectFormat('a.xlsx')).toBe('xlsx');
    expect(detectFormat('a.xls')).toBe('xls');
    expect(detectFormat('a.ods')).toBe('ods');
  });

  it('rejects formats it cannot actually read', () => {
    for (const f of ['a.pdf', 'a.json', 'a.parquet', 'a.txt', 'noextension']) {
      expect(() => detectFormat(f)).toThrow(UploadError);
    }
  });

  it('neutralises path-like filenames without mangling ordinary ones', () => {
    expect(safeName('../../etc/passwd')).not.toContain('/');
    expect(safeName('../../etc/passwd')).not.toContain('..');
    expect(safeName('My Report-Q3 (final).csv')).toBe('My Report-Q3 (final).csv');
    expect(safeName('   ')).toBe('dataset');
  });
});

describe('CSV and TSV parsing', () => {
  it('reads a CSV into a typed snapshot', () => {
    const s = load();
    expect(s.rowCount).toBe(7);
    expect(s.columns.map((c) => c.name)).toEqual([
      'Customer',
      'Region',
      'Invoice Date',
      'Revenue',
      'Status',
    ]);
  });

  it('reads TSV', () => {
    const tsv = 'Name\tValue\nAlpha\t10\nBeta\t20';
    const s = buildSnapshot(parseFile('t.tsv', bytes(tsv)), 't.tsv', 'id');
    expect(s.rowCount).toBe(2);
    expect(s.columns[1].type).toBe('number');
  });

  it('handles quoted fields containing commas and newlines', () => {
    const csv = 'Name,Note\n"Acme, Inc","line one\nline two"\n';
    const s = buildSnapshot(parseFile('q.csv', bytes(csv)), 'q.csv', 'id');
    expect(s.rowCount).toBe(1);
    expect(s.data[s.columns[0].key][0]).toBe('Acme, Inc');
  });

  it('rejects empty, headerless and data-less files', () => {
    expect(() => parseFile('a.csv', bytes(''))).toThrow(/empty/i);
    expect(() => parseFile('a.csv', bytes('Name,Value\n'))).toThrow(/no data rows/i);
    expect(() => parseFile('a.csv', bytes(',,\n1,2,3'))).toThrow(/header row/i);
  });

  it('rejects a file wider than the column limit', () => {
    const wide = Array.from({ length: LIMITS.columns + 5 }, (_, i) => `c${i}`).join(',');
    expect(() => parseFile('w.csv', bytes(`${wide}\n${wide}`))).toThrow(/columns/i);
  });

  it('rejects a file above the size limit', () => {
    const big = new Uint8Array(LIMITS.fileBytes + 1);
    expect(() => parseFile('big.csv', big)).toThrow(/larger than/i);
  });
});

describe('workbook parsing', () => {
  const book = (rows: unknown[][], sheet = 'Sheet1') => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
    return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  };

  it('reads an XLSX workbook', () => {
    const buf = book([
      ['Product', 'Units'],
      ['Widget', 12],
      ['Gadget', 30],
    ]);
    const s = buildSnapshot(parseFile('b.xlsx', buf), 'b.xlsx', 'id');
    expect(s.rowCount).toBe(2);
    expect(s.columns[1].type).toBe('number');
    expect(runQuery(s, { dataset: 'b', metrics: [{ op: 'sum', column: 'Units' }] }).metrics![0].value).toBe(42);
  });

  it('skips leading empty sheets and reports the ones not read', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Empty');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['A'], ['1']]), 'Data');
    const buf = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    const s = buildSnapshot(parseFile('m.xlsx', buf), 'm.xlsx', 'id');
    expect(s.sheetName).toBe('Data');
    expect(s.quality.warnings.join(' ')).toMatch(/Empty/);
  });

  it('reports a corrupted workbook as unreadable rather than crashing', () => {
    expect(() => parseFile('bad.xlsx', bytes('this is not a workbook'))).toThrow(UploadError);
  });
});

/* ------------------------------ normalisation ----------------------------- */

describe('type inference', () => {
  it('types each column from its contents', () => {
    const s = load();
    const t = Object.fromEntries(s.columns.map((c) => [c.name, c.type]));
    expect(t['Customer']).toBe('string');
    expect(t['Region']).toBe('categorical');
    expect(t['Invoice Date']).toBe('date');
    expect(t['Revenue']).toBe('number');
    expect(t['Status']).toBe('categorical');
  });

  it('recognises booleans', () => {
    const s = buildSnapshot(
      parseFile('b.csv', bytes('Name,Active\na,yes\nb,no\nc,TRUE\nd,false')),
      'b.csv',
      'id',
    );
    expect(s.columns[1].type).toBe('boolean');
    expect(s.data[s.columns[1].key]).toEqual([true, false, true, false]);
  });

  it('keeps a column of bare years numeric rather than reading them as dates', () => {
    const s = buildSnapshot(
      parseFile('y.csv', bytes('Label,Year\na,2021\nb,2022\nc,2023\nd,2024')),
      'y.csv',
      'id',
    );
    expect(s.columns[1].type).toBe('number');
  });
});

describe('missing is never zero', () => {
  it('separates blank cells from unparseable ones', () => {
    const rev = load().columns.find((c) => c.name === 'Revenue')!;
    expect(rev.present).toBe(5);
    expect(rev.missing).toBe(1); // the empty cell
    expect(rev.malformed).toBe(1); // "not recorded"
    expect(rev.completeness).toBeCloseTo(71.4, 0);
  });

  it('treats N/A as missing but leaves real words alone', () => {
    const s = load();
    const date = s.columns.find((c) => c.name === 'Invoice Date')!;
    expect(date.missing).toBe(1); // the N/A row

    // "Pending" is a legitimate status here, not an empty marker — the
    // monday.com boards treat that word as empty, generic files must not.
    const status = s.columns.find((c) => c.name === 'Status')!;
    expect(status.present).toBe(7);
    expect(status.missing).toBe(0);
  });

  it('never contributes a zero for a blank cell', () => {
    const s = load();
    const sum = runQuery(s, { dataset: 'x', metrics: [{ op: 'sum', column: 'Revenue' }] })
      .metrics![0];
    expect(sum.value).toBe(580000.5);
    expect(sum.coverage).toEqual({ matched: 7, counted: 5, excluded: 2 });
  });

  it('averages over contributing rows only', () => {
    const avg = runQuery(load(), { dataset: 'x', metrics: [{ op: 'avg', column: 'Revenue' }] })
      .metrics![0];
    expect(avg.value).toBeCloseTo(580000.5 / 5, 2);
  });

  it('states the gap in a caveat', () => {
    const r = runQuery(load(), { dataset: 'x', metrics: [{ op: 'sum', column: 'Revenue' }] });
    expect(r.caveats.join(' ')).toMatch(/5 of 7 rows.*excluded rather than counted as zero/);
  });
});

describe('rows dropped are reported, not hidden', () => {
  it('keeps duplicate rows and reports them rather than removing them', () => {
    // Two identical rows in someone's spreadsheet are usually two real events.
    // Dropping one would quietly undercount their business, so they are counted
    // and flagged instead. (The monday.com boards do dedupe — there, a repeated
    // row is an artefact of the export.)
    const dup = `${CSV}\nAcme Corp,North,2025-01-15,125000,Paid`;
    const s = load(dup);
    expect(s.rowCount).toBe(8);
    expect(s.quality.duplicateRowsFound).toBe(1);
    expect(s.quality.warnings.join(' ')).toMatch(/counted, not removed/i);

    // The repeated revenue is counted twice, exactly as the file states it.
    const sum = runQuery(s, { dataset: 'x', metrics: [{ op: 'sum', column: 'Revenue' }] });
    expect(sum.metrics![0].value).toBe(580000.5 + 125000);
  });

  it('drops fully blank rows', () => {
    // papaparse discards blank lines before the normaliser sees them, so the
    // row never becomes a record. Which layer removed it does not matter; that
    // it is gone, and the real rows are untouched, does.
    const s = load(`${CSV}\n,,,,`);
    expect(s.rowCount).toBe(7);
  });

  it('rejects a file whose rows are all blank', () => {
    expect(() => load('A,B\n,\n,')).toThrow(/no data rows/i);
  });
});

/* --------------------------------- queries -------------------------------- */

describe('deterministic queries', () => {
  it('counts rows', () => {
    expect(runQuery(load(), { dataset: 'x' }).metrics![0].value).toBe(7);
  });

  it('groups and aggregates, with coverage per group', () => {
    const r = runQuery(load(), {
      dataset: 'x',
      group_by: 'Region',
      metrics: [{ op: 'sum', column: 'Revenue' }],
    });
    const north = r.groups!.find((g) => g.group === 'North')!;
    expect(north.rowCount).toBe(3);
    // Three North rows, but one blank and one unreadable revenue.
    expect(north.metrics[0].coverage).toEqual({ matched: 3, counted: 1, excluded: 2 });
    expect(north.metrics[0].value).toBe(125000);
  });

  it('filters rows', () => {
    const r = runQuery(load(), {
      dataset: 'x',
      filters: [{ column: 'Region', op: 'eq', value: 'South' }],
    });
    expect(r.rowsMatched).toBe(2);
  });

  it('supports numeric comparison filters', () => {
    const r = runQuery(load(), {
      dataset: 'x',
      filters: [{ column: 'Revenue', op: 'gt', value: 100000 }],
    });
    expect(r.rowsMatched).toBe(2);
  });

  it('filters on presence and absence', () => {
    expect(
      runQuery(load(), { dataset: 'x', filters: [{ column: 'Revenue', op: 'is_missing' }] })
        .rowsMatched,
    ).toBe(2);
    expect(
      runQuery(load(), { dataset: 'x', filters: [{ column: 'Revenue', op: 'is_present' }] })
        .rowsMatched,
    ).toBe(5);
  });

  it('counts distinct values', () => {
    const r = runQuery(load(), {
      dataset: 'x',
      metrics: [{ op: 'count_distinct', column: 'Region' }],
    });
    expect(r.metrics![0].value).toBe(3);
  });

  it('returns sorted rows for top-N questions', () => {
    const r = runQuery(load(), {
      dataset: 'x',
      select: ['Customer', 'Revenue'],
      sort: { by: 'Revenue', direction: 'desc' },
      limit: 2,
    });
    expect(r.rows!.map((x) => x.Customer)).toEqual(['Delta Works', 'Acme Corp']);
  });

  it('sorts rows with no value last, in either direction', () => {
    const desc = runQuery(load(), {
      dataset: 'x',
      select: ['Revenue'],
      sort: { by: 'Revenue', direction: 'asc' },
      limit: 7,
    });
    expect(desc.rows!.at(-1)!.Revenue).toBeNull();
  });

  it('reports min and max on dates', () => {
    const r = runQuery(load(), {
      dataset: 'x',
      metrics: [
        { op: 'min', column: 'Invoice Date' },
        { op: 'max', column: 'Invoice Date' },
      ],
    });
    expect(r.metrics![0].value).toBe('2025-01-15');
    expect(r.metrics![1].value).toBe('2025-04-18');
  });

  it('refuses to sum a non-numeric column instead of returning zero', () => {
    expect(() => runQuery(load(), { dataset: 'x', metrics: [{ op: 'sum', column: 'Status' }] }))
      .toThrow(/cannot be summed/);
  });

  it('names the available columns when asked for one that does not exist', () => {
    expect(() => runQuery(load(), { dataset: 'x', metrics: [{ op: 'sum', column: 'Profit' }] }))
      .toThrow(/not a column.*Customer, Region/s);
  });

  it('groups rows with no group value separately rather than dropping them', () => {
    const s = load('Name,Team,Score\na,,10\nb,Red,20\nc,Red,30');
    const r = runQuery(s, { dataset: 'x', group_by: 'Team', metrics: [{ op: 'sum', column: 'Score' }] });
    expect(r.groups!.some((g) => g.group === null)).toBe(true);
    expect(r.caveats.join(' ')).toMatch(/no value for "Team".*rather than dropped/);
  });
});

/* --------------------------- description helpers -------------------------- */

describe('describe and preview', () => {
  it('describes columns compactly, without handing over the rows', () => {
    const s = load();
    const d = describeDataset(s);
    expect(d.rows).toBe(7);
    expect(d.columns[3].populated).toBe('5/7');
    expect(d.columns[3].malformed).toBe(1);

    // A few example values per column are deliberate — the agent needs to see
    // what a column looks like. What it must never receive is the row store.
    expect(d.columns[0].examples.length).toBeLessThanOrEqual(3);
    expect(d).not.toHaveProperty('data');
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain('Golf Partners'); // beyond the 3-value sample
    // The description is metadata about columns, not the column store itself.
    expect(serialized).not.toContain(JSON.stringify(s.data));
  });

  it('previews a bounded number of rows', () => {
    const s = load();
    expect(previewRows(s, 3)).toHaveLength(3);
    expect(previewRows(s).length).toBeLessThanOrEqual(LIMITS.previewRows);
  });
});

/* ----------------------- real-world value fidelity ------------------------ */

describe('values survive parsing intact', () => {
  const of = (csv: string) => buildSnapshot(parseFile('f.csv', bytes(csv)), 'f.csv', 'i');

  it('preserves unicode exactly', () => {
    const s = of('Name,City\nJosé Álvarez,München\n日本語,北京\nΑθήνα,Kraków');
    expect(s.data[s.columns[0].key][0]).toBe('José Álvarez');
    expect(s.data[s.columns[1].key][1]).toBe('北京');
  });

  it('keeps commas, escaped quotes and newlines inside quoted cells', () => {
    const s = of('Name,Note\n"Acme, Inc.","He said ""hi"" loudly"\n"Multi\nline",ok');
    expect(s.rowCount).toBe(2);
    expect(s.data[s.columns[0].key][0]).toBe('Acme, Inc.');
    expect(String(s.data[s.columns[1].key][0])).toContain('"hi"');
  });

  it('reads currency, including Indian digit grouping', () => {
    const s = of('Item,Price\nA,"₹1,25,000"\nB,$2500.50\nC,"€1,000"\nD,£99');
    const price = s.columns.find((c) => c.name === 'Price')!;
    expect(price.type).toBe('number');
    expect(s.data[price.key][0]).toBe(125000);
    expect(
      runQuery(s, { dataset: 'f', metrics: [{ op: 'sum', column: 'Price' }] }).metrics![0].value,
    ).toBe(128599.5);
  });

  it('reads percentages, and 0% stays a real zero', () => {
    const s = of('Seg,Share\nA,45%\nB,12.5%\nC,100%\nD,0%');
    const share = s.columns.find((c) => c.name === 'Share')!;
    expect(share.type).toBe('number');
    expect(s.data[share.key][3]).toBe(0);
    expect(share.missing).toBe(0);
  });

  it('normalises mixed date formats to ISO', () => {
    const s = of('E,D\na,2025-01-15\nb,15/03/2025\nc,2025-12-01\nd,2025-06-30');
    expect(s.columns[1].type).toBe('date');
    expect(s.data[s.columns[1].key][1]).toBe('2025-03-15');
  });

  it('handles a hundred rows without drift', () => {
    const s = of('N,V\n' + Array.from({ length: 100 }, (_, i) => `r${i},${i}`).join('\n'));
    expect(s.rowCount).toBe(100);
    expect(runQuery(s, { dataset: 'f', metrics: [{ op: 'sum', column: 'V' }] }).metrics![0].value).toBe(4950);
  });
});

describe('type inference is explainable at the edges', () => {
  const typeOf = (csv: string) =>
    buildSnapshot(parseFile('f.csv', bytes(csv)), 'f.csv', 'i').columns[1].type;

  it('keeps a numeric column numeric despite a few bad values', () => {
    expect(typeOf('A,B\na,1\nb,2\nc,3\nd,4\ne,5\nf,oops')).toBe('number');
  });

  it('does not turn a mostly-text column into a number', () => {
    expect(typeOf('A,B\na,hello\nb,world\nc,3\nd,there\ne,friend\nf,now')).not.toBe('number');
  });

  it('does not call a half-numeric column a number', () => {
    expect(typeOf('A,B\na,1\nb,2\nc,3\nd,x\ne,y\nf,z')).not.toBe('number');
  });

  it('separates low-cardinality labels from free text', () => {
    expect(typeOf('A,B\na,North\nb,South\nc,North\nd,South\ne,North\nf,South')).toBe('categorical');
    expect(typeOf('A,B\na,q1\nb,w2\nc,e3\nd,r4\ne,t5\nf,y6')).toBe('string');
  });

  it('handles an entirely empty column', () => {
    const s = buildSnapshot(parseFile('f.csv', bytes('A,B\na,\nb,\nc,')), 'f.csv', 'i');
    expect(s.columns[1].type).toBe('string');
    expect(s.columns[1].present).toBe(0);
  });
});
