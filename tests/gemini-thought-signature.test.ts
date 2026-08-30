import { describe, expect, it, vi } from 'vitest';
import { GeminiProvider, toGeminiContents } from '@/lib/agent/providers/gemini';
import type { AgentMessage, ToolSpec } from '@/lib/agent/provider';

/**
 * Regression cover for Gemini thought signatures.
 *
 * The live failure was:
 *   HTTP 400 — "Function call is missing a thought_signature in functionCall
 *   parts. This is required for tools to work correctly."
 *
 * Gemini returns an opaque `thoughtSignature` alongside a `functionCall` and
 * requires it back, unchanged, on the model turn that replays that call. It is
 * carried through the neutral interface as provider-private metadata
 * (`ToolCall.providerMetadata`) so the agent loop, tools and analytics stay
 * vendor-neutral.
 *
 * Two invariants these tests defend:
 *   - the signature is preserved byte-for-byte, never generated or altered
 *   - it is emitted at PART level, as a sibling of `functionCall`, not nested
 *     inside it
 */

const SIG = 'CtAB1a2b3c4dSIGNATURE/opaque+base64==';
const SIG_2 = 'ZZZ9x8y7wSECOND/signature+value==';

const TOOLS: ToolSpec[] = [
  {
    name: 'get_pipeline_metrics',
    description: 'Pipeline metrics',
    parameters: { type: 'object', properties: { sector: { type: 'string' } } },
  },
];

const base = {
  system: 'SYSTEM',
  tools: TOOLS,
  messages: [{ role: 'user' as const, text: 'How is our pipeline?' }],
  maxTokens: 4096,
};

