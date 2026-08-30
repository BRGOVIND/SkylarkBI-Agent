import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GroqProvider, toOpenAiMessages, toOpenAiTools } from '@/lib/agent/providers/groq';
import { toAnthropicMessages, toAnthropicTools } from '@/lib/agent/providers/anthropic';
import { parseToolArguments, LlmError, type AgentMessage, type ToolSpec } from '@/lib/agent/provider';
import { resolveProvider, modelFor, configStatus, DEFAULT_MODELS } from '@/lib/config';
import { TOOL_DEFINITIONS } from '@/lib/agent/tools';

const TOOLS: ToolSpec[] = [
  { name: 'get_pipeline_metrics', description: 'Pipeline', parameters: { type: 'object', properties: { sector: { type: 'string' } } } },
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
    results: [{ id: 'call_1', name: 'get_pipeline_metrics', content: '{"openPipelineValue":100}', isError: false }],
  },
];

const chat = (message: unknown, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message }] }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/* ------------------------------ tool schemas ------------------------------ */

describe('tool definitions are provider-neutral', () => {
  it('exposes all nine BI tools with JSON Schema parameters', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(9);
    for (const t of TOOL_DEFINITIONS) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect((t.parameters as { type: string }).type).toBe('object');
      expect(t.parameters).toHaveProperty('properties');
    }
  });

  it('survives translation to the OpenAI function shape Groq expects', () => {
    const fns = toOpenAiTools(TOOL_DEFINITIONS);
    expect(fns).toHaveLength(9);
    for (const f of fns) {
      expect(f.type).toBe('function');
      expect(f.function.name).toBeTruthy();
      expect((f.function.parameters as { type: string }).type).toBe('object');
    }
    expect(fns.map((f) => f.function.name)).toContain('generate_leadership_update');
  });

  it('survives translation to the Anthropic tool shape', () => {
    const tools = toAnthropicTools(TOOL_DEFINITIONS);
    expect(tools).toHaveLength(9);
    for (const t of tools) expect(t.input_schema.type).toBe('object');
  });
});

/* --------------------------- message translation -------------------------- */

describe('Groq message translation', () => {
  it('puts the system prompt first and preserves turn order', () => {
    const msgs = toOpenAiMessages('SYSTEM', CONVERSATION);
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYSTEM' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'How is our pipeline?' });
  });

  it('encodes tool calls as OpenAI tool_calls with stringified arguments', () => {
    const assistant = toOpenAiMessages('S', CONVERSATION)[2];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBeNull(); // pure tool-call turn
    expect(assistant.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_pipeline_metrics', arguments: '{"sector":"Mining"}' },
      },
    ]);
  });

  it('emits one tool message per result, keyed by call id', () => {
    const msgs = toOpenAiMessages('S', CONVERSATION);
    const toolMsg = msgs[3];
    expect(toolMsg).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'get_pipeline_metrics',
      content: '{"openPipelineValue":100}',
    });
  });

  it('fans a batch of tool results out into separate messages', () => {
    const msgs = toOpenAiMessages('S', [
      {
        role: 'tool_results',
        results: [
          { id: 'a', name: 't1', content: '1', isError: false },
          { id: 'b', name: 't2', content: '2', isError: false },
        ],
      },
    ]);
    expect(msgs.filter((m) => m.role === 'tool')).toHaveLength(2);
  });
});

