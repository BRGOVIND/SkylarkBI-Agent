import type { ToolSpec } from './provider';
import { loadBusinessData, snapshotAgeSeconds } from '../data';
import {
  crossBoardAnalysis,
  dataQualitySummary,
  filterDeals,
  filterWorkOrders,
  leadershipUpdate,
  operationalMetrics,
  pipelineMetrics,
  riskAnalysis,
  sectorAnalysis,
  type DealFilter,
  type WorkOrderFilter,
} from '../analytics';
import type { PeriodName } from '../analytics/period';

/**
 * The agent's tool surface.
 *
 * Design rule: tools return compact, pre-aggregated structures. Raw board rows
 * are only ever returned in small, explicitly limited samples. This keeps the
 * model reasoning over summaries instead of re-deriving arithmetic from
 * hundreds of records, which is both cheaper and far less error-prone.
 */

const PERIODS: PeriodName[] = [
  'this_quarter',
  'last_quarter',
  'next_quarter',
  'this_calendar_quarter',
  'this_financial_year',
  'last_financial_year',
  'this_month',
  'last_month',
  'next_month',
  'last_30_days',
  'last_90_days',
  'all_time',
];

const periodProp = {
  type: 'string' as const,
  enum: PERIODS,
  description:
    'Time window. "this_quarter" and similar quarter values use the Indian FINANCIAL year (Apr-Mar). Use "this_calendar_quarter" for Jan-Mar style quarters. Omit for all time.',
};

export const TOOL_DEFINITIONS: ToolSpec[] = [
  {
    name: 'get_board_overview',
    description:
      'Snapshot of both monday.com boards: record counts, available sectors, stages, statuses, owners, and the date range of the data. Call this first when you need to know what values you can filter by, or when the user asks what data is available.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_pipeline_metrics',
    description:
      'Deterministic sales-pipeline metrics from the Deals board: open/won/lost counts, open pipeline value, probability-weighted pipeline, win rate, and a stage breakdown. Use for questions about pipeline health, forecast, or deal flow.',
    parameters: {
      type: 'object',
      properties: {
        sector: { type: 'string', description: 'Filter to one sector, e.g. "Mining".' },
        stage_bucket: {
          type: 'string',
          enum: ['open', 'won', 'lost', 'on_hold', 'not_relevant'],
          description: 'Filter to one pipeline bucket.',
        },
        owner_code: { type: 'string', description: 'Filter to one owner code, e.g. "OWNER_001".' },
        probability: { type: 'string', enum: ['high', 'medium', 'low'] },
        period: periodProp,
        date_field: {
          type: 'string',
          enum: ['createdDate', 'tentativeCloseDate', 'actualCloseDate'],
          description:
            'Which date the period filters on. Use createdDate for "deals created", tentativeCloseDate for "closing this quarter".',
        },
      },
    },
  },
  {
    name: 'get_sector_analysis',
    description:
      'Per-sector comparison across BOTH boards: deal counts, open pipeline value, win rate, work-order count, order book and billed value. Use for "which sectors are performing best" or sector exposure questions.',
    parameters: {
      type: 'object',
      properties: {
        period: periodProp,
        date_field: {
          type: 'string',
          enum: ['createdDate', 'tentativeCloseDate', 'actualCloseDate'],
        },
      },
    },
  },
  {
    name: 'get_operational_metrics',
    description:
      'Delivery and billing metrics from the Work Orders board: execution status breakdown, order book, billed, collected, unbilled and receivable values. Use for questions about project execution, revenue realisation, billing or collections.',
    parameters: {
      type: 'object',
      properties: {
        sector: { type: 'string' },
        execution_status: {
          type: 'string',
          enum: ['not_started', 'ongoing', 'partial', 'completed', 'paused', 'blocked_on_client'],
        },
        owner_code: { type: 'string' },
        period: periodProp,
        date_field: {
          type: 'string',
          enum: ['poDate', 'probableStartDate', 'probableEndDate', 'lastInvoiceDate'],
        },
      },
    },
  },
  {
    name: 'get_risk_analysis',
    description:
      'Rule-based operational and commercial risks across both boards: overdue work orders, paused/blocked delivery, stalled deals past their close date, stuck invoicing, outstanding priority receivables. Use for "what should leadership worry about" or "what is at risk".',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max individual risks to return (default 20).' },
        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
  },
  {
    name: 'get_cross_board_view',
    description:
      'Joins Deals and Work Orders to show accounts with pipeline, delivery, or both. Use for "which customers have both active work and open opportunities" or account-level questions. Note the boards use different customer code spaces, so the join is on deal name.',
    parameters: {
      type: 'object',
      properties: {
        only_with_both: {
          type: 'boolean',
          description: 'Return only accounts that appear on BOTH boards.',
        },
        limit: { type: 'integer', description: 'Max accounts to return (default 20).' },
      },
    },
  },
  {
    name: 'search_records',
    description:
      'Returns a small sample of individual deal or work-order records matching filters. Use ONLY when the user asks about specific named deals/accounts or wants examples. Never use it to compute totals — use the metric tools for that.',
    parameters: {
      type: 'object',
      properties: {
        board: { type: 'string', enum: ['deals', 'work_orders'], description: 'Which board to search.' },
        name_contains: { type: 'string', description: 'Case-insensitive substring of the deal/account name.' },
        sector: { type: 'string' },
        stage_bucket: { type: 'string', enum: ['open', 'won', 'lost', 'on_hold', 'not_relevant'] },
        execution_status: {
          type: 'string',
          enum: ['not_started', 'ongoing', 'partial', 'completed', 'paused', 'blocked_on_client'],
        },
        period: periodProp,
        limit: { type: 'integer', description: 'Max records to return (default 15, hard cap 50).' },
      },
      required: ['board'],
    },
  },
  {
    name: 'get_data_quality_report',
    description:
      'Field-level completeness for both boards, records dropped as duplicates or header rows, unresolved columns, and sample record-level issues. Use when the user asks how reliable the data is, or when you need to explain why a figure has caveats.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'generate_leadership_update',
    description:
      'Assembles a complete leadership briefing pack in one call: headline pipeline and revenue figures, sector performance, top open deals, operational status, ranked risks, key accounts, and data-quality caveats. Use when asked for a leadership/board/exec update or a general "how is the business doing" question.',
    parameters: {
      type: 'object',
      properties: { period: periodProp },
    },
  },
];

