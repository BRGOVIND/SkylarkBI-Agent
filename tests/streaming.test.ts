import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { LlmProvider, LlmTurn, CompleteArgs } from '@/lib/agent/provider';
import { GeminiProvider } from '@/lib/agent/providers/gemini';
import { parseNdjson } from '@/lib/agent/stream';

/**
 * How a model's answer survives the trip to the screen.
 *
 * The bug this file exists for: a provider may split one logical answer across
 * several content parts at an arbitrary boundary — including the middle of a
 * markdown token. Joining those parts with a blank line breaks the token, and
 * the reader sees the fragment rendered literally, e.g. a table followed by a
 * stray "**Er".
 */

vi.mock('@/lib/data', () => ({
  loadBusinessData: async () => ({
    deals: [],
    workOrders: [],
    quality: { deals: {}, workOrders: {} },
    fetchedAt: new Date().toISOString(),
  }),
  snapshotAgeSeconds: () => 0,
  invalidateCache: () => {},
  describeError: (e: unknown) => ({
    message: e instanceof Error ? e.message : 'x',
    kind: e instanceof Error && e.name === 'ConfigError' ? 'config' : 'unknown',
  }),
}));

const { runAgent } = await import('@/lib/agent/run');

function scripted(turns: LlmTurn[]) {
  const seen: CompleteArgs[] = [];
  let i = 0;
  const p: LlmProvider & { seen: CompleteArgs[] } = {
    providerName: 'scripted',
    model: 'test',
    seen,
    async complete(args: CompleteArgs) {
      seen.push(structuredClone(args));
      return turns[Math.min(i++, turns.length - 1)];
    },
  };
  return p;
}

async function collect(gen: AsyncGenerator<unknown>) {
  const out: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const e of gen) out.push(e as { type: string; [k: string]: unknown });
  return out;
}

/** What the browser does with the text events it receives. */
const render = (events: Array<{ type: string; text?: string }>) =>
  events
    .filter((e) => e.type === 'text')
    .reduce((acc, e) => (acc ? `${acc}\n\n${e.text}` : e.text ?? ''), '');

/* --------------------- answer assembly across parts ----------------------- */

describe('an answer split across content parts', () => {
  it('is reassembled exactly, with no separator inserted mid-token', async () => {
    // Gemini split this answer in the middle of a bold marker.
    const p = scripted([
      { text: ['| Name |\n| --- |\n| Goku |\n\n**Er', 'ror rate is low** across the board.'], toolCalls: [] },
    ]);
    const events = await collect(runAgent([{ role: 'user', content: 'q' }], p));

    const rendered = render(events);
    expect(rendered).toBe('| Name |\n| --- |\n| Goku |\n\n**Error rate is low** across the board.');
    // The literal fragment must not survive into the rendered answer.
    expect(rendered).not.toMatch(/\*\*Er\s*$/m);
    expect(rendered).not.toContain('**Er\n\nror');
  });

  it('does not break a split table row', async () => {
    const p = scripted([{ text: ['| A | B |\n| --- | --- |\n| 1 |', ' 2 |\n'], toolCalls: [] }]);
    expect(render(await collect(runAgent([{ role: 'user', content: 'q' }], p)))).toContain('| 1 | 2 |');
  });

  it('does not break a split list marker or link', async () => {
    const p = scripted([{ text: ['Points:\n\n- fir', 'st\n- second'], toolCalls: [] }]);
    expect(render(await collect(runAgent([{ role: 'user', content: 'q' }], p)))).toContain('- first');
  });

  it('keeps a whitespace-only part instead of dropping it', async () => {
    // A part carrying only the paragraph break is still meaningful.
    const p = scripted([{ text: ['First paragraph.', '\n\n', 'Second paragraph.'], toolCalls: [] }]);
    const rendered = render(await collect(runAgent([{ role: 'user', content: 'q' }], p)));
    expect(rendered).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('emits one text event per round, not one per part', async () => {
    const p = scripted([{ text: ['a', 'b', 'c'], toolCalls: [] }]);
    const events = await collect(runAgent([{ role: 'user', content: 'q' }], p));
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
    expect(events.find((e) => e.type === 'text')!.text).toBe('abc');
  });

  it('stores the same reassembled text in the conversation history', async () => {
    const p = scripted([
      { text: ['Checking the boa', 'rds.'], toolCalls: [{ id: 'c', name: 'get_board_overview', input: {} }] },
      { text: ['Done.'], toolCalls: [] },
    ]);
    await collect(runAgent([{ role: 'user', content: 'q' }], p));
    const assistant = p.seen[1].messages.find((m) => m.role === 'assistant') as { text: string };
    expect(assistant.text).toBe('Checking the boards.');
  });

  it('separates text from different rounds with a blank line', async () => {
    const p = scripted([
      { text: ['Let me check.'], toolCalls: [{ id: 'c', name: 'get_board_overview', input: {} }] },
      { text: ['Here is the answer.'], toolCalls: [] },
    ]);
    const rendered = render(await collect(runAgent([{ role: 'user', content: 'q' }], p)));
    expect(rendered).toBe('Let me check.\n\nHere is the answer.');
  });

  it('emits nothing for a turn whose text is entirely empty', async () => {
    const p = scripted([
      { text: ['', ''], toolCalls: [{ id: 'c', name: 'get_board_overview', input: {} }] },
      { text: ['Answer.'], toolCalls: [] },
    ]);
    const events = await collect(runAgent([{ role: 'user', content: 'q' }], p));
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
  });
});

/* ------------------------ provider part preservation ---------------------- */

describe('providers keep every part they are given', () => {
  it('Gemini preserves a whitespace-only text part', async () => {
    const res = new Response(
      JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'One.' }, { text: '\n\n' }, { text: 'Two.' }] },
            finishReason: 'STOP',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const f = vi.fn().mockResolvedValue(res);
    const turn = await new GeminiProvider({
      apiKey: 'k',
      model: 'm',
      fetchImpl: f as unknown as typeof fetch,
      maxAttempts: 1,
    }).complete({ system: 's', tools: [], messages: [{ role: 'user', text: 'q' }], maxTokens: 10 });

    expect(turn.text.join('')).toBe('One.\n\nTwo.');
  });

  it('Gemini still ignores thought parts', async () => {
    const res = new Response(
      JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'hidden', thought: true }, { text: 'shown' }] },
            finishReason: 'STOP',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const f = vi.fn().mockResolvedValue(res);
    const turn = await new GeminiProvider({
      apiKey: 'k',
      model: 'm',
      fetchImpl: f as unknown as typeof fetch,
      maxAttempts: 1,
    }).complete({ system: 's', tools: [], messages: [{ role: 'user', text: 'q' }], maxTokens: 10 });

    expect(turn.text.join('')).toBe('shown');
  });
});

