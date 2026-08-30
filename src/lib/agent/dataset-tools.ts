import type { ToolSpec } from './provider';
import { describeDataset, runQuery, QueryError } from '../datasets/query';
import type { DatasetQuery, DatasetSnapshot } from '../datasets/types';

/**
 * Tools for datasets the user uploaded.
 *
 * Three tools rather than one catch-all or fifteen narrow ones: the agent needs
 * to know what exists, inspect one closely, and compute over it. `query_dataset`
 * is deliberately constrained — a fixed vocabulary of filters, groupings and
 * metrics — so there is no expression language for a model to get wrong and no
 * path by which raw rows reach it.
 */

export const DATASET_TOOL_DEFINITIONS: ToolSpec[] = [
  {
    name: 'list_datasets',
    description:
      'Lists the datasets the user has uploaded in this session, with row and column counts. Call this first whenever a question might concern uploaded data, or when the user mentions a file, spreadsheet or dataset by name.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'describe_dataset',
    description:
      "Full detail for one uploaded dataset: every column with its inferred type, how many rows have a value, missing and malformed counts, ranges and example values. Use before answering questions about a dataset so you know which columns exist and how complete they are.",
    parameters: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset name, as given by list_datasets.' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'query_dataset',
    description:
      'Computes figures over one uploaded dataset. Every number is calculated in code — filter rows, group by a column, and apply metrics (count, sum, avg, min, max, count_distinct). Omit metrics for a plain row count. Use "select" instead to list individual rows, e.g. the largest transactions. Results always report how many rows carried a usable value.',
    parameters: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset name.' },
        filters: {
          type: 'array',
          description: 'Row conditions, combined with AND.',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string' },
              op: {
                type: 'string',
                enum: [
                  'eq',
                  'neq',
                  'gt',
                  'gte',
                  'lt',
                  'lte',
                  'contains',
                  'is_missing',
                  'is_present',
                ],
              },
              value: { type: 'string', description: 'Omit for is_missing and is_present.' },
            },
            required: ['column', 'op'],
          },
        },
        group_by: { type: 'string', description: 'Column to group by, e.g. region or category.' },
        metrics: {
          type: 'array',
          description: 'Aggregates to compute. Defaults to a row count.',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['count', 'sum', 'avg', 'min', 'max', 'count_distinct'],
              },
              column: { type: 'string', description: 'Required for every op except count.' },
            },
            required: ['op'],
          },
        },
        select: {
          type: 'array',
          description: 'Columns to return as individual rows, instead of aggregating.',
          items: { type: 'string' },
        },
        sort: {
          type: 'object',
          properties: {
            by: { type: 'string' },
            direction: { type: 'string', enum: ['asc', 'desc'] },
          },
          required: ['by'],
        },
        limit: { type: 'integer', description: 'Maximum rows or groups to return.' },
      },
      required: ['dataset'],
    },
  },
];

export const DATASET_TOOL_NAMES = new Set(DATASET_TOOL_DEFINITIONS.map((t) => t.name));

function find(datasets: DatasetSnapshot[], ref: unknown): DatasetSnapshot {
  const name = String(ref ?? '').trim().toLowerCase();
  if (!datasets.length) {
    throw new QueryError(
      'No datasets have been uploaded in this session. Tell the user they can add a spreadsheet from the workspace, or answer from the monday.com boards instead.',
    );
  }
  const hit =
    datasets.find((d) => d.name.toLowerCase() === name) ??
    datasets.find((d) => d.fileName.toLowerCase() === name) ??
    datasets.find((d) => d.id === ref) ??
    // A single dataset needs no disambiguation.
    (datasets.length === 1 ? datasets[0] : undefined);

  if (!hit) {
    throw new QueryError(
      `There is no dataset called "${ref}". Available: ${datasets.map((d) => d.name).join(', ')}.`,
    );
  }
  return hit;
}

export interface DatasetToolResult {
  result: unknown;
  label: string;
}

export function runDatasetTool(
  name: string,
  input: Record<string, unknown>,
  datasets: DatasetSnapshot[],
): DatasetToolResult {
  switch (name) {
    case 'list_datasets':
      return {
        label: 'Available datasets',
        result: {
          datasets: datasets.map((d) => ({
            name: d.name,
            fileName: d.fileName,
            rows: d.rowCount,
            columns: d.columns.map((c) => `${c.name} (${c.type})`),
          })),
          count: datasets.length,
          note: datasets.length
            ? 'These are files the user uploaded. The monday.com boards are separate and are read with the other tools.'
            : 'No uploaded datasets. Use the monday.com tools for business questions about deals and work orders.',
        },
      };

    case 'describe_dataset': {
      const d = find(datasets, input.dataset);
      return { label: `Schema · ${d.name}`, result: describeDataset(d) };
    }

    case 'query_dataset': {
      const d = find(datasets, input.dataset);
      const q = { ...(input as unknown as DatasetQuery), dataset: d.name };
      return { label: `Query · ${d.name}`, result: runQuery(d, q) };
    }

    default:
      return { label: 'Unknown tool', result: { error: `Unknown dataset tool "${name}"` } };
  }
}