const res = (parts: unknown[], finishReason = 'STOP') =>
  new Response(JSON.stringify({ candidates: [{ content: { parts, role: 'model' }, finishReason }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const provider = (fetchImpl: typeof fetch) =>
  new GeminiProvider({ apiKey: 'k', model: 'gemini-3.5-flash', fetchImpl, maxAttempts: 1 });

/* ------------------------------ (a) decode -------------------------------- */

describe('(a) decoding a functionCall that carries a thought signature', () => {
  it('captures a part-level thoughtSignature into provider metadata', async () => {
    const f = vi.fn().mockResolvedValue(
      res([{ functionCall: { name: 'get_pipeline_metrics', args: {} }, thoughtSignature: SIG }]),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls[0].providerMetadata).toEqual({ thoughtSignature: SIG });
  });

  it('accepts the snake_case spelling Google uses in error text', async () => {
    const f = vi.fn().mockResolvedValue(
      res([{ functionCall: { name: 'get_pipeline_metrics', args: {} }, thought_signature: SIG }]),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls[0].providerMetadata).toEqual({ thoughtSignature: SIG });
  });

  it('also captures a signature nested inside functionCall rather than dropping it', async () => {
    const f = vi.fn().mockResolvedValue(
      res([{ functionCall: { name: 'get_pipeline_metrics', args: {}, thoughtSignature: SIG } }]),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls[0].providerMetadata).toEqual({ thoughtSignature: SIG });
  });
});

/* ------------------------- (b) full round trip ---------------------------- */

describe('(b) signature survives decode -> neutral -> encode', () => {
  it('replays the exact signature, byte for byte, at part level', async () => {
    const f = vi.fn().mockResolvedValue(
      res([{ functionCall: { name: 'get_pipeline_metrics', args: { sector: 'Mining' } }, thoughtSignature: SIG }]),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);

    const replay: AgentMessage[] = [
      { role: 'user', text: 'How is our pipeline?' },
      { role: 'assistant', text: '', toolCalls: turn.toolCalls },
      {
        role: 'tool_results',
        results: [
          { id: turn.toolCalls[0].id, name: 'get_pipeline_metrics', content: '{"v":1}', isError: false },
        ],
      },
    ];

    const modelTurn = toGeminiContents(replay)[1];
    const part = modelTurn.parts[0] as Record<string, unknown>;

    expect(part.thoughtSignature).toBe(SIG); // unchanged
    expect(part.functionCall).toEqual({ name: 'get_pipeline_metrics', args: { sector: 'Mining' } });
    // The signature must be a SIBLING of functionCall, never nested inside it —
    // nesting it is what the API rejects.
    expect(part.functionCall).not.toHaveProperty('thoughtSignature');
  });

  it('sends the signature over the wire on the follow-up request', async () => {
    const f = vi
      .fn()
      .mockImplementationOnce(async () =>
        res([{ functionCall: { name: 'get_pipeline_metrics', args: {} }, thoughtSignature: SIG }]),
      )
      .mockImplementationOnce(async () => res([{ text: 'Pipeline is healthy.' }]));

    const p = provider(f as unknown as typeof fetch);
    const first = await p.complete(base);
    await p.complete({
      ...base,
      messages: [
        { role: 'user', text: 'How is our pipeline?' },
        { role: 'assistant', text: '', toolCalls: first.toolCalls },
        {
          role: 'tool_results',
          results: [{ id: 'call_0', name: 'get_pipeline_metrics', content: '{"v":1}', isError: false }],
        },
      ],
    });

    const body = JSON.parse(f.mock.calls[1][1].body as string);
    const modelPart = body.contents[1].parts[0];
    expect(modelPart.thoughtSignature).toBe(SIG);
  });
});

/* -------------------- (c) multiple calls, own signatures ------------------ */

describe('(c) each function call keeps its own signature', () => {
  it('does not cross-assign signatures between parallel calls', async () => {
    const f = vi.fn().mockResolvedValue(
      res([
        { functionCall: { name: 'get_pipeline_metrics', args: {} }, thoughtSignature: SIG },
        { functionCall: { name: 'get_sector_analysis', args: {} }, thoughtSignature: SIG_2 },
      ]),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls[0].providerMetadata).toEqual({ thoughtSignature: SIG });
    expect(turn.toolCalls[1].providerMetadata).toEqual({ thoughtSignature: SIG_2 });

    const parts = toGeminiContents([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: '', toolCalls: turn.toolCalls },
    ])[1].parts as Array<Record<string, unknown>>;
    expect(parts[0].thoughtSignature).toBe(SIG);
    expect(parts[1].thoughtSignature).toBe(SIG_2);
  });

  it('handles a mix of signed and unsigned calls in one turn', async () => {
    const f = vi.fn().mockResolvedValue(
      res([
        { functionCall: { name: 'get_pipeline_metrics', args: {} }, thoughtSignature: SIG },
        { functionCall: { name: 'get_sector_analysis', args: {} } },
      ]),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls[0].providerMetadata).toEqual({ thoughtSignature: SIG });
    expect(turn.toolCalls[1].providerMetadata).toBeUndefined();

    const parts = toGeminiContents([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: '', toolCalls: turn.toolCalls },
    ])[1].parts as Array<Record<string, unknown>>;
    expect(parts[0].thoughtSignature).toBe(SIG);
    expect(parts[1]).not.toHaveProperty('thoughtSignature');
  });
});

/* ------------------ (d) same tool twice, different args ------------------- */

describe('(d) same tool called twice with different arguments', () => {
  it('keeps arguments and signatures aligned to their own calls', async () => {
    const f = vi.fn().mockResolvedValue(
      res([
        { functionCall: { name: 'get_pipeline_metrics', args: { sector: 'Mining' } }, thoughtSignature: SIG },
        { functionCall: { name: 'get_pipeline_metrics', args: { sector: 'Railways' } }, thoughtSignature: SIG_2 },
      ]),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls.map((t) => t.id)).toEqual(['call_0', 'call_1']);

    const parts = toGeminiContents([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: '', toolCalls: turn.toolCalls },
    ])[1].parts as Array<Record<string, unknown>>;

    expect((parts[0].functionCall as { args: unknown }).args).toEqual({ sector: 'Mining' });
    expect(parts[0].thoughtSignature).toBe(SIG);
    expect((parts[1].functionCall as { args: unknown }).args).toEqual({ sector: 'Railways' });
    expect(parts[1].thoughtSignature).toBe(SIG_2);
  });
});

/* ------------------- (e) reordered / missing / orphan --------------------- */

describe('(e) result pairing still holds with signatures present', () => {
  const signedCalls = [
    { id: 'call_0', name: 'get_pipeline_metrics', input: { sector: 'Mining' }, providerMetadata: { thoughtSignature: SIG } },
    { id: 'call_1', name: 'get_pipeline_metrics', input: { sector: 'Railways' }, providerMetadata: { thoughtSignature: SIG_2 } },
  ];

  it('restores call order when results arrive reversed', () => {
    const contents = toGeminiContents([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: '', toolCalls: signedCalls },
      {
        role: 'tool_results',
        results: [
          { id: 'call_1', name: 'get_pipeline_metrics', content: '{"s":"Railways"}', isError: false },
          { id: 'call_0', name: 'get_pipeline_metrics', content: '{"s":"Mining"}', isError: false },
        ],
      },
    ]);
    const responses = contents[2].parts.map((p) => p.functionResponse!.response);
    expect(responses[0]).toEqual({ s: 'Mining' });
    expect(responses[1]).toEqual({ s: 'Railways' });
    // Signatures on the model turn are unaffected by result ordering.
    const parts = contents[1].parts as Array<Record<string, unknown>>;
    expect(parts[0].thoughtSignature).toBe(SIG);
    expect(parts[1].thoughtSignature).toBe(SIG_2);
  });

  it('emits an explicit error for a missing result, keeping counts aligned', () => {
    const contents = toGeminiContents([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: '', toolCalls: signedCalls },
      {
        role: 'tool_results',
        results: [{ id: 'call_0', name: 'get_pipeline_metrics', content: '{"s":"Mining"}', isError: false }],
      },
    ]);
    expect(contents[2].parts).toHaveLength(2);
    expect(contents[2].parts[1].functionResponse!.response).toEqual({
      error: 'No result was produced for this tool call.',
    });
  });

  it('appends an orphan result rather than dropping it', () => {
    const contents = toGeminiContents([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: '', toolCalls: [signedCalls[0]] },
      {
        role: 'tool_results',
        results: [
          { id: 'call_0', name: 'get_pipeline_metrics', content: '{"a":1}', isError: false },
          { id: 'ghost', name: 'other', content: '{"b":2}', isError: false },
        ],
      },
    ]);
    expect(contents[2].parts).toHaveLength(2);
  });
});

