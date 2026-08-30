import { describe, expect, it, vi } from 'vitest';
import type { BusinessDataset, NormalizedDeal, NormalizedWorkOrder } from '@/lib/normalize/types';
import type { CompleteArgs, LlmProvider, LlmTurn } from '@/lib/agent/provider';

/**
 * Drives the real agent loop with a scripted provider and a fixture dataset.
 *
 * This proves the loop is genuinely vendor-neutral: tool selection, tool
 * execution against the real deterministic analytics, tool-result feedback and
 * the final grounded answer all work without any vendor SDK or API key. The
 * same loop is what Groq and Anthropic each drive.
 */

const deal = (p: Partial<NormalizedDeal>): NormalizedDeal => ({
  itemId: Math.random().toString(36).slice(2),
  dealName: 'Deal', dealNameKey: 'deal', ownerCode: 'OWNER_001',
  clientCode: 'COMPANY001', clientKey: 'company001',
  statusLabel: 'Open', status: 'open',
  stageLabel: 'B. Sales Qualified Leads', stageOrder: 2, stageBucket: 'open',
  sector: 'Mining', productDeal: null,
  probabilityLabel: null, probability: null, probabilityWeight: null,
  dealValue: null, createdDate: '2025-11-01', tentativeCloseDate: null,
  actualCloseDate: null, issues: [], ...p,
});

const wo = (p: Partial<NormalizedWorkOrder>): NormalizedWorkOrder => ({
  itemId: Math.random().toString(36).slice(2), serial: 'S-1',
  dealName: 'Deal', dealNameKey: 'deal', customerCode: 'WOCOMPANY_001',
  ownerCode: 'OWNER_001', sector: 'Mining', natureOfWork: null, typeOfWork: null,
  platform: null, executionStatusLabel: 'Ongoing', executionStatus: 'ongoing',
  woStatus: null, invoiceStatus: null, billingStatus: null, arPriority: false,
  documentType: null, poDate: '2025-10-01', probableStartDate: null,
  probableEndDate: null, dataDeliveryDate: null, lastInvoiceDate: null,
  orderValueExGst: null, orderValueInclGst: null, billedExGst: null,
  billedInclGst: null, collectedInclGst: null, toBillExGst: null, receivable: null,
  qtyPerPo: null, qtyBilled: null, qtyBalance: null, issues: [], ...p,
});

const emptyQuality = {
  board: '', boardId: '1', totalItemsFetched: 0, headerRowsDropped: 0,
  duplicateRowsDropped: 0, usableRecords: 0, fields: [], unresolvedColumns: [],
  unmappedColumns: [], warnings: [], truncated: false,
};

const FIXTURE: BusinessDataset = {
  deals: [
    deal({ dealName: 'Scooby-Doo', dealNameKey: 'scoobydoo', dealValue: 5_000_000, probability: 'high', probabilityWeight: 0.8 }),
    deal({ dealName: 'Naruto', dealNameKey: 'naruto', dealValue: null }), // no value -> coverage gap
    deal({ dealName: 'Luffy', dealNameKey: 'luffy', sector: 'Railways', dealValue: 2_000_000, stageBucket: 'won', stageLabel: 'G. Project Won' }),
  ],
  workOrders: [
    wo({ dealName: 'Scooby-Doo', dealNameKey: 'scoobydoo', orderValueExGst: 3_000_000, billedExGst: 1_000_000 }),
  ],
  quality: {
    deals: { ...emptyQuality, board: 'Deals', warnings: ['1 of 3 deals have no deal value; value-based totals exclude them.'] },
    workOrders: { ...emptyQuality, board: 'Work Orders' },
  },
  fetchedAt: new Date().toISOString(),
};

vi.mock('@/lib/data', () => ({
  loadBusinessData: async () => FIXTURE,
  snapshotAgeSeconds: () => 0,
  invalidateCache: () => {},
  describeError: (err: unknown) => ({
    message: err instanceof Error ? err.message : 'Unexpected error',
    kind: err instanceof Error && err.name === 'ConfigError' ? 'config' : 'unknown',
  }),
}));

const { runAgent } = await import('@/lib/agent/run');

/** A provider that replays a scripted sequence of turns. */
function scripted(turns: LlmTurn[]): LlmProvider & { seen: CompleteArgs[] } {
  const seen: CompleteArgs[] = [];
  let i = 0;
  return {
    providerName: 'scripted',
    model: 'test',
    seen,
    async complete(args: CompleteArgs) {
      seen.push(structuredClone(args));
      return turns[Math.min(i++, turns.length - 1)];
    },
  };
}

async function collect(gen: AsyncGenerator<unknown>) {
  const out = [];
  for await (const e of gen) out.push(e as { type: string; [k: string]: unknown });
  return out;
}

