import {
  LlmError,
  parseToolArguments,
  type AgentMessage,
  type CompleteArgs,
  type LlmProvider,
  type LlmTurn,
  type ToolSpec,
} from '../provider';

/**
 * Groq adapter, speaking the OpenAI-compatible Chat Completions API.
 *
 * Implemented with plain `fetch` rather than the OpenAI SDK: the surface we
 * use is one POST, and this keeps the dependency list and the error handling
 * consistent with the monday.com client.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

interface OpenAiToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ChatResponse {
  choices?: Array<{
    message?: { content: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string; code?: string };
}

/** Groq's advertised budget and what is left of it, straight from the headers. */
export interface GroqRateLimit {
  [key: string]: string | undefined;
  limitRequests?: string;
  remainingRequests?: string;
  resetRequests?: string;
  limitTokens?: string;
  remainingTokens?: string;
  resetTokens?: string;
}

export function readRateLimit(headers: Headers | undefined): GroqRateLimit {
  const get = (k: string) => headers?.get?.(k) ?? undefined;
  return {
    limitRequests: get('x-ratelimit-limit-requests'),
    remainingRequests: get('x-ratelimit-remaining-requests'),
    resetRequests: get('x-ratelimit-reset-requests'),
    limitTokens: get('x-ratelimit-limit-tokens'),
    remainingTokens: get('x-ratelimit-remaining-tokens'),
    resetTokens: get('x-ratelimit-reset-tokens'),
  };
}

/**
 * Groq states the wait in two places: a `retry-after` header (seconds) and,
 * more precisely, inside the 429 body — "Please try again in 7.66s", sometimes
 * "in 1m23.4s". Honour whichever is available rather than guessing a backoff.
 */
export function parseGroqRetryAfter(header: string | null, message?: string): number | undefined {
  if (message) {
    const withMinutes = message.match(/try again in\s+(\d+)m([\d.]+)s/i);
    if (withMinutes) return Math.round((Number(withMinutes[1]) * 60 + Number(withMinutes[2])) * 1000);
    const seconds = message.match(/try again in\s+([\d.]+)\s*s/i);
    if (seconds) return Math.round(Number(seconds[1]) * 1000);
  }
  if (header) {
    const n = Number(header.trim());
    if (Number.isFinite(n) && n >= 0) return Math.min(n, 300) * 1000;
  }
  return undefined;
}

/** Neutral messages -> OpenAI chat messages. */
export function toOpenAiMessages(system: string, messages: AgentMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        // OpenAI requires content to be present; null is the accepted form for
        // a turn that was purely tool calls.
        content: m.text || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.input) },
              })),
            }
          : {}),
      });
    } else {
      // Anthropic batches tool results into one message; OpenAI wants one
      // message per result, each keyed to its call id.
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: r.content });
      }
    }
  }
  return out;
}

