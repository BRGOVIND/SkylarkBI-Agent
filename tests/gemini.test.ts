import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GeminiProvider, parseGeminiRetryAfter } from '@/lib/agent/providers/gemini';
import { toOpenAiMessages, toOpenAiTools, decodeAssistantMessage } from '@/lib/agent/providers/openai-wire';
import { LlmError, type AgentMessage, type ToolSpec } from '@/lib/agent/provider';
import { resolveProvider, modelFor, configStatus, DEFAULT_MODELS } from '@/lib/config';
import { createProvider } from '@/lib/agent/factory';
import { TOOL_DEFINITIONS } from '@/lib/agent/tools';

/**
 * Gemini adapter coverage. No live API key is required anywhere in this file —
 * every request is served by an injected fetch stub.
 */

const TOOLS: ToolSpec[] = [
  {
    name: 'get_pipeline_metrics',
    description: 'Pipeline metrics',
    parameters: { type: 'object', properties: { sector: { type: 'string' } } },
  },
];

const CONVERSATION: AgentMessage[] = [
  { role: 'user', text: 'How is our pipeline?' },
  {
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'call_1', name: 'get_pipeline_metrics', input: { sector: 'Mining' } }],
  },
  {
    role: 'tool_results',
    results: [
      { id: 'call_1', name: 'get_pipeline_metrics', content: '{"openPipelineValue":100}', isError: false },
    ],
  },
];

const chat = (message: unknown) =>
  new Response(JSON.stringify({ choices: [{ message }] }), {
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

const base = { system: 'SYSTEM', tools: TOOLS, messages: CONVERSATION, maxTokens: 4096 };

/* ------------------------------ wire format ------------------------------- */

describe('Gemini request shape', () => {
  it('posts to the Gemini OpenAI-compatibility endpoint', async () => {
    const f = vi.fn().mockResolvedValue(chat({ content: 'ok' }));
    await provider(f as unknown as typeof fetch).complete(base);
    expect(f.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
  });

  it('sends the model, tools and tool_choice', async () => {
    const f = vi.fn().mockResolvedValue(chat({ content: 'ok' }));
    await provider(f as unknown as typeof fetch).complete(base);
    const body = JSON.parse(f.mock.calls[0][1].body as string);
    expect(body.model).toBe('gemini-2.5-flash');
    expect(body.tool_choice).toBe('auto');
    expect(body.tools[0].type).toBe('function');
    expect(body.max_tokens).toBe(4096);
  });

  it('passes the system instruction as the first message', async () => {
    const f = vi.fn().mockResolvedValue(chat({ content: 'ok' }));
    await provider(f as unknown as typeof fetch).complete(base);
    const body = JSON.parse(f.mock.calls[0][1].body as string);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYSTEM' });
  });

  it('carries all nine BI tools without dropping any', async () => {
    const f = vi.fn().mockResolvedValue(chat({ content: 'ok' }));
    await provider(f as unknown as typeof fetch).complete({ ...base, tools: TOOL_DEFINITIONS });
    const body = JSON.parse(f.mock.calls[0][1].body as string);
    expect(body.tools).toHaveLength(9);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(
      TOOL_DEFINITIONS.map((t) => t.name),
    );
  });

  it('preserves each tool JSON Schema intact', () => {
    const fns = toOpenAiTools(TOOL_DEFINITIONS);
    for (const [i, f] of fns.entries()) {
      expect(f.function.parameters).toEqual(TOOL_DEFINITIONS[i].parameters);
    }
  });

  it('round-trips a multi-turn conversation including tool results', async () => {
    const f = vi.fn().mockResolvedValue(chat({ content: 'ok' }));
    await provider(f as unknown as typeof fetch).complete(base);
    const body = JSON.parse(f.mock.calls[0][1].body as string);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(body.messages[3].tool_call_id).toBe('call_1');
  });
});

/* ------------------------------ tool calling ------------------------------ */

describe('Gemini tool calling', () => {
  it('decodes a single function call with its arguments', async () => {
    const f = vi.fn().mockResolvedValue(
      chat({
        content: null,
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_pipeline_metrics', arguments: '{"sector":"Mining"}' },
          },
        ],
      }),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].name).toBe('get_pipeline_metrics');
    expect(turn.toolCalls[0].input).toEqual({ sector: 'Mining' });
    expect(turn.toolCalls[0].parseError).toBeUndefined();
  });

  it('decodes parallel function calls, keeping ids distinct', async () => {
    const f = vi.fn().mockResolvedValue(
      chat({
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_pipeline_metrics', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'get_sector_analysis', arguments: '{}' } },
        ],
      }),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls.map((t) => t.id)).toEqual(['c1', 'c2']);
  });

  it('keeps two calls to the SAME tool distinguishable by id', async () => {
    // This is why the compatibility endpoint was chosen over the native API,
    // which pairs responses by function name only.
    const f = vi.fn().mockResolvedValue(
      chat({
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_pipeline_metrics', arguments: '{"sector":"Mining"}' } },
          { id: 'c2', type: 'function', function: { name: 'get_pipeline_metrics', arguments: '{"sector":"Railways"}' } },
        ],
      }),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls).toHaveLength(2);
    expect(new Set(turn.toolCalls.map((t) => t.id)).size).toBe(2);
    expect(turn.toolCalls[0].input).toEqual({ sector: 'Mining' });
    expect(turn.toolCalls[1].input).toEqual({ sector: 'Railways' });
  });

  it('synthesises an id when the compatibility layer omits one', () => {
    const turn = decodeAssistantMessage({
      content: null,
      tool_calls: [{ id: '', type: 'function', function: { name: 'get_board_overview', arguments: '' } }],
    });
    expect(turn.toolCalls[0].id).toBe('call_0');
    expect(turn.toolCalls[0].input).toEqual({});
  });

  it('treats empty arguments as a no-argument call', async () => {
    const f = vi.fn().mockResolvedValue(
      chat({
        content: null,
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_board_overview', arguments: '' } }],
      }),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls[0].input).toEqual({});
    expect(turn.toolCalls[0].parseError).toBeUndefined();
  });

  it('flags malformed arguments rather than executing a guess', async () => {
    const f = vi.fn().mockResolvedValue(
      chat({
        content: null,
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_pipeline_metrics', arguments: '{bad' } }],
      }),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls[0].parseError).toMatch(/not valid JSON/);
  });

  it('returns a plain answer when no tool is called (stop condition)', async () => {
    const f = vi.fn().mockResolvedValue(chat({ content: 'Pipeline is ₹4.2 Cr.', tool_calls: [] }));
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.text).toEqual(['Pipeline is ₹4.2 Cr.']);
    expect(turn.toolCalls).toEqual([]);
  });

  it('handles a turn carrying both text and a tool call', async () => {
    const f = vi.fn().mockResolvedValue(
      chat({
        content: 'Let me check the boards.',
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_pipeline_metrics', arguments: '{}' } }],
      }),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.text).toEqual(['Let me check the boards.']);
    expect(turn.toolCalls).toHaveLength(1);
  });
});