/* --------------------------- (f) multiple rounds -------------------------- */

describe('(f) signatures across multiple agent rounds', () => {
  it('keeps each round’s signature on its own model turn', () => {
    const contents = toGeminiContents([
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'call_0', name: 'a', input: {}, providerMetadata: { thoughtSignature: SIG } }],
      },
      { role: 'tool_results', results: [{ id: 'call_0', name: 'a', content: '{"r":1}', isError: false }] },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'call_0', name: 'b', input: {}, providerMetadata: { thoughtSignature: SIG_2 } }],
      },
      { role: 'tool_results', results: [{ id: 'call_0', name: 'b', content: '{"r":2}', isError: false }] },
    ]);

    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
    expect((contents[1].parts[0] as Record<string, unknown>).thoughtSignature).toBe(SIG);
    expect((contents[3].parts[0] as Record<string, unknown>).thoughtSignature).toBe(SIG_2);
    // Round 2's response pairs with round 2's call.
    expect(contents[4].parts[0].functionResponse!.response).toEqual({ r: 2 });
  });
});

/* ------------------------ (g) final text response ------------------------- */

describe('(g) ordinary text responses still work', () => {
  it('returns a final answer with no tool calls or metadata', async () => {
    const f = vi.fn().mockResolvedValue(res([{ text: 'Open pipeline is ₹73.92 Cr.' }]));
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.text).toEqual(['Open pipeline is ₹73.92 Cr.']);
    expect(turn.toolCalls).toEqual([]);
  });

  it('produces a final answer after a signed tool round', async () => {
    const f = vi
      .fn()
      .mockImplementationOnce(async () =>
        res([{ functionCall: { name: 'get_pipeline_metrics', args: {} }, thoughtSignature: SIG }]),
      )
      .mockImplementationOnce(async () => res([{ text: 'Pipeline is ₹73.92 Cr across 134 open deals.' }]));

    const p = provider(f as unknown as typeof fetch);
    const first = await p.complete(base);
    const second = await p.complete({
      ...base,
      messages: [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: '', toolCalls: first.toolCalls },
        {
          role: 'tool_results',
          results: [{ id: 'call_0', name: 'get_pipeline_metrics', content: '{"v":1}', isError: false }],
        },
      ],
    });
    expect(second.text[0]).toMatch(/₹73.92 Cr/);
    expect(second.toolCalls).toEqual([]);
  });
});