export function toOpenAiTools(tools: ToolSpec[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export interface GroqProviderOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Total attempts per request, including the first. */
  maxAttempts?: number;
  /**
   * Ceiling on one backoff wait. Kept modest in the web app because the API
   * route has its own time budget; the smoke script raises it, since it can
   * afford to sit out a full token-per-minute window.
   */
  maxBackoffMs?: number;
  onRetry?: (n: { attempt: number; maxAttempts: number; delayMs: number; reason: string }) => void;
  /** Observability hook — receives the rate-limit headers from every response. */
  onRateLimit?: (info: GroqRateLimit) => void;
}

export class GroqProvider implements LlmProvider {
  readonly providerName = 'groq';
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxBackoffMs: number;
  private readonly onRetry?: GroqProviderOptions['onRetry'];
  private readonly onRateLimit?: GroqProviderOptions['onRateLimit'];

  constructor(opts: GroqProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.maxBackoffMs = opts.maxBackoffMs ?? 15_000;
    this.onRetry = opts.onRetry;
    this.onRateLimit = opts.onRateLimit;
  }

  async complete(args: CompleteArgs): Promise<LlmTurn> {
    let last: LlmError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.attempt(args);
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError(String(err), this.providerName);
        last = e;
        // Bounded: only rate limits and transient server errors are retried,
        // and never past maxAttempts.
        const retryable = e.status === 429 || (e.status !== undefined && e.status >= 500);
        if (!retryable || attempt === this.maxAttempts) break;

        const directed = e.retryAfterMs;
        const delay = Math.min(
          this.maxBackoffMs,
          directed ?? Math.min(this.maxBackoffMs, 1000 * 2 ** (attempt - 1)),
        );
        this.onRetry?.({
          attempt,
          maxAttempts: this.maxAttempts,
          delayMs: delay,
          reason: e.message,
        });
        await new Promise((r) => setTimeout(r, delay + 250));
      }
    }
    throw last ?? new LlmError('Groq request failed', this.providerName);
  }

  private async attempt(args: CompleteArgs): Promise<LlmTurn> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(GROQ_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: toOpenAiMessages(args.system, args.messages),
          tools: toOpenAiTools(args.tools),
          tool_choice: 'auto',
          max_completion_tokens: args.maxTokens,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new LlmError(
        aborted ? `Groq request timed out after ${this.timeoutMs}ms` : 'Network error contacting Groq',
        this.providerName,
        // No status: a transport failure is not retried as a rate limit.
      );
    } finally {
      clearTimeout(timer);
    }

    const rateLimit = readRateLimit(res.headers);
    this.onRateLimit?.(rateLimit);

    const text = await res.text();
    let body: ChatResponse = {};
    try {
      body = JSON.parse(text) as ChatResponse;
    } catch {
      if (res.ok) {
        throw new LlmError(`Groq returned a non-JSON response (HTTP ${res.status}).`, this.providerName, res.status);
      }
    }

    if (res.status === 401 || res.status === 403) {
      throw new LlmError('Groq rejected the API key (401/403). Check GROQ_API_KEY.', this.providerName, res.status);
    }

    if (res.status === 429) {
      // Groq's own message names the exact limit that was hit (TPM vs RPM vs
      // daily) and how long to wait. Relaying it verbatim is the difference
      // between a diagnosable failure and a useless one.
      const detail = body.error?.message?.trim();
      const retryAfterMs = parseGroqRetryAfter(res.headers?.get?.('retry-after') ?? null, detail);
      const wait = retryAfterMs ? ` Retry in ~${Math.ceil(retryAfterMs / 1000)}s.` : '';
      const budget =
        rateLimit.limitTokens || rateLimit.remainingTokens
          ? ` [tokens ${rateLimit.remainingTokens ?? '?'}/${rateLimit.limitTokens ?? '?'} left, resets in ${rateLimit.resetTokens ?? '?'}]`
          : '';
      throw new LlmError(
        `Groq rate limit (429).${wait} ${detail ?? 'No detail supplied.'}${budget}`,
        this.providerName,
        429,
        { retryAfterMs, rateLimit },
      );
    }

    if (!res.ok || body.error) {
      throw new LlmError(
        `Groq error (HTTP ${res.status}): ${body.error?.message ?? text.slice(0, 300)}`,
        this.providerName,
        res.status,
      );
    }

    const message = body.choices?.[0]?.message;
    if (!message) {
      throw new LlmError('Groq response contained no message.', this.providerName, res.status);
    }

    const toolCalls = (message.tool_calls ?? [])
      // Guard against non-function tool types this agent does not use.
      .filter((tc) => !tc.type || tc.type === 'function')
      .map((tc) => {
        const { input, parseError } = parseToolArguments(tc.function?.arguments);
        return { id: tc.id, name: tc.function?.name ?? '', input, parseError };
      });

    const content = (message.content ?? '').trim();
    return { text: content ? [content] : [], toolCalls };
  }
}
