import { LlmError, type CompleteArgs, type LlmProvider, type LlmTurn } from '../provider';
import {
  decodeAssistantMessage,
  toOpenAiMessages,
  toOpenAiTools,
  type OpenAiChatResponse,
} from './openai-wire';

/**
 * Google Gemini adapter, via the Gemini API's OpenAI-compatibility endpoint.
 *
 * Why the compatibility endpoint rather than the native `@google/genai` SDK:
 *
 * The native Gemini API pairs a function *response* to its call by function
 * NAME — `functionCall`/`functionResponse` parts carry no call id. This agent's
 * neutral interface pairs by id, which is what makes two parallel calls to the
 * SAME tool (say two sector queries with different filters) unambiguous.
 * Adapting the native shape would mean inventing ids and re-associating them by
 * name and position, adding a correctness risk precisely where a BI agent can
 * least afford one.
 *
 * The compatibility endpoint speaks the same `tool_calls` / `tool_call_id`
 * dialect the neutral interface already models, so the mapping is exact, needs
 * no new dependency, and shares its translation code with the Groq adapter.
 *
 * The endpoint is documented as beta. Because it sits behind this adapter, a
 * future switch to the native SDK would touch this file only — the agent loop,
 * tools, analytics and UI are unaffected either way.
 */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Total attempts per request, including the first. */
  maxAttempts?: number;
  maxBackoffMs?: number;
  onRetry?: (n: { attempt: number; maxAttempts: number; delayMs: number; reason: string }) => void;
}

/**
 * Google states a retry delay inside quota errors, e.g.
 * "Please retry in 41.6s" or a `retryDelay: "45s"` field.
 */
export function parseGeminiRetryAfter(header: string | null, message?: string): number | undefined {
  if (message) {
    const retryIn = message.match(/retry(?:\s+again)?\s+in\s+([\d.]+)\s*s/i);
    if (retryIn) return Math.round(Number(retryIn[1]) * 1000);
    const retryDelay = message.match(/retryDelay["':\s]+([\d.]+)s/i);
    if (retryDelay) return Math.round(Number(retryDelay[1]) * 1000);
  }
  if (header) {
    const n = Number(header.trim());
    if (Number.isFinite(n) && n >= 0) return Math.min(n, 300) * 1000;
  }
  return undefined;
}

export class GeminiProvider implements LlmProvider {
  readonly providerName = 'gemini';
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxBackoffMs: number;
  private readonly onRetry?: GeminiProviderOptions['onRetry'];

  constructor(opts: GeminiProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.maxBackoffMs = opts.maxBackoffMs ?? 15_000;
    this.onRetry = opts.onRetry;
  }

  async complete(args: CompleteArgs): Promise<LlmTurn> {
    let last: LlmError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.attempt(args);
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError(String(err), this.providerName);
        last = e;
        // Bounded: only quota and transient server errors are retried, and
        // never past maxAttempts.
        const retryable = e.status === 429 || (e.status !== undefined && e.status >= 500);
        if (!retryable || attempt === this.maxAttempts) break;

        const delay = Math.min(
          this.maxBackoffMs,
          e.retryAfterMs ?? Math.min(this.maxBackoffMs, 1000 * 2 ** (attempt - 1)),
        );
        this.onRetry?.({ attempt, maxAttempts: this.maxAttempts, delayMs: delay, reason: e.message });
        await new Promise((r) => setTimeout(r, delay + 250));
      }
    }
    throw last ?? new LlmError('Gemini request failed', this.providerName);
  }

  private async attempt(args: CompleteArgs): Promise<LlmTurn> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(GEMINI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Server-side only. The key never reaches the browser.
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: toOpenAiMessages(args.system, args.messages),
          tools: toOpenAiTools(args.tools),
          tool_choice: 'auto',
          // The compatibility layer follows the classic Chat Completions
          // parameter name here.
          max_tokens: args.maxTokens,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new LlmError(
        aborted
          ? `Gemini request timed out after ${this.timeoutMs}ms`
          : 'Network error contacting the Gemini API',
        this.providerName,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: OpenAiChatResponse = {};
    try {
      body = JSON.parse(text) as OpenAiChatResponse;
    } catch {
      if (res.ok) {
        throw new LlmError(
          `Gemini returned a non-JSON response (HTTP ${res.status}).`,
          this.providerName,
          res.status,
        );
      }
    }

    const detail = body.error?.message?.trim();

    if (res.status === 401 || res.status === 403) {
      throw new LlmError(
        `Gemini rejected the API key (${res.status}). Check GEMINI_API_KEY and that the Generative Language API is enabled for the project.${detail ? ` ${detail}` : ''}`,
        this.providerName,
        res.status,
      );
    }

    if (res.status === 429) {
      // Relay Google's own quota text: it names which quota was exhausted and
      // usually how long to wait. Losing it makes a 429 undiagnosable.
      const retryAfterMs = parseGeminiRetryAfter(res.headers?.get?.('retry-after') ?? null, detail);
      const wait = retryAfterMs ? ` Retry in ~${Math.ceil(retryAfterMs / 1000)}s.` : '';
      throw new LlmError(
        `Gemini quota exceeded (429).${wait} ${detail ?? 'No detail supplied.'} ` +
          `Free-tier limits are per-model and per-minute; see your live limits in Google AI Studio.`,
        this.providerName,
        429,
        { retryAfterMs },
      );
    }

    if (res.status === 404) {
      // Model availability varies by key, project and region, so the fix is to
      // ask Google what this key can reach rather than try another name.
      throw new LlmError(
        `Gemini model "${this.model}" was not found (404). Check GEMINI_MODEL. ` +
          `Run "npm run gemini:models" to list the models available to this API key.` +
          (detail ? ` ${detail}` : ''),
        this.providerName,
        404,
      );
    }

    if (!res.ok || body.error) {
      throw new LlmError(
        `Gemini error (HTTP ${res.status}): ${detail ?? text.slice(0, 300)}`,
        this.providerName,
        res.status,
      );
    }

    const message = body.choices?.[0]?.message;
    if (!message) {
      throw new LlmError('Gemini response contained no message.', this.providerName, res.status);
    }
    return decodeAssistantMessage(message);
  }
}