/* ---------------------- (h) unsigned calls, no faking --------------------- */

describe('(h) a functionCall without a signature is never fabricated', () => {
  it('leaves provider metadata undefined', async () => {
    const f = vi.fn().mockResolvedValue(res([{ functionCall: { name: 'get_pipeline_metrics', args: {} } }]));
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls[0].providerMetadata).toBeUndefined();
  });

  it('omits the field entirely on the wire rather than sending a placeholder', () => {
    const parts = toGeminiContents([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_0', name: 'a', input: {} }] },
    ])[1].parts as Array<Record<string, unknown>>;

    expect(parts[0]).not.toHaveProperty('thoughtSignature');
    expect(parts[0]).not.toHaveProperty('thought_signature');
    expect(JSON.stringify(parts[0])).not.toMatch(/signature/i);
  });

  it('ignores a non-string metadata value instead of coercing it', () => {
    const parts = toGeminiContents([
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'call_0', name: 'a', input: {}, providerMetadata: { thoughtSignature: 12345 } }],
      },
    ])[1].parts as Array<Record<string, unknown>>;
    expect(parts[0]).not.toHaveProperty('thoughtSignature');
  });
});

/* ------------------- (13) the exact live failure shape -------------------- */

describe('(13) the wire shape that caused the live 400', () => {
  /**
   * Reproduces the real sequence: gemini-3.5-flash returns a functionCall with
   * a thoughtSignature; replaying that turn WITHOUT the signature is what the
   * API rejected with "Function call is missing a thought_signature in
   * functionCall parts."
   */
  it('replays the signature that was previously dropped', async () => {
    const live = res([
      {
        functionCall: { name: 'get_pipeline_metrics', args: {} },
        thoughtSignature: SIG,
      },
    ]);
    const f = vi
      .fn()
      .mockImplementationOnce(async () => live)
      .mockImplementationOnce(async () => res([{ text: 'done' }]));

    const p = provider(f as unknown as typeof fetch);
    const turn = await p.complete(base);
    await p.complete({
      ...base,
      messages: [
        { role: 'user', text: 'How is our pipeline looking?' },
        { role: 'assistant', text: '', toolCalls: turn.toolCalls },
        {
          role: 'tool_results',
          results: [
            { id: 'call_0', name: 'get_pipeline_metrics', content: '{"openPipelineValue":739216029}', isError: false },
          ],
        },
      ],
    });

    const body = JSON.parse(f.mock.calls[1][1].body as string);
    const modelPart = body.contents[1].parts[0];

    // Every condition the API enforces.
    expect(modelPart.thoughtSignature).toBe(SIG);
    expect(modelPart.functionCall.name).toBe('get_pipeline_metrics');
    expect(modelPart.functionCall).not.toHaveProperty('thoughtSignature');
    expect(body.contents[2].parts[0].functionResponse.response).toEqual({
      openPipelineValue: 739216029,
    });
  });
});