/* ------------------------------- Execution -------------------------------- */

type Json = Record<string, unknown>;

const cap = (n: unknown, def: number, max: number) => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : def;
  return Math.max(1, Math.min(max, v));
};

export interface ToolRunResult {
  result: unknown;
  /** Surfaced in the UI so the evaluator can see the agent really hit the boards. */
  label: string;
}

export async function runTool(name: string, input: Json): Promise<ToolRunResult> {
  const data = await loadBusinessData();
  const age = snapshotAgeSeconds(data);
  const freshness = { snapshotFetchedAt: data.fetchedAt, snapshotAgeSeconds: age };

  switch (name) {
    case 'get_board_overview': {
      const sectors = new Set<string>();
      const stages = new Set<string>();
      const statuses = new Set<string>();
      const owners = new Set<string>();
      const execStatuses = new Set<string>();
      for (const d of data.deals) {
        if (d.sector) sectors.add(d.sector);
        if (d.stageLabel) stages.add(d.stageLabel);
        if (d.statusLabel) statuses.add(d.statusLabel);
        if (d.ownerCode) owners.add(d.ownerCode);
      }
      for (const w of data.workOrders) {
        if (w.sector) sectors.add(w.sector);
        if (w.ownerCode) owners.add(w.ownerCode);
        if (w.executionStatusLabel) execStatuses.add(w.executionStatusLabel);
      }
      const dealDates = data.deals.map((d) => d.createdDate).filter((x): x is string => !!x).sort();
      const woDates = data.workOrders.map((w) => w.poDate).filter((x): x is string => !!x).sort();
      return {
        label: 'Board overview',
        result: {
          ...freshness,
          deals: {
            boardId: data.quality.deals.boardId,
            usableRecords: data.deals.length,
            createdDateRange: dealDates.length
              ? { from: dealDates[0], to: dealDates[dealDates.length - 1] }
              : null,
          },
          workOrders: {
            boardId: data.quality.workOrders.boardId,
            usableRecords: data.workOrders.length,
            poDateRange: woDates.length ? { from: woDates[0], to: woDates[woDates.length - 1] } : null,
          },
          sectors: [...sectors].sort(),
          dealStages: [...stages].sort(),
          dealStatuses: [...statuses].sort(),
          executionStatuses: [...execStatuses].sort(),
          owners: [...owners].sort(),
          keyCaveats: [
            ...data.quality.deals.warnings.slice(0, 3),
            ...data.quality.workOrders.warnings.slice(0, 3),
          ],
        },
      };
    }

    case 'get_pipeline_metrics': {
      const f: DealFilter = {
        sector: input.sector as string | undefined,
        stageBucket: input.stage_bucket as string | undefined,
        ownerCode: input.owner_code as string | undefined,
        probability: input.probability as string | undefined,
        period: input.period as PeriodName | undefined,
        dateField: input.date_field as DealFilter['dateField'],
      };
      return { label: 'Pipeline metrics', result: { ...freshness, ...pipelineMetrics(data.deals, f) } };
    }

    case 'get_sector_analysis': {
      const f: DealFilter = {
        period: input.period as PeriodName | undefined,
        dateField: input.date_field as DealFilter['dateField'],
      };
      return { label: 'Sector analysis', result: { ...freshness, ...sectorAnalysis(data, f) } };
    }

    case 'get_operational_metrics': {
      const f: WorkOrderFilter = {
        sector: input.sector as string | undefined,
        executionStatus: input.execution_status as string | undefined,
        ownerCode: input.owner_code as string | undefined,
        period: input.period as PeriodName | undefined,
        dateField: input.date_field as WorkOrderFilter['dateField'],
      };
      return {
        label: 'Operational metrics',
        result: { ...freshness, ...operationalMetrics(data.workOrders, f) },
      };
    }

    case 'get_risk_analysis': {
      const limit = cap(input.limit, 20, 50);
      const report = riskAnalysis(data);
      const sev = input.severity as string | undefined;
      const risks = (sev ? report.risks.filter((r) => r.severity === sev) : report.risks).slice(0, limit);
      return {
        label: 'Risk analysis',
        result: { ...freshness, ...report, risks, totalRisksFound: report.risks.length },
      };
    }

    case 'get_cross_board_view': {
      const limit = cap(input.limit, 20, 50);
      const analysis = crossBoardAnalysis(data);
      const list = input.only_with_both
        ? analysis.customers.filter((c) => c.hasBoth)
        : analysis.customers;
      return {
        label: 'Cross-board account view',
        result: {
          ...freshness,
          ...analysis,
          customers: list.slice(0, limit),
          totalAccounts: analysis.customers.length,
          returned: Math.min(limit, list.length),
        },
      };
    }

    case 'search_records': {
      const limit = cap(input.limit, 15, 50);
      const needle = (input.name_contains as string | undefined)?.toLowerCase();
      if (input.board === 'work_orders') {
        const { rows } = filterWorkOrders(data.workOrders, {
          sector: input.sector as string | undefined,
          executionStatus: input.execution_status as string | undefined,
          period: input.period as PeriodName | undefined,
        });
        const matched = rows.filter(
          (w) => !needle || (w.dealName ?? '').toLowerCase().includes(needle) ||
            (w.customerCode ?? '').toLowerCase().includes(needle),
        );
        return {
          label: 'Work order records',
          result: {
            ...freshness,
            totalMatched: matched.length,
            returned: Math.min(limit, matched.length),
            records: matched.slice(0, limit),
          },
        };
      }
      const { rows } = filterDeals(data.deals, {
        sector: input.sector as string | undefined,
        stageBucket: input.stage_bucket as string | undefined,
        period: input.period as PeriodName | undefined,
      });
      const matched = rows.filter(
        (d) => !needle || (d.dealName ?? '').toLowerCase().includes(needle) ||
          (d.clientCode ?? '').toLowerCase().includes(needle),
      );
      return {
        label: 'Deal records',
        result: {
          ...freshness,
          totalMatched: matched.length,
          returned: Math.min(limit, matched.length),
          records: matched.slice(0, limit),
        },
      };
    }

    case 'get_data_quality_report':
      return { label: 'Data quality report', result: { ...freshness, ...dataQualitySummary(data) } };

    case 'generate_leadership_update':
      return {
        label: 'Leadership update pack',
        result: {
          ...freshness,
          ...leadershipUpdate(data, (input.period as PeriodName | undefined) ?? 'this_quarter'),
        },
      };

    default:
      return { label: 'Unknown tool', result: { error: `Unknown tool "${name}"` } };
  }
}
