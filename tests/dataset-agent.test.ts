import { describe, expect, it, vi } from 'vitest';
import { parseFile } from '@/lib/datasets/parse';
import { buildSnapshot } from '@/lib/datasets/normalize';
import { runQuery } from '@/lib/datasets/query';
import {
  DATASET_TOOL_DEFINITIONS,
  DATASET_TOOL_NAMES,
  runDatasetTool,
} from '@/lib/agent/dataset-tools';
import { ALL_TOOL_DEFINITIONS, TOOL_DEFINITIONS } from '@/lib/agent/tools';
import { contextPreamble, SYSTEM_PROMPT } from '@/lib/agent/prompt';
import type { DatasetSnapshot } from '@/lib/datasets/types';

/**
 * How uploaded datasets reach the agent, and the boundary that keeps their
 * contents data rather than instructions.
 */

const bytes = (s: string) => new TextEncoder().encode(s);
const load = (csv: string, name = 'Revenue Q3.csv', id = 'ds_1'): DatasetSnapshot =>
  buildSnapshot(parseFile(name, bytes(csv)), name, id);

const SALES = load(
  [
    'Customer,Region,Revenue',
    'Acme,North,100',
    'Bolt,South,200',
    'Corvid,North,',
    'Delta,West,300',
  ].join('\n'),
);

/* ------------------------------ tool surface ------------------------------ */