describe('agent loop (provider-neutral)', () => {
  it('answers directly when no tool is needed', async () => {
    const p = scripted([{ text: ['I only cover the Deals and Work Orders boards.'], toolCalls: [] }]);
    const events = await collect(runAgent([{ role: 'user', content: 'What can you do?' }], p));
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
  });

  it('passes the system prompt and every tool to the provider', async () => {
    const p = scripted([{ text: ['ok'], toolCalls: [] }]);
    await collect(runAgent([{ role: 'user', content: 'hi' }], p));
    // Nine monday.com tools plus three for uploaded datasets.
    expect(p.seen[0].tools).toHaveLength(12);
    expect(p.seen[0].system).toMatch(/never compute, estimate, or adjust a number yourself/i);
  });

  it("injects today's date into the final user turn", async () => {
    const p = scripted([{ text: ['ok'], toolCalls: [] }]);
    await collect(runAgent([{ role: 'user', content: 'pipeline?' }], p));
    const last = p.seen[0].messages.at(-1) as { text: string };
    expect(last.text).toMatch(/\[Context: today is \d{4}-\d{2}-\d{2}\./);
    // With nothing uploaded the agent is told so explicitly.
    expect(last.text).toMatch(/No uploaded datasets/);
  });

  it('executes a requested tool against the real analytics and feeds the result back', async () => {
    const p = scripted([
      { text: [], toolCalls: [{ id: 'c1', name: 'get_pipeline_metrics', input: {} }] },
      { text: ['Open pipeline is ₹50 lakh across 1 of 2 open deals.'], toolCalls: [] },
    ]);
    const events = await collect(runAgent([{ role: 'user', content: 'How is our pipeline?' }], p));

    expect(events.map((e) => e.type)).toEqual(['tool', 'text', 'done']);
    expect(events[0].label).toBe('Pipeline metrics');

    // The second call must carry the real computed figures back to the model.
    const results = p.seen[1].messages.at(-1) as { role: string; results: Array<{ content: string }> };
    expect(results.role).toBe('tool_results');
    const payload = JSON.parse(results.results[0].content);
    expect(payload.openPipelineValue).toBe(5_000_000); // deterministic, not model-generated
    expect(payload.openPipelineCoverage).toEqual({ matched: 2, counted: 1, excluded: 1 });
    expect(payload.caveats.join(' ')).toMatch(/no deal value/);
  });

  it('surfaces the coverage gap the model needs to disclose', async () => {
    const p = scripted([
      { text: [], toolCalls: [{ id: 'c1', name: 'get_data_quality_report', input: {} }] },
      { text: ['1 of 3 deals has no value recorded.'], toolCalls: [] },
    ]);
    await collect(runAgent([{ role: 'user', content: 'How reliable is this data?' }], p));
    const results = p.seen[1].messages.at(-1) as { results: Array<{ content: string }> };
    expect(results.results[0].content).toMatch(/no deal value/);
  });

  it('runs a cross-board query end to end', async () => {
    const p = scripted([
      { text: [], toolCalls: [{ id: 'c1', name: 'get_cross_board_view', input: { only_with_both: true } }] },
      { text: ['Scooby-Doo has both pipeline and delivery.'], toolCalls: [] },
    ]);
    await collect(runAgent([{ role: 'user', content: 'Who has both work and pipeline?' }], p));
    const results = p.seen[1].messages.at(-1) as { results: Array<{ content: string }> };
    const payload = JSON.parse(results.results[0].content);
    expect(payload.both).toBe(1);
    expect(payload.customers[0].name).toBe('Scooby-Doo');
    expect(payload.customers[0].orderBookValue).toBe(3_000_000);
    expect(payload.caveats.join(' ')).toMatch(/different customer code spaces/i);
  });

  it('handles parallel tool calls in one round', async () => {
    const p = scripted([
      {
        text: [],
        toolCalls: [
          { id: 'a', name: 'get_pipeline_metrics', input: {} },
          { id: 'b', name: 'get_operational_metrics', input: {} },
        ],
      },
      { text: ['Both boards summarised.'], toolCalls: [] },
    ]);
    const events = await collect(runAgent([{ role: 'user', content: 'summary' }], p));
    expect(events.filter((e) => e.type === 'tool')).toHaveLength(2);
    const results = p.seen[1].messages.at(-1) as { results: unknown[] };
    expect(results.results).toHaveLength(2);
  });

  it('feeds a malformed-arguments error back instead of executing the tool', async () => {
    const p = scripted([
      {
        text: [],
        toolCalls: [{ id: 'c1', name: 'get_pipeline_metrics', input: {}, parseError: 'not valid JSON' }],
      },
      { text: ['Let me retry that.'], toolCalls: [] },
    ]);
    await collect(runAgent([{ role: 'user', content: 'pipeline' }], p));
    const results = p.seen[1].messages.at(-1) as { results: Array<{ content: string; isError: boolean }> };
    expect(results.results[0].isError).toBe(true);
    expect(results.results[0].content).toMatch(/valid JSON object/);
  });

  it('reports an unknown tool name without crashing the turn', async () => {
    const p = scripted([
      { text: [], toolCalls: [{ id: 'c1', name: 'get_the_moon', input: {} }] },
      { text: ['That is not something I can look up.'], toolCalls: [] },
    ]);
    const events = await collect(runAgent([{ role: 'user', content: 'moon?' }], p));
    expect(events.at(-1)!.type).toBe('done');
    const results = p.seen[1].messages.at(-1) as { results: Array<{ content: string }> };
    expect(results.results[0].content).toMatch(/Unknown tool/);
  });

  it('reports a provider failure as an error event rather than throwing', async () => {
    const failing: LlmProvider = {
      providerName: 'groq',
      model: 'openai/gpt-oss-120b',
      async complete() {
        throw new (await import('@/lib/agent/provider')).LlmError('rate limited', 'groq', 429);
      },
    };
    const events = await collect(runAgent([{ role: 'user', content: 'hi' }], failing));
    expect(events[0].type).toBe('error');
    expect(events[0].message).toMatch(/groq.*rate limited/i);
  });

  it('stops after the tool-round cap instead of looping forever', async () => {
    // A provider that always asks for another tool call.
    const p = scripted([{ text: [], toolCalls: [{ id: 'c', name: 'get_pipeline_metrics', input: {} }] }]);
    const events = await collect(runAgent([{ role: 'user', content: 'loop' }], p));
    expect(events.filter((e) => e.type === 'tool').length).toBeLessThanOrEqual(6);
    expect(events.at(-1)!.type).toBe('done');
    expect(events.at(-2)!.text).toMatch(/narrow it down/i);
  });
});
