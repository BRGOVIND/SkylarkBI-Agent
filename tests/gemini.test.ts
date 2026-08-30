import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  GeminiProvider,
  parseGeminiRetryAfter,
  toGeminiContents,
  toGeminiSchema,
  toFunctionDeclarations,
  modelPath,
} from '@/lib/agent/providers/gemini';
import { LlmError, type AgentMessage, type ToolSpec } from '@/lib/agent/provider';
import { resolveProvider, modelFor, configStatus, DEFAULT_MODELS } from '@/lib/config';
import { createProvider } from '@/lib/agent/factory';
import { TOOL_DEFINITIONS } from '@/lib/agent/tools';

/**
 * Native Gemini adapter coverage. No live API key is used anywhere — every
 * request is served by an injected fetch stub.
 */

const TOOLS: ToolSpec[] = [
  {
    name: 'get_pipeline_metrics',
    description: 'Pipeline metrics',
    parameters: {
      type: 'object',
      properties: { sector: { type: 'string', description: 'Sector filter' } },
    },
  },
];

const base = {
  system: 'SYSTEM',
  tools: TOOLS,
  messages: [{ role: 'user' as const, text: 'How is our pipeline?' }],
  maxTokens: 4096,
};

const ok = (parts: unknown[], finishReason = 'STOP') =>
  new Response(JSON.stringify({ candidates: [{ content: { parts, role: 'model' }, finishReason }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const errorRes = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message, code: status } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const provider = (fetchImpl: typeof fetch, opts: Record<string, unknown> = {}) =>
  new GeminiProvider({
    apiKey: 'test-key',
    model: 'gemini-2.5-flash',
    fetchImpl,
    maxAttempts: 1,
    ...opts,
  });

const bodyOf = (f: ReturnType<typeof vi.fn>, i = 0) => JSON.parse(f.mock.calls[i][1].body as string);

/* ------------------------------- endpoint --------------------------------- */

describe('native Gemini request', () => {
  it('posts to the native generateContent endpoint for the model', async () => {
    const f = vi.fn().mockResolvedValue(ok([{ text: 'ok' }]));
    await provider(f as unknown as typeof fetch).complete(base);
    expect(f.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
  });

  it('accepts a model id with or without the models/ prefix', () => {
    expect(modelPath('gemini-2.5-flash')).toBe('models/gemini-2.5-flash');
    expect(modelPath('models/gemini-3.7-flash')).toBe('models/gemini-3.7-flash');
  });

  it('sends the API key as a header, never in the URL or body', async () => {
    const f = vi.fn().mockResolvedValue(ok([{ text: 'ok' }]));
    await provider(f as unknown as typeof fetch).complete(base);
    const [url, init] = f.mock.calls[0];
    expect((init as RequestInit).headers as Record<string, string>).toMatchObject({
      'x-goog-api-key': 'test-key',
    });
    expect(String(url)).not.toContain('test-key');
    expect((init as RequestInit).body as string).not.toContain('test-key');
  });

  it('passes the system prompt via systemInstruction', async () => {
    const f = vi.fn().mockResolvedValue(ok([{ text: 'ok' }]));
    await provider(f as unknown as typeof fetch).complete(base);
    expect(bodyOf(f).systemInstruction).toEqual({ parts: [{ text: 'SYSTEM' }] });
  });

  it('declares tools with AUTO function-calling mode', async () => {
    const f = vi.fn().mockResolvedValue(ok([{ text: 'ok' }]));
    await provider(f as unknown as typeof fetch).complete(base);
    const b = bodyOf(f);
    expect(b.tools[0].functionDeclarations[0].name).toBe('get_pipeline_metrics');
    expect(b.toolConfig.functionCallingConfig.mode).toBe('AUTO');
    expect(b.generationConfig.maxOutputTokens).toBe(4096);
  });

  it('carries all nine BI tools', async () => {
    const f = vi.fn().mockResolvedValue(ok([{ text: 'ok' }]));
    await provider(f as unknown as typeof fetch).complete({ ...base, tools: TOOL_DEFINITIONS });
    const decls = bodyOf(f).tools[0].functionDeclarations;
    expect(decls).toHaveLength(9);
    expect(decls.map((d: { name: string }) => d.name)).toEqual(TOOL_DEFINITIONS.map((t) => t.name));
  });
});

/* ---------------------------- schema conversion --------------------------- */

describe('JSON Schema -> Gemini schema', () => {
  it('upper-cases types as the REST enum requires', () => {
    expect(toGeminiSchema({ type: 'string' })).toEqual({ type: 'STRING' });
    expect(toGeminiSchema({ type: 'integer' })).toEqual({ type: 'INTEGER' });
    expect(toGeminiSchema({ type: 'boolean' })).toEqual({ type: 'BOOLEAN' });
  });

  it('keeps descriptions, enums and required', () => {
    const s = toGeminiSchema({
      type: 'object',
      properties: { period: { type: 'string', enum: ['a', 'b'], description: 'when' } },
      required: ['period'],
    });
    expect(s).toEqual({
      type: 'OBJECT',
      properties: { period: { type: 'STRING', enum: ['a', 'b'], description: 'when' } },
      required: ['period'],
    });
  });

  it('drops keywords Gemini does not accept', () => {
    const s = toGeminiSchema({
      type: 'object',
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
      default: {},
      properties: { a: { type: 'string' } },
    });
    expect(s).not.toHaveProperty('additionalProperties');
    expect(s).not.toHaveProperty('$schema');
    expect(s).not.toHaveProperty('default');
  });

  it('omits parameters entirely for a no-argument tool', () => {
    // Gemini rejects an OBJECT schema with an empty properties map.
    const decls = toFunctionDeclarations([
      { name: 'get_board_overview', description: 'overview', parameters: { type: 'object', properties: {} } },
    ]);
    expect(decls[0]).not.toHaveProperty('parameters');
    expect(decls[0].name).toBe('get_board_overview');
  });

  it('converts all nine real tool schemas without producing an empty OBJECT', () => {
    for (const d of toFunctionDeclarations(TOOL_DEFINITIONS)) {
      if ('parameters' in d) {
        const p = d.parameters as { type: string; properties: Record<string, unknown> };
        expect(p.type).toBe('OBJECT');
        expect(Object.keys(p.properties).length).toBeGreaterThan(0);
      }
    }
  });
});

/* --------------------- tool-call correlation (the crux) ------------------- */

describe('tool-call correlation without vendor ids', () => {
  it('assigns positional ids to returned function calls', async () => {
    const f = vi.fn().mockResolvedValue(
      ok([
        { functionCall: { name: 'get_pipeline_metrics', args: { sector: 'Mining' } } },
        { functionCall: { name: 'get_sector_analysis', args: {} } },
      ]),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls.map((t) => t.id)).toEqual(['call_0', 'call_1']);
    expect(turn.toolCalls[0].input).toEqual({ sector: 'Mining' });
  });

  it('keeps two calls to the SAME tool distinct', async () => {
    const f = vi.fn().mockResolvedValue(
      ok([
        { functionCall: { name: 'get_pipeline_metrics', args: { sector: 'Mining' } } },
        { functionCall: { name: 'get_pipeline_metrics', args: { sector: 'Railways' } } },
      ]),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(new Set(turn.toolCalls.map((t) => t.id)).size).toBe(2);
    expect(turn.toolCalls[0].input).toEqual({ sector: 'Mining' });
    expect(turn.toolCalls[1].input).toEqual({ sector: 'Railways' });
  });

  it('emits function responses in CALL order, not arrival order', async () => {
    // The decisive test: same tool twice, results supplied reversed.
    const messages: AgentMessage[] = [
      { role: 'user', text: 'compare sectors' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'call_0', name: 'get_pipeline_metrics', input: { sector: 'Mining' } },
          { id: 'call_1', name: 'get_pipeline_metrics', input: { sector: 'Railways' } },
        ],
      },
      {
        role: 'tool_results',
        results: [
          { id: 'call_1', name: 'get_pipeline_metrics', content: '{"sector":"Railways","v":2}', isError: false },
          { id: 'call_0', name: 'get_pipeline_metrics', content: '{"sector":"Mining","v":1}', isError: false },
        ],
      },
    ];
    const contents = toGeminiContents(messages);
    const responses = contents[2].parts.map((p) => p.functionResponse!.response);
    // Restored to call order despite arriving reversed.
    expect(responses[0]).toEqual({ sector: 'Mining', v: 1 });
    expect(responses[1]).toEqual({ sector: 'Railways', v: 2 });
  });

  it('emits an explicit error response when a call has no result', () => {
    const contents = toGeminiContents([
      { role: 'user', text: 'x' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'call_0', name: 'a', input: {} },
          { id: 'call_1', name: 'b', input: {} },
        ],
      },
      { role: 'tool_results', results: [{ id: 'call_0', name: 'a', content: '{"ok":1}', isError: false }] },
    ]);
    const parts = contents[2].parts;
    expect(parts).toHaveLength(2); // never silently drops the unanswered call
    expect(parts[1].functionResponse!.response).toEqual({
      error: 'No result was produced for this tool call.',
    });
  });

  it('appends an orphan result rather than discarding it', () => {
    const contents = toGeminiContents([
      { role: 'user', text: 'x' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_0', name: 'a', input: {} }] },
      {
        role: 'tool_results',
        results: [
          { id: 'call_0', name: 'a', content: '{"ok":1}', isError: false },
          { id: 'ghost', name: 'b', content: '{"ok":2}', isError: false },
        ],
      },
    ]);
    expect(contents[2].parts).toHaveLength(2);
  });

  it('maps roles correctly: user, model for calls, user for responses', () => {
    const contents = toGeminiContents([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_0', name: 'a', input: {} }] },
      { role: 'tool_results', results: [{ id: 'call_0', name: 'a', content: '{}', isError: false }] },
    ]);
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(contents[1].parts[0].functionCall).toEqual({ name: 'a', args: {} });
    expect(contents[2].parts[0].functionResponse!.name).toBe('a');
  });

  it('wraps a non-object tool result in a struct, as Gemini requires', () => {
    const contents = toGeminiContents([
      { role: 'user', text: 'x' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_0', name: 'a', input: {} }] },
      { role: 'tool_results', results: [{ id: 'call_0', name: 'a', content: 'not json', isError: true }] },
    ]);
    expect(contents[2].parts[0].functionResponse!.response).toEqual({ result: 'not json' });
  });

  it('carries assistant text alongside its function calls', () => {
    const contents = toGeminiContents([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'Checking.', toolCalls: [{ id: 'call_0', name: 'a', input: {} }] },
    ]);
    expect(contents[1].parts[0]).toEqual({ text: 'Checking.' });
    expect(contents[1].parts[1].functionCall!.name).toBe('a');
  });

  it('survives several rounds of calls and results', () => {
    const contents = toGeminiContents([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_0', name: 'a', input: {} }] },
      { role: 'tool_results', results: [{ id: 'call_0', name: 'a', content: '{"r":1}', isError: false }] },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_0', name: 'b', input: {} }] },
      { role: 'tool_results', results: [{ id: 'call_0', name: 'b', content: '{"r":2}', isError: false }] },
    ]);
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
    // Round 2's response must pair with round 2's call, not round 1's.
    expect(contents[4].parts[0].functionResponse!.name).toBe('b');
    expect(contents[4].parts[0].functionResponse!.response).toEqual({ r: 2 });
  });
});

/* ------------------------------- responses -------------------------------- */

describe('native Gemini responses', () => {
  it('returns a final text answer', async () => {
    const f = vi.fn().mockResolvedValue(ok([{ text: 'Pipeline is ₹4.2 Cr.' }]));
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.text).toEqual(['Pipeline is ₹4.2 Cr.']);
    expect(turn.toolCalls).toEqual([]);
  });

  it('ignores thought parts', async () => {
    const f = vi.fn().mockResolvedValue(ok([{ text: 'internal', thought: true }, { text: 'answer' }]));
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.text).toEqual(['answer']);
  });

  it('handles a turn with both text and a function call', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(ok([{ text: 'Checking.' }, { functionCall: { name: 'get_pipeline_metrics', args: {} } }]));
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.text).toEqual(['Checking.']);
    expect(turn.toolCalls).toHaveLength(1);
  });

  it('defaults absent args to an empty object', async () => {
    const f = vi.fn().mockResolvedValue(ok([{ functionCall: { name: 'get_board_overview' } }]));
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls[0].input).toEqual({});
  });
});

