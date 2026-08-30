import { describe, expect, it, vi } from 'vitest';
import type { BusinessDataset, NormalizedDeal, NormalizedWorkOrder } from '@/lib/normalize/types';

/**
 * The founder-level BI scenarios, driven end to end through a REAL
 * GeminiProvider whose only stub is `fetch`.
 *
 * This exercises the whole path: agent loop -> native Gemini adapter ->
 * generateContent translation -> tool execution against the real deterministic
 * analytics -> functionResponse parts translated back -> final answer.
 * No API key is used.
 *
 * The assertions focus on what actually matters for correctness: that the
 * figures reaching the model are the ones TypeScript computed, and that
 * coverage and caveats travel with them.
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

const q = {
  board: '', boardId: '1', totalItemsFetched: 0, headerRowsDropped: 0,
  duplicateRowsDropped: 0, usableRecords: 0, fields: [], unresolvedColumns: [],
  unmappedColumns: [], warnings: [], truncated: false,
};

const FIXTURE: BusinessDataset = {
  deals: [
    deal({ dealName: 'Scooby-Doo', dealNameKey: 'scoobydoo', dealValue: 5_000_000, probability: 'high', probabilityWeight: 0.8 }),
    deal({ dealName: 'Naruto', dealNameKey: 'naruto', dealValue: null }),          // no value
    deal({ dealName: 'Bugs Bunny', dealNameKey: 'bugsbunny', dealValue: null }),   // no value
    deal({ dealName: 'Luffy', dealNameKey: 'luffy', sector: 'Railways', dealValue: 2_000_000, stageBucket: 'won', stageLabel: 'G. Project Won' }),
    deal({ dealName: 'Zoro', dealNameKey: 'zoro', sector: 'Railways', dealValue: 1_000_000, stageBucket: 'lost', stageLabel: 'L. Project Lost' }),
  ],
  workOrders: [
    wo({ dealName: 'Scooby-Doo', dealNameKey: 'scoobydoo', orderValueExGst: 3_000_000, billedExGst: 1_000_000 }),
    wo({ dealName: 'Whale', dealNameKey: 'whale', sector: 'Railways', orderValueExGst: 500_000, executionStatus: 'paused', executionStatusLabel: 'Pause / struck' }),
  ],
  quality: {
    deals: { ...q, board: 'Deals', warnings: ['2 of 5 deals have no deal value; value-based totals exclude them.'] },
    workOrders: { ...q, board: 'Work Orders' },
  },
  fetchedAt: new Date().toISOString(),
};

vi.mock('@/lib/data', () => ({
  loadBusinessData: async () => FIXTURE,
  snapshotAgeSeconds: () => 0,
  invalidateCache: () => {},
  describeError: (err: unknown) => ({
    message: err instanceof Error ? err.message : 'Unexpected error',
    kind: 'unknown',
  }),
}));

const { runAgent } = await import('@/lib/agent/run');
const { GeminiProvider } = await import('@/lib/agent/providers/gemini');

/* --------------------------- Gemini response stubs ------------------------- */

const geminiToolCall = (name: string, args: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: 'model', parts: [{ functionCall: { name, args } }] },
          finishReason: 'STOP',
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

const geminiText = (content: string) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: content }] }, finishReason: 'STOP' }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

/**
 * Runs a question through the real loop and real Gemini adapter, replaying the
 * given Gemini HTTP responses in order. Returns the events plus every request
 * body the adapter sent, so we can inspect what the model actually received.
 */
