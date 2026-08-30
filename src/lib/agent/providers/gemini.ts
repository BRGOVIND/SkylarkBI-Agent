import { LlmError, type AgentMessage, type CompleteArgs, type LlmProvider, type LlmTurn, type ToolSpec } from '../provider';

/**
 * Google Gemini adapter, using the NATIVE `generateContent` API.
 *
 * Why native rather than the OpenAI-compatibility endpoint: that endpoint did
 * not expose this project's models at all (the native model list showed 39
 * chat-capable models; the compatibility model list matched none of them). The
 * native API is the first-class, fully supported surface, so the adapter targets
 * it directly.
 *
 * ── Tool-call correlation ────────────────────────────────────────────────────
 *
 * Native Gemini carries no call identifier: `FunctionCall` is `{name, args}`
 * and `FunctionResponse` is `{name, response}` (confirmed against the REST
 * reference). Correlating by NAME alone would be unsafe — two parallel calls to
 * the same tool with different arguments would be indistinguishable.
 *
 * Instead this adapter correlates by POSITION, which the wire format does
 * preserve:
 *
 *   1. Gemini returns `functionCall` parts as an ordered array within one model
 *      turn. At decode time each is given a positional id (`call_0`, `call_1`…)
 *      that travels through the neutral interface.
 *   2. When the history is replayed, the assistant turn and its results are both
 *      present, each carrying those ids. The adapter emits `functionResponse`
 *      parts in exactly the order of the `functionCall` parts they answer,
 *      looked up by id — so even if the caller reordered results, the wire order
 *      is restored.
 *   3. A call with no matching result becomes an explicit error response rather
 *      than a silent misalignment.
 *
 * Position is a stronger correlator than name, and the reconstruction is
 * deterministic, so the correctness guarantee around tool-result pairing is
 * preserved rather than weakened.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/* ------------------------------ wire types -------------------------------- */

interface GeminiFunctionCall {
  name?: string;
  args?: Record<string, unknown>;
}

interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown> };
  thought?: boolean;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string; code?: number };
}

/* ---------------------------- schema conversion --------------------------- */

const TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

/**
 * JSON Schema -> Gemini's OpenAPI-subset Schema.
 *
 * Gemini accepts only a defined subset and rejects unknown keywords, so this
 * keeps what it understands and drops the rest. Type names are upper-cased
 * because the REST API expects the protobuf enum name.
 */
export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = typeof schema.type === 'string' ? TYPE_MAP[schema.type] ?? schema.type.toUpperCase() : undefined;
  const out: Record<string, unknown> = {};
  if (type) out.type = type;
  if (typeof schema.description === 'string') out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.map(String);

  if (schema.properties && typeof schema.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
      const converted = toGeminiSchema(v);
      if (converted) props[k] = converted;
    }
    // Gemini rejects an OBJECT with an empty properties map.
    if (Object.keys(props).length) out.properties = props;
  }

  if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required;
  if (schema.items && typeof schema.items === 'object') {
    const items = toGeminiSchema(schema.items as Record<string, unknown>);
    if (items) out.items = items;
  }

  return Object.keys(out).length ? out : undefined;
}

/**
 * Tool -> Gemini functionDeclaration. A tool with no parameters omits the
 * `parameters` field entirely, which is how Gemini declares a no-argument
 * function; sending an empty OBJECT schema is rejected.
 */
export function toFunctionDeclarations(tools: ToolSpec[]) {
  return tools.map((t) => {
    const params = toGeminiSchema(t.parameters);
    const hasProps = params && params.properties && Object.keys(params.properties).length > 0;
    return {
      name: t.name,
      description: t.description,
      ...(hasProps ? { parameters: params } : {}),
    };
  });
}

/* --------------------------- message conversion --------------------------- */

/** The response object Gemini expects is a struct, never a bare string. */
function asStruct(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: content };
  }
}

/**
 * Neutral messages -> Gemini `contents`.
 *
 * Tool results are emitted in the order of the calls they answer (see the
 * correlation note at the top of this file), never in whatever order they
 * happen to arrive in.
 */
export function toGeminiContents(messages: AgentMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  // Order of tool-call ids from the most recent assistant turn.
  let pendingCallOrder: Array<{ id: string; name: string }> = [];

  for (const m of messages) {
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.text }] });
      pendingCallOrder = [];
    } else if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const tc of m.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.input ?? {} } });
      }
      if (parts.length) contents.push({ role: 'model', parts });
      pendingCallOrder = m.toolCalls.map((tc) => ({ id: tc.id, name: tc.name }));
    } else {
      const byId = new Map(m.results.map((r) => [r.id, r]));
      const parts: GeminiPart[] = [];

      // Emit one response per call, in call order.
      for (const call of pendingCallOrder) {
        const hit = byId.get(call.id);
        byId.delete(call.id);
        parts.push({
          functionResponse: {
            name: call.name,
            response: hit
              ? asStruct(hit.content)
              : { error: 'No result was produced for this tool call.' },
          },
        });
      }
      // Anything left over (no matching call) is appended rather than dropped.
      for (const leftover of byId.values()) {
        parts.push({
          functionResponse: { name: leftover.name, response: asStruct(leftover.content) },
        });
      }

      if (parts.length) contents.push({ role: 'user', parts });
      pendingCallOrder = [];
    }
  }

  return contents;
}