/* -------------------------------- errors ---------------------------------- */

describe('native Gemini error handling', () => {
  it('reports a rejected key without retrying', async () => {
    const f = vi.fn().mockResolvedValue(errorRes(401, 'API key not valid'));
    await expect(provider(f as unknown as typeof fetch, { maxAttempts: 3 }).complete(base)).rejects.toThrow(
      /rejected the API key/i,
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('relays quota text and the stated retry delay', async () => {
    const f = vi.fn().mockResolvedValue(errorRes(429, 'Quota exceeded for quota metric X. Please retry in 41.6s'));
    const err = await provider(f as unknown as typeof fetch)
      .complete(base)
      .then(() => null)
      .catch((e: LlmError) => e);
    expect(err!.message).toMatch(/quota metric X/);
    expect(err!.retryAfterMs).toBe(41_600);
  });

  it('retries a 429 then succeeds, bounded', async () => {
    const f = vi
      .fn()
      .mockImplementationOnce(async () => errorRes(429, 'Quota exceeded. Please retry in 0.01s'))
      .mockImplementationOnce(async () => ok([{ text: 'Recovered.' }]));
    const turn = await provider(f as unknown as typeof fetch, { maxAttempts: 3, maxBackoffMs: 20 }).complete(base);
    expect(turn.text).toEqual(['Recovered.']);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('never retries forever', async () => {
    const f = vi.fn().mockImplementation(async () => errorRes(429, 'Quota exceeded'));
    await expect(
      provider(f as unknown as typeof fetch, { maxAttempts: 3, maxBackoffMs: 10 }).complete(base),
    ).rejects.toThrow(/quota exceeded/i);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('names the model and the listing command on a 404', async () => {
    const f = vi.fn().mockResolvedValue(errorRes(404, 'not found'));
    const err = await provider(f as unknown as typeof fetch)
      .complete(base)
      .then(() => null)
      .catch((e: Error) => e);
    expect(err!.message).toMatch(/gemini-2\.5-flash" was not found/);
    expect(err!.message).toMatch(/npm run gemini:models/);
  });

  it('surfaces a blocked prompt', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 }),
    );
    await expect(provider(f as unknown as typeof fetch).complete(base)).rejects.toThrow(/blocked.*SAFETY/i);
  });

  it('explains an empty MAX_TOKENS response', async () => {
    const f = vi.fn().mockResolvedValue(ok([], 'MAX_TOKENS'));
    await expect(provider(f as unknown as typeof fetch).complete(base)).rejects.toThrow(
      /output limit before producing an answer/i,
    );
  });

  it('surfaces a malformed function call', async () => {
    const f = vi.fn().mockResolvedValue(ok([{ text: 'x' }], 'MALFORMED_FUNCTION_CALL'));
    await expect(provider(f as unknown as typeof fetch).complete(base)).rejects.toThrow(
      /malformed function call/i,
    );
  });

  it('handles no candidates, non-JSON, and network failure', async () => {
    const none = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
    await expect(provider(none as unknown as typeof fetch).complete(base)).rejects.toThrow(/no candidates/i);

    const html = vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 200 }));
    await expect(provider(html as unknown as typeof fetch).complete(base)).rejects.toThrow(/non-JSON/);

    const dead = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(provider(dead as unknown as typeof fetch).complete(base)).rejects.toThrow(/Network error/);
  });

  it('does not leak the key in error messages', async () => {
    const f = vi.fn().mockResolvedValue(errorRes(401, 'API key not valid'));
    const err = await provider(f as unknown as typeof fetch)
      .complete(base)
      .then(() => null)
      .catch((e: Error) => e);
    expect(err!.message).not.toContain('test-key');
  });

  it('parses the retry delay from either wording', () => {
    expect(parseGeminiRetryAfter(null, 'Please retry in 41.6s')).toBe(41_600);
    expect(parseGeminiRetryAfter(null, '"retryDelay": "45s"')).toBe(45_000);
    expect(parseGeminiRetryAfter('30', undefined)).toBe(30_000);
    expect(parseGeminiRetryAfter(null, 'Quota exceeded')).toBeUndefined();
  });
});

/* ----------------------------- configuration ------------------------------ */

describe('Gemini provider selection', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    for (const k of [
      'LLM_PROVIDER', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY',
      'GEMINI_MODEL', 'GROQ_MODEL', 'ANTHROPIC_MODEL',
    ]) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  it('selects gemini explicitly and by key inference', () => {
    expect(resolveProvider({ LLM_PROVIDER: 'gemini' })).toBe('gemini');
    expect(resolveProvider({ GEMINI_API_KEY: 'x' })).toBe('gemini');
    expect(resolveProvider({ GEMINI_API_KEY: 'x', GROQ_API_KEY: 'y' })).toBe('gemini');
  });

  it('still resolves the other providers', () => {
    expect(resolveProvider({ LLM_PROVIDER: 'groq' })).toBe('groq');
    expect(resolveProvider({ LLM_PROVIDER: 'anthropic' })).toBe('anthropic');
    expect(resolveProvider({})).toBe('anthropic');
  });

  it('honours GEMINI_MODEL over the default', () => {
    expect(modelFor('gemini', {})).toBe(DEFAULT_MODELS.gemini);
    expect(modelFor('gemini', { GEMINI_MODEL: 'gemini-3.7-flash' })).toBe('gemini-3.7-flash');
    expect(modelFor('gemini', { GEMINI_MODEL: '  gemini-3.5-flash  ' })).toBe('gemini-3.5-flash');
    expect(modelFor('gemini', { GEMINI_MODEL: '   ' })).toBe(DEFAULT_MODELS.gemini);
  });

  it('does not let another provider’s model variable bleed through', () => {
    expect(modelFor('gemini', { GROQ_MODEL: 'x', ANTHROPIC_MODEL: 'y' })).toBe(DEFAULT_MODELS.gemini);
  });

  it('carries an overridden GEMINI_MODEL into the request URL', async () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_MODEL = 'gemini-3.7-flash';
    const m = modelFor(resolveProvider());
    const f = vi.fn().mockResolvedValue(ok([{ text: 'ok' }]));
    await new GeminiProvider({
      apiKey: 'k',
      model: m,
      fetchImpl: f as unknown as typeof fetch,
      maxAttempts: 1,
    }).complete(base);
    expect(f.mock.calls[0][0]).toContain('models/gemini-3.7-flash:generateContent');
  });

  it('requires only the Gemini key', () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'gem_test';
    process.env.MONDAY_API_TOKEN = 't';
    process.env.MONDAY_DEALS_BOARD_ID = '1';
    process.env.MONDAY_WORK_ORDERS_BOARD_ID = '2';
    const s = configStatus();
    expect(s.ok).toBe(true);
    expect(s.provider).toBe('gemini');
    expect(s.missing).toEqual([]);
  });

  it('the factory builds a Gemini adapter behind the neutral interface', () => {
    const p = createProvider({
      mondayToken: 't', mondayApiVersion: '2024-10',
      dealsBoardId: '1', workOrdersBoardId: '2',
      llm: { provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash' },
      cacheTtlSeconds: 300,
    });
    expect(p.providerName).toBe('gemini');
    expect(typeof p.complete).toBe('function');
  });
});