/* ---------------------------- NDJSON transport ---------------------------- */

describe('NDJSON parsing across network chunks', () => {
  it('holds back a message split mid-JSON until it completes', () => {
    const p = parseNdjson();
    expect(p.push('{"type":"te')).toEqual([]);
    expect(p.push('xt","text":"hello"}\n')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('handles a split at the exact newline boundary', () => {
    const p = parseNdjson();
    expect(p.push('{"type":"done"}')).toEqual([]);
    expect(p.push('\n')).toEqual([{ type: 'done' }]);
  });

  it('returns several messages arriving in one chunk', () => {
    const p = parseNdjson();
    expect(p.push('{"type":"a"}\n{"type":"b"}\n')).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  it('is not confused by newlines inside string values', () => {
    const p = parseNdjson();
    const msg = { type: 'text', text: 'line one\nline two\n\n| a |' };
    expect(p.push(JSON.stringify(msg) + '\n')).toEqual([msg]);
  });

  it('skips a malformed line rather than losing the rest of the stream', () => {
    const p = parseNdjson();
    expect(p.push('not json\n{"type":"text","text":"ok"}\n')).toEqual([
      { type: 'text', text: 'ok' },
    ]);
  });

  it('surfaces a trailing message that arrived without its final newline', () => {
    const p = parseNdjson();
    expect(p.push('{"type":"text","text":"last"}')).toEqual([]);
    // The stream ended here; flush must not lose it.
    expect(p.flush()).toEqual([{ type: 'text', text: 'last' }]);
  });

  it('flushes nothing when the buffer holds only an incomplete fragment', () => {
    const p = parseNdjson();
    p.push('{"type":"tex');
    expect(p.flush()).toEqual([]);
  });

  it('survives a byte-by-byte stream', () => {
    const p = parseNdjson();
    const wire = '{"type":"text","text":"a b c"}\n{"type":"done"}\n';
    const got: unknown[] = [];
    for (const ch of wire) got.push(...p.push(ch));
    got.push(...p.flush());
    expect(got).toEqual([{ type: 'text', text: 'a b c' }, { type: 'done' }]);
  });
});

/* ------------------- config errors reach the reader safely ---------------- */

describe('a misconfigured deployment does not leak variable names to the user', () => {
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

  it('emits a plain statement instead of the environment dump', async () => {
    // No injected provider, so the real config path runs and fails.
    const events = await collect(runAgent([{ role: 'user', content: 'hi' }]));
    const err = events.find((e) => e.type === 'error') as unknown as {
      message: string;
      kind: string;
    };

    expect(err.kind).toBe('config');
    expect(err.message).toMatch(/not connected to its business data/i);
    for (const name of [
      'MONDAY_API_TOKEN',
      'MONDAY_DEALS_BOARD_ID',
      'MONDAY_WORK_ORDERS_BOARD_ID',
      'GEMINI_API_KEY',
      'ANTHROPIC_API_KEY',
      'LLM_PROVIDER',
    ]) {
      expect(err.message).not.toContain(name);
    }
  });

  it('still surfaces non-config failures verbatim, so they stay diagnosable', async () => {
    const failing: LlmProvider = {
      providerName: 'gemini',
      model: 'm',
      async complete() {
        throw new (await import('@/lib/agent/provider')).LlmError('quota exceeded', 'gemini', 429);
      },
    };
    const events = await collect(runAgent([{ role: 'user', content: 'hi' }], failing));
    expect((events[0] as unknown as { message: string }).message).toMatch(/quota exceeded/);
  });
});