/* -------------------------------- provider -------------------------------- */

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
 * Google states a retry delay inside quota errors, e.g. "Please retry in 41.6s"
 * or a `retryDelay: "45s"` field.
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

/** Accepts either `gemini-2.5-flash` or `models/gemini-2.5-flash`. */
export function modelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
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
        // Bounded: only quota and transient server errors are retried.
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

    const body = {
      systemInstruction: { parts: [{ text: args.system }] },
      contents: toGeminiContents(args.messages),
      ...(args.tools.length
        ? {
            tools: [{ functionDeclarations: toFunctionDeclarations(args.tools) }],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
          }
        : {}),
      generationConfig: { maxOutputTokens: args.maxTokens, temperature: 0.2 },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}/${modelPath(this.model)}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header auth, never a query parameter — keys do not belong in URLs.
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
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
    let parsed: GeminiResponse = {};
    try {
      parsed = JSON.parse(text) as GeminiResponse;
    } catch {
      if (res.ok) {
        throw new LlmError(
          `Gemini returned a non-JSON response (HTTP ${res.status}).`,
          this.providerName,
          res.status,
        );
      }
    }
    const detail = parsed.error?.message?.trim();

    if (res.status === 401 || res.status === 403) {
      throw new LlmError(
        `Gemini rejected the API key (${res.status}). Check GEMINI_API_KEY and that the Generative Language API is enabled.${detail ? ` ${detail}` : ''}`,
        this.providerName,
        res.status,
      );
    }
    if (res.status === 429) {
      const retryAfterMs = parseGeminiRetryAfter(res.headers?.get?.('retry-after') ?? null, detail);
      throw new LlmError(
        `Gemini quota exceeded (429).${retryAfterMs ? ` Retry in ~${Math.ceil(retryAfterMs / 1000)}s.` : ''} ${detail ?? 'No detail supplied.'}`,
        this.providerName,
        429,
        { retryAfterMs },
      );
    }
    if (res.status === 404) {
      throw new LlmError(
        `Gemini model "${this.model}" was not found (404). Check GEMINI_MODEL. ` +
          `Run "npm run gemini:models" to list the models available to this API key.` +
          (detail ? ` ${detail}` : ''),
        this.providerName,
        404,
      );
    }
    if (!res.ok || parsed.error) {
      throw new LlmError(
        `Gemini error (HTTP ${res.status}): ${detail ?? text.slice(0, 300)}`,
        this.providerName,
        res.status,
      );
    }

    if (parsed.promptFeedback?.blockReason) {
      throw new LlmError(
        `Gemini blocked the request (${parsed.promptFeedback.blockReason}).`,
        this.providerName,
        res.status,
      );
    }

    const candidate = parsed.candidates?.[0];
    if (!candidate) {
      throw new LlmError('Gemini returned no candidates.', this.providerName, res.status);
    }

    const parts = candidate.content?.parts ?? [];
    const textOut: string[] = [];
    const toolCalls: LlmTurn['toolCalls'] = [];

    for (const part of parts) {
      // Thought summaries are not answer content.
      if (part.thought) continue;
      if (typeof part.text === 'string' && part.text.trim()) textOut.push(part.text);
      if (part.functionCall) {
        // Positional id — see the correlation note at the top of this file.
        toolCalls.push({
          id: `call_${toolCalls.length}`,
          name: part.functionCall.name ?? '',
          input: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }

    if (candidate.finishReason === 'MALFORMED_FUNCTION_CALL') {
      throw new LlmError(
        'Gemini emitted a malformed function call. This usually means a tool schema it could not satisfy.',
        this.providerName,
        res.status,
      );
    }
    if (!textOut.length && !toolCalls.length) {
      const why = candidate.finishReason ?? 'unknown';
      throw new LlmError(
        why === 'MAX_TOKENS'
          ? `Gemini hit its output limit before producing an answer (finishReason MAX_TOKENS). On thinking-enabled models the reasoning budget can consume maxOutputTokens; raise it or choose a different model.`
          : `Gemini returned an empty response (finishReason ${why}).`,
        this.providerName,
        res.status,
      );
    }

    return { text: textOut, toolCalls };
  }
}