async function ask(question: string, responses: Response[]) {
  const bodies: Array<{
    contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    tools?: Array<{ functionDeclarations: unknown[] }>;
    systemInstruction: { parts: Array<{ text: string }> };
  }> = [];
  let i = 0;
  const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return responses[Math.min(i++, responses.length - 1)];
  });

  const provider = new GeminiProvider({
    apiKey: 'k',
    model: 'gemini-2.5-flash',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxAttempts: 1,
  });

  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const e of runAgent([{ role: 'user', content: question }], provider)) {
    events.push(e as { type: string; [k: string]: unknown });
  }

  /**
   * The tool payload the model was given back. In the native API this is a
   * functionResponse part whose `response` is already a struct.
   */
  const toolResult = (n = 0): Record<string, any> => {
    const last = bodies.at(-1)!;
    const parts = last.contents.flatMap((c) => c.parts).filter((p) => 'functionResponse' in p);
    return (parts[n] as { functionResponse: { response: Record<string, any> } }).functionResponse
      .response;
  };

  return {
    events,
    bodies,
    answer: events.filter((e) => e.type === 'text').map((e) => e.text).join('\n\n'),
    toolsUsed: events.filter((e) => e.type === 'tool').map((e) => e.name as string),
    toolResult,
  };
}

/* -------------------------------- scenarios -------------------------------- */