/* ------------------- provider-conditional setup reporting ----------------- */

describe('setup reporting names only the relevant provider', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    for (const k of [
      'LLM_PROVIDER', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY',
      'MONDAY_API_TOKEN', 'MONDAY_DEALS_BOARD_ID', 'MONDAY_WORK_ORDERS_BOARD_ID',
    ]) delete process.env[k];
    process.env.MONDAY_API_TOKEN = 't';
    process.env.MONDAY_DEALS_BOARD_ID = '1';
    process.env.MONDAY_WORK_ORDERS_BOARD_ID = '2';
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  it('asks for the Gemini key when Gemini is selected', () => {
    process.env.LLM_PROVIDER = 'gemini';
    expect(configStatus().missing).toEqual(['GEMINI_API_KEY']);
  });

  it('never mentions Anthropic when Gemini is selected', () => {
    process.env.LLM_PROVIDER = 'gemini';
    expect(configStatus().missing.join(' ')).not.toMatch(/ANTHROPIC/);
  });

  it('asks for the Groq key when Groq is selected', () => {
    process.env.LLM_PROVIDER = 'groq';
    expect(configStatus().missing).toEqual(['GROQ_API_KEY']);
  });

  it('reports a neutral requirement when no provider is chosen and no key exists', () => {
    // Naming ANTHROPIC_API_KEY here would mislead an operator who intends to
    // use Gemini — the default is an inference, not a decision they made.
    const missing = configStatus().missing;
    expect(missing).toEqual(['LLM_PROVIDER and its matching API key']);
    expect(missing.join(' ')).not.toMatch(/ANTHROPIC|GEMINI|GROQ/);
  });

  it('names the inferred provider key once a key is present', () => {
    process.env.ANTHROPIC_API_KEY = 'x';
    expect(configStatus().ok).toBe(true);
    expect(configStatus().provider).toBe('anthropic');
  });

  it('is ok with only the selected provider key set', () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'g';
    const s = configStatus();
    expect(s.ok).toBe(true);
    expect(s.missing).toEqual([]);
  });
});