/* -------------------------------- errors ---------------------------------- */

describe('Gemini error handling', () => {
  it('reports a rejected key without retrying', async () => {
    const f = vi.fn().mockResolvedValue(errorRes(401, 'API key not valid'));
    await expect(
      provider(f as unknown as typeof fetch, { maxAttempts: 3 }).complete(base),
    ).rejects.toThrow(/rejected the API key/i);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('relays Google’s quota text on a 429', async () => {
    const f = vi.fn().mockResolvedValue(
      errorRes(429, 'Quota exceeded for quota metric generate_content_free_tier_requests. Please retry in 41.6s'),
    );
    const err = await provider(f as unknown as typeof fetch)
      .complete(base)
      .catch((e) => e as LlmError);
    expect((err as LlmError).message).toMatch(/generate_content_free_tier_requests/);
    expect((err as LlmError).message).toMatch(/Retry in ~42s/);
    expect((err as LlmError).retryAfterMs).toBe(41_600);
  });

  it('retries a 429 then succeeds, bounded', async () => {
    const f = vi
      .fn()
      .mockImplementationOnce(async () => errorRes(429, 'Quota exceeded. Please retry in 0.01s'))
      .mockImplementationOnce(async () => chat({ content: 'Recovered.' }));
    const turn = await provider(f as unknown as typeof fetch, {
      maxAttempts: 3,
      maxBackoffMs: 20,
    }).complete(base);
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

  it('names the model on a 404', async () => {
    const f = vi.fn().mockResolvedValue(errorRes(404, 'models/nope is not found'));
    await expect(provider(f as unknown as typeof fetch).complete(base)).rejects.toThrow(
      /gemini-2\.5-flash" was not found/,
    );
  });

  it('handles a non-JSON response and a network failure', async () => {
    const html = vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 200 }));
    await expect(provider(html as unknown as typeof fetch).complete(base)).rejects.toThrow(/non-JSON/);

    const dead = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(provider(dead as unknown as typeof fetch).complete(base)).rejects.toThrow(/Network error/);
  });

  it('parses the retry delay from either wording', () => {
    expect(parseGeminiRetryAfter(null, 'Please retry in 41.6s')).toBe(41_600);
    expect(parseGeminiRetryAfter(null, '"retryDelay": "45s"')).toBe(45_000);
    expect(parseGeminiRetryAfter('30', undefined)).toBe(30_000);
    expect(parseGeminiRetryAfter(null, 'Quota exceeded')).toBeUndefined();
  });
});

/* ------------------------------- security --------------------------------- */

describe('Gemini key handling', () => {
  it('sends the key only in the Authorization header, never the body or URL', async () => {
    const f = vi.fn().mockResolvedValue(chat({ content: 'ok' }));
    await provider(f as unknown as typeof fetch).complete(base);
    const [url, init] = f.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(String(url)).not.toContain('test-key');
    expect((init as RequestInit).body as string).not.toContain('test-key');
  });

  it('does not put the key in error messages', async () => {
    const f = vi.fn().mockResolvedValue(errorRes(401, 'API key not valid'));
    const err = await provider(f as unknown as typeof fetch)
      .complete(base)
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain('test-key');
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

  it('selects gemini explicitly', () => {
    expect(resolveProvider({ LLM_PROVIDER: 'gemini' })).toBe('gemini');
    expect(resolveProvider({ LLM_PROVIDER: ' GEMINI ' })).toBe('gemini');
  });

  it('infers gemini when only a Gemini key is present', () => {
    expect(resolveProvider({ GEMINI_API_KEY: 'x' })).toBe('gemini');
  });

  it('prefers gemini over groq when both keys exist', () => {
    expect(resolveProvider({ GEMINI_API_KEY: 'x', GROQ_API_KEY: 'y' })).toBe('gemini');
  });

  it('still resolves the other providers', () => {
    expect(resolveProvider({ LLM_PROVIDER: 'groq' })).toBe('groq');
    expect(resolveProvider({ LLM_PROVIDER: 'anthropic' })).toBe('anthropic');
    expect(resolveProvider({ GROQ_API_KEY: 'y' })).toBe('groq');
    expect(resolveProvider({})).toBe('anthropic');
  });

  it('rejects an unknown provider naming all three', () => {
    expect(() => resolveProvider({ LLM_PROVIDER: 'openai' })).toThrow(/gemini.*groq.*anthropic/i);
  });

  it('defaults to gemini-2.5-flash and honours GEMINI_MODEL', () => {
    expect(DEFAULT_MODELS.gemini).toBe('gemini-2.5-flash');
    expect(modelFor('gemini', {})).toBe('gemini-2.5-flash');
    expect(modelFor('gemini', { GEMINI_MODEL: 'gemini-2.5-pro' })).toBe('gemini-2.5-pro');
  });

  it('requires only the Gemini key — no Groq or Anthropic key needed', () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'gem_test';
    process.env.MONDAY_API_TOKEN = 't';
    process.env.MONDAY_DEALS_BOARD_ID = '1';
    process.env.MONDAY_WORK_ORDERS_BOARD_ID = '2';
    const s = configStatus();
    expect(s.ok).toBe(true);
    expect(s.provider).toBe('gemini');
    expect(s.model).toBe('gemini-2.5-flash');
    expect(s.missing).toEqual([]);
  });

  it('names GEMINI_API_KEY when it is the missing one', () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.MONDAY_API_TOKEN = 't';
    process.env.MONDAY_DEALS_BOARD_ID = '1';
    process.env.MONDAY_WORK_ORDERS_BOARD_ID = '2';
    expect(configStatus().missing).toEqual(['GEMINI_API_KEY']);
  });

  it('the factory builds a Gemini adapter behind the neutral interface', () => {
    const p = createProvider({
      mondayToken: 't', mondayApiVersion: '2024-10',
      dealsBoardId: '1', workOrdersBoardId: '2',
      llm: { provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash' },
      cacheTtlSeconds: 300,
    });
    expect(p.providerName).toBe('gemini');
    expect(p.model).toBe('gemini-2.5-flash');
    expect(typeof p.complete).toBe('function');
  });
});