describe('Gemini — founder scenarios end to end', () => {
  it('simple pipeline question: selects the tool and receives deterministic figures', async () => {
    const r = await ask('How is our pipeline looking?', [
      geminiToolCall('get_pipeline_metrics'),
      geminiText('Open pipeline is ₹50 lakh across 1 of 3 open deals.'),
    ]);

    expect(r.toolsUsed).toEqual(['get_pipeline_metrics']);
    const p = r.toolResult();
    // Computed by TypeScript, not the model.
    expect(p.openPipelineValue).toBe(5_000_000);
    expect(p.openDeals).toBe(3);
    expect(p.wonDeals).toBe(1);
    expect(p.lostDeals).toBe(1);
    expect(p.winRateByCount).toBe(50);
    expect(r.answer).toContain('₹50 lakh');
  });

  it('propagates coverage so a missing value is never treated as zero', async () => {
    const r = await ask('How is our pipeline looking?', [
      geminiToolCall('get_pipeline_metrics'),
      geminiText('₹50 lakh across 1 of 3 open deals; 2 have no value recorded.'),
    ]);
    const p = r.toolResult();
    expect(p.openPipelineCoverage).toEqual({ matched: 3, counted: 1, excluded: 2 });
    expect(p.caveats.join(' ')).toMatch(/2 have no deal value recorded/);
    // Average is over the deal that had a value, not over all three.
    expect(p.averageOpenDealValue).toBe(5_000_000);
  });

  it('sector comparison: combines both boards per sector', async () => {
    const r = await ask('Which sectors are performing best?', [
      geminiToolCall('get_sector_analysis'),
      geminiText('Mining leads on pipeline; Railways carries the won value.'),
    ]);
    expect(r.toolsUsed).toEqual(['get_sector_analysis']);
    const s = r.toolResult();
    const mining = s.rows.find((x: { sector: string }) => x.sector === 'Mining');
    const rail = s.rows.find((x: { sector: string }) => x.sector === 'Railways');
    expect(mining.openPipelineValue).toBe(5_000_000);
    expect(mining.orderBookValue).toBe(3_000_000);
    expect(rail.wonValue).toBe(2_000_000);
    expect(rail.winRateByCount).toBe(50);
  });

  it('cross-board query: joins accounts and states the join caveat', async () => {
    const r = await ask('Which customers have both active work and open pipeline?', [
      geminiToolCall('get_cross_board_view', { only_with_both: true }),
      geminiText('Scooby-Doo has both pipeline and delivery.'),
    ]);
    expect(r.toolsUsed).toEqual(['get_cross_board_view']);
    const c = r.toolResult();
    expect(c.both).toBe(1);
    expect(c.customers[0].name).toBe('Scooby-Doo');
    expect(c.customers[0].openPipelineValue).toBe(5_000_000);
    expect(c.customers[0].orderBookValue).toBe(3_000_000);
    expect(c.matchKey).toBe('normalised deal name');
    expect(c.caveats.join(' ')).toMatch(/different customer code spaces/i);
  });

  it('data-quality question: surfaces completeness and warnings', async () => {
    const r = await ask('How reliable is this data?', [
      geminiToolCall('get_data_quality_report'),
      geminiText('2 of 5 deals have no value recorded.'),
    ]);
    expect(r.toolsUsed).toEqual(['get_data_quality_report']);
    const d = r.toolResult();
    expect(d.deals.warnings.join(' ')).toMatch(/no deal value/);
    expect(d).toHaveProperty('workOrders');
  });

  it('operational-risk question: returns ranked deterministic risks', async () => {
    const r = await ask('What operational risks should leadership know about?', [
      geminiToolCall('get_risk_analysis', { limit: 20 }),
      geminiText('One work order is paused, and two deals carry no value.'),
    ]);
    expect(r.toolsUsed).toEqual(['get_risk_analysis']);
    const risk = r.toolResult();
    const kinds = risk.risks.map((x: { kind: string }) => x.kind);
    expect(kinds).toContain('Work order paused or stuck');
    expect(risk.risks[0].severity).toBe('high'); // ranked
    expect(risk.caveats.join(' ')).toMatch(/not from a predictive model/i);
  });

  it('ambiguous question: the model can look up the real sector vocabulary', async () => {
    // "energy" is not a sector in this data; get_board_overview is how the
    // agent discovers what it can actually filter by before clarifying.
    const r = await ask("What's our exposure to the energy sector?", [
      geminiToolCall('get_board_overview'),
      geminiText('There is no "energy" sector. Did you mean Renewables or Powerline?'),
    ]);
    expect(r.toolsUsed).toEqual(['get_board_overview']);
    const o = r.toolResult();
    expect(o.sectors).toEqual(['Mining', 'Railways']);
    expect(r.answer).toMatch(/Did you mean/);
  });

  it('multi-tool turn: two tools in one round, both results returned', async () => {
    const twoCalls = new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { name: 'get_pipeline_metrics', args: {} } },
                { functionCall: { name: 'get_operational_metrics', args: {} } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const r = await ask('Give me a full picture.', [twoCalls, geminiText('Both boards summarised.')]);
    expect(r.toolsUsed).toEqual(['get_pipeline_metrics', 'get_operational_metrics']);
    expect(r.toolResult(0).openPipelineValue).toBe(5_000_000);
    expect(r.toolResult(1).orderBookValue).toBe(3_500_000);

    // Each response must sit in the same position as the call it answers.
    const responses = r.bodies
      .at(-1)!
      .contents.flatMap((c) => c.parts)
      .filter((p) => 'functionResponse' in p)
      .map((p) => (p as { functionResponse: { name: string } }).functionResponse.name);
    expect(responses).toEqual(['get_pipeline_metrics', 'get_operational_metrics']);
  });

  it('sends the system instruction and every tool on every request', async () => {
    const r = await ask('How is our pipeline?', [
      geminiToolCall('get_pipeline_metrics'),
      geminiText('Done.'),
    ]);
    expect(r.bodies).toHaveLength(2);
    for (const b of r.bodies) {
      // Nine monday.com tools plus three for uploaded datasets.
      expect(b.tools![0].functionDeclarations).toHaveLength(12);
      expect(b.systemInstruction.parts[0].text).toMatch(
        /never compute, estimate, or adjust a number yourself/i,
      );
    }
  });

  it('reports a Gemini quota failure as an error event, inventing no figures', async () => {
    const r = await ask('How is our pipeline?', [
      new Response(JSON.stringify({ error: { message: 'Quota exceeded. Please retry in 30s' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);
    expect(r.events[0].type).toBe('error');
    expect(r.events[0].message).toMatch(/gemini.*quota exceeded/i);
    expect(r.answer).toBe('');
  });

  it('feeds a monday.com tool failure back rather than aborting the turn', async () => {
    const r = await ask('Show me deals for a bad filter.', [
      geminiToolCall('not_a_real_tool'),
      geminiText('That is not something I can look up.'),
    ]);
    expect(r.events.at(-1)!.type).toBe('done');
    expect(JSON.stringify(r.toolResult())).toMatch(/Unknown tool/);
  });
});