/* -------------- loadConfig reports the same thing as configStatus --------- */

describe('the chat path reports the same missing config as the health path', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    for (const k of [
      'LLM_PROVIDER', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY',
      'MONDAY_API_TOKEN', 'MONDAY_DEALS_BOARD_ID', 'MONDAY_WORK_ORDERS_BOARD_ID',
    ]) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  it('does not name Anthropic when nothing at all is configured', async () => {
    const { loadConfig } = await import('@/lib/config');
    // The chat route surfaces this message to the user, so it must not send
    // someone who intends to use Gemini off to create an Anthropic key.
    try {
      loadConfig();
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toMatch(/ANTHROPIC_API_KEY/);
      expect(msg).toMatch(/LLM_PROVIDER and its matching API key/);
    }
  });

  it('names the Gemini key once Gemini is the chosen provider', async () => {
    process.env.LLM_PROVIDER = 'gemini';
    const { loadConfig } = await import('@/lib/config');
    try {
      loadConfig();
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/GEMINI_API_KEY/);
      expect((err as Error).message).not.toMatch(/ANTHROPIC/);
    }
  });

  it('agrees with configStatus on the same environment', async () => {
    const { loadConfig, configStatus } = await import('@/lib/config');
    const fromStatus = configStatus().missing;
    let fromLoad: string[] = [];
    try {
      loadConfig();
    } catch (err) {
      fromLoad = (err as { missing: string[] }).missing;
    }
    expect(fromLoad.sort()).toEqual(fromStatus.sort());
  });
});