describe('Anthropic message translation', () => {
  it('encodes tool calls as tool_use content blocks', () => {
    const msgs = toAnthropicMessages(CONVERSATION);
    const assistant = msgs[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_pipeline_metrics', input: { sector: 'Mining' } },
    ]);
  });

  it('batches tool results into a single user turn', () => {
    const msgs = toAnthropicMessages([
      {
        role: 'tool_results',
        results: [
          { id: 'a', name: 't1', content: '1', isError: false },
          { id: 'b', name: 't2', content: '2', isError: true },
        ],
      },
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toHaveLength(2);
  });
});

/* ---------------------------- argument parsing ---------------------------- */

describe('tool argument parsing', () => {
  it('parses a normal JSON object', () => {
    expect(parseToolArguments('{"sector":"Mining"}').input).toEqual({ sector: 'Mining' });
  });

  it('treats an empty string as no arguments', () => {
    // Models commonly emit "" for a tool that takes no parameters.
    expect(parseToolArguments('').input).toEqual({});
    expect(parseToolArguments('').parseError).toBeUndefined();
  });

  it('accepts an already-parsed object (Anthropic returns objects)', () => {
    expect(parseToolArguments({ limit: 5 }).input).toEqual({ limit: 5 });
  });

  it('reports malformed JSON instead of guessing', () => {
    const r = parseToolArguments('{"sector": ');
    expect(r.input).toEqual({});
    expect(r.parseError).toMatch(/not valid JSON/);
  });

  it('rejects a non-object payload', () => {
    expect(parseToolArguments('[1,2]').parseError).toMatch(/must be a JSON object/);
  });
});

/* ------------------------------ Groq provider ----------------------------- */

describe('GroqProvider', () => {
  const provider = (fetchImpl: typeof fetch) =>
    new GroqProvider({ apiKey: 'k', model: 'openai/gpt-oss-120b', fetchImpl });

  const base = { system: 'S', tools: TOOLS, messages: CONVERSATION, maxTokens: 1024 };

  it('sends an OpenAI-compatible request to the Groq endpoint', async () => {
    const f = vi.fn().mockResolvedValue(chat({ content: 'Pipeline looks healthy.', tool_calls: [] }));
    await provider(f as unknown as typeof fetch).complete(base);

    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect(body.tools[0].type).toBe('function');
    expect(body.tool_choice).toBe('auto');
    expect(body.max_completion_tokens).toBe(1024);
    expect(body.messages[0].role).toBe('system');
  });

  it('never puts the API key anywhere but the Authorization header', async () => {
    const f = vi.fn().mockResolvedValue(chat({ content: 'ok' }));
    await provider(f as unknown as typeof fetch).complete(base);
    const [, init] = f.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer k');
    expect((init as RequestInit).body as string).not.toContain('Bearer k');
  });

  it('returns assistant text', async () => {
    const f = vi.fn().mockResolvedValue(chat({ content: 'Pipeline is ₹4.2 Cr.' }));
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.text).toEqual(['Pipeline is ₹4.2 Cr.']);
    expect(turn.toolCalls).toEqual([]);
  });

  it('decodes tool calls the model requests', async () => {
    const f = vi.fn().mockResolvedValue(
      chat({
        content: null,
        tool_calls: [
          {
            id: 'call_9',
            type: 'function',
            function: { name: 'get_sector_analysis', arguments: '{"period":"this_quarter"}' },
          },
        ],
      }),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls).toEqual([
      { id: 'call_9', name: 'get_sector_analysis', input: { period: 'this_quarter' }, parseError: undefined },
    ]);
  });

  it('decodes parallel tool calls', async () => {
    const f = vi.fn().mockResolvedValue(
      chat({
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'get_pipeline_metrics', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'get_operational_metrics', arguments: '{}' } },
        ],
      }),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls.map((t) => t.name)).toEqual(['get_pipeline_metrics', 'get_operational_metrics']);
  });

  it('flags malformed tool arguments rather than executing them', async () => {
    const f = vi.fn().mockResolvedValue(
      chat({
        content: null,
        tool_calls: [{ id: 'x', type: 'function', function: { name: 'get_pipeline_metrics', arguments: '{oops' } }],
      }),
    );
    const turn = await provider(f as unknown as typeof fetch).complete(base);
    expect(turn.toolCalls[0].parseError).toBeTruthy();
  });

  it('reports an invalid key clearly', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 401 }));
    await expect(provider(f as unknown as typeof fetch).complete(base)).rejects.toThrow(/rejected the API key/i);
  });

  it('reports rate limiting clearly', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 429 }));
    await expect(provider(f as unknown as typeof fetch).complete(base)).rejects.toThrow(/rate limit/i);
  });

  it('surfaces an API error message', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'model_not_found' } }), { status: 404 }),
    );
    await expect(provider(f as unknown as typeof fetch).complete(base)).rejects.toThrow(/model_not_found/);
  });

  it('handles a non-JSON response', async () => {
    const f = vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    await expect(provider(f as unknown as typeof fetch).complete(base)).rejects.toBeInstanceOf(LlmError);
  });

  it('handles a network failure', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(provider(f as unknown as typeof fetch).complete(base)).rejects.toThrow(/Network error/);
  });
});

/* ------------------------------ configuration ----------------------------- */

describe('provider selection', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    delete process.env.LLM_PROVIDER;
    delete process.env.GROQ_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GROQ_MODEL;
    delete process.env.ANTHROPIC_MODEL;
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  it('honours an explicit LLM_PROVIDER', () => {
    expect(resolveProvider({ LLM_PROVIDER: 'groq' })).toBe('groq');
    expect(resolveProvider({ LLM_PROVIDER: 'anthropic' })).toBe('anthropic');
    expect(resolveProvider({ LLM_PROVIDER: ' GROQ ' })).toBe('groq');
  });

  it('infers groq when only a Groq key is present', () => {
    expect(resolveProvider({ GROQ_API_KEY: 'x' })).toBe('groq');
  });

  it('defaults to anthropic when nothing indicates otherwise', () => {
    expect(resolveProvider({})).toBe('anthropic');
  });

  it('rejects an unknown provider rather than silently falling back', () => {
    expect(() => resolveProvider({ LLM_PROVIDER: 'openai' })).toThrow(/must be/);
  });

  it('uses the documented default model per provider', () => {
    expect(modelFor('groq', {})).toBe('openai/gpt-oss-120b');
    expect(modelFor('anthropic', {})).toBe(DEFAULT_MODELS.anthropic);
  });

  it('allows a model override per provider', () => {
    expect(modelFor('groq', { GROQ_MODEL: 'llama-3.3-70b' })).toBe('llama-3.3-70b');
  });

  it('requires only the selected provider key — a Groq deploy needs no Anthropic key', () => {
    process.env.LLM_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = 'gsk_test';
    process.env.MONDAY_API_TOKEN = 't';
    process.env.MONDAY_DEALS_BOARD_ID = '1';
    process.env.MONDAY_WORK_ORDERS_BOARD_ID = '2';
    const s = configStatus();
    expect(s.ok).toBe(true);
    expect(s.provider).toBe('groq');
    expect(s.model).toBe('openai/gpt-oss-120b');
    expect(s.missing).toEqual([]);
  });

  it('names the Groq key (not the Anthropic one) when it is missing', () => {
    process.env.LLM_PROVIDER = 'groq';
    process.env.MONDAY_API_TOKEN = 't';
    process.env.MONDAY_DEALS_BOARD_ID = '1';
    process.env.MONDAY_WORK_ORDERS_BOARD_ID = '2';
    const s = configStatus();
    expect(s.missing).toEqual(['GROQ_API_KEY']);
  });
});