describe('tool surface', () => {
  it('adds three dataset tools alongside the nine monday.com tools', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(9);
    expect(DATASET_TOOL_DEFINITIONS).toHaveLength(3);
    expect(ALL_TOOL_DEFINITIONS).toHaveLength(12);
  });

  it('does not disturb the existing monday.com tools', () => {
    const monday = ALL_TOOL_DEFINITIONS.slice(0, 9);
    expect(monday).toEqual(TOOL_DEFINITIONS);
  });

  it('gives every dataset tool a valid schema', () => {
    for (const t of DATASET_TOOL_DEFINITIONS) {
      expect((t.parameters as { type: string }).type).toBe('OBJECT'.toLowerCase());
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it('routes dataset tool names away from the monday.com path', () => {
    expect(DATASET_TOOL_NAMES.has('query_dataset')).toBe(true);
    expect(DATASET_TOOL_NAMES.has('get_pipeline_metrics')).toBe(false);
  });
});

/* -------------------------------- listing --------------------------------- */

describe('list_datasets', () => {
  it('reports what is loaded', () => {
    const r = runDatasetTool('list_datasets', {}, [SALES]).result as {
      count: number;
      datasets: Array<{ name: string; rows: number }>;
    };
    expect(r.count).toBe(1);
    expect(r.datasets[0]).toMatchObject({ name: 'Revenue Q3', rows: 4 });
  });

  it('says plainly when nothing is loaded, and points at monday.com', () => {
    const r = runDatasetTool('list_datasets', {}, []).result as { count: number; note: string };
    expect(r.count).toBe(0);
    expect(r.note).toMatch(/monday\.com/i);
  });
});

/* ------------------------------- resolution ------------------------------- */

describe('choosing a dataset', () => {
  const OTHER = load('Product,Units\nWidget,5\nGadget,9', 'Inventory.csv', 'ds_2');

  it('resolves by name, case-insensitively', () => {
    const r = runDatasetTool('describe_dataset', { dataset: 'revenue q3' }, [SALES, OTHER]);
    expect((r.result as { name: string }).name).toBe('Revenue Q3');
  });

  it('resolves by filename', () => {
    const r = runDatasetTool('describe_dataset', { dataset: 'Inventory.csv' }, [SALES, OTHER]);
    expect((r.result as { name: string }).name).toBe('Inventory');
  });

  it('needs no name when only one dataset is loaded', () => {
    const r = runDatasetTool('query_dataset', { dataset: 'whatever' }, [SALES]);
    expect((r.result as { dataset: string }).dataset).toBe('Revenue Q3');
  });

  it('refuses to guess between several, and lists them', () => {
    expect(() => runDatasetTool('describe_dataset', { dataset: 'nope' }, [SALES, OTHER])).toThrow(
      /no dataset called "nope".*Revenue Q3, Inventory/s,
    );
  });

  it('explains that nothing is uploaded rather than inventing a dataset', () => {
    expect(() => runDatasetTool('query_dataset', { dataset: 'sales' }, [])).toThrow(
      /No datasets have been uploaded/i,
    );
  });
});

/* -------------------------------- querying -------------------------------- */

describe('query_dataset through the tool layer', () => {
  it('computes a total with coverage, never zero-filling', () => {
    const r = runDatasetTool(
      'query_dataset',
      { dataset: 'Revenue Q3', metrics: [{ op: 'sum', column: 'Revenue' }] },
      [SALES],
    ).result as { metrics: Array<{ value: number; coverage: { counted: number; excluded: number } }> };

    expect(r.metrics[0].value).toBe(600);
    expect(r.metrics[0].coverage).toMatchObject({ counted: 3, excluded: 1 });
  });

  it('groups by a column', () => {
    const r = runDatasetTool(
      'query_dataset',
      { dataset: 'Revenue Q3', group_by: 'Region', metrics: [{ op: 'sum', column: 'Revenue' }] },
      [SALES],
    ).result as { groups: Array<{ group: string; metrics: Array<{ value: number }> }> };

    expect(r.groups.find((g) => g.group === 'South')!.metrics[0].value).toBe(200);
  });

  it('labels the result with the dataset it used', () => {
    const r = runDatasetTool('query_dataset', { dataset: 'Revenue Q3' }, [SALES]);
    expect(r.label).toContain('Revenue Q3');
  });
});

/* -------------------------- prompt-level integration ---------------------- */

describe('the agent is told what it has', () => {
  it('names monday.com only when nothing is uploaded', () => {
    const p = contextPreamble(new Date('2026-08-30'), []);
    expect(p).toMatch(/No uploaded datasets/);
    expect(p).toMatch(/2026-08-30/);
  });

  it('lists uploaded datasets with their shape', () => {
    const p = contextPreamble(new Date('2026-08-30'), [SALES]);
    expect(p).toMatch(/"Revenue Q3" \(4 rows, 3 columns\)/);
  });

  it('instructs the model to name its source and never to compute', () => {
    expect(SYSTEM_PROMPT).toMatch(/Name the source in your answer/i);
    expect(SYSTEM_PROMPT).toMatch(/query_dataset\` does the arithmetic\. You never do/i);
  });

  it('forbids combining an upload with monday.com into one total', () => {
    expect(SYSTEM_PROMPT).toMatch(/no verified shared identifier/i);
  });

  it('says a missing field must be reported, not substituted', () => {
    expect(SYSTEM_PROMPT).toMatch(/lacks the field the question needs, say so/i);
  });
});

/* ------------------------- the LLM does no arithmetic --------------------- */

describe('the model never receives the rows it would need to compute', () => {
  it('returns aggregates, not the underlying values', () => {
    const r = JSON.stringify(
      runDatasetTool(
        'query_dataset',
        { dataset: 'Revenue Q3', group_by: 'Region', metrics: [{ op: 'sum', column: 'Revenue' }] },
        [SALES],
      ).result,
    );
    // The group totals are present; the individual customer names behind them
    // are not, because nothing asked for rows.
    expect(r).toContain('300');
    expect(r).not.toContain('Acme');
  });

  it('caps how many rows a select can ever return', () => {
    const many = load(
      ['N', ...Array.from({ length: 500 }, (_, i) => String(i))].join('\n'),
      'big.csv',
    );
    const r = runQuery(many, { dataset: 'big', select: ['N'], limit: 9999 });
    expect(r.rows!.length).toBeLessThanOrEqual(50);
    expect(r.caveats.join(' ')).toMatch(/Showing \d+ of 500/);
  });

  it('caps how many groups a grouping can return', () => {
    const many = load(
      ['G,V', ...Array.from({ length: 400 }, (_, i) => `g${i},1`)].join('\n'),
      'g.csv',
    );
    const r = runQuery(many, { dataset: 'g', group_by: 'G', limit: 9999 });
    expect(r.groups!.length).toBeLessThanOrEqual(100);
    expect(r.truncated).toBe(true);
  });
});
