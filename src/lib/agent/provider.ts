/**
 * Provider-neutral LLM interface.
 *
 * The agent needs exactly one capability from a model vendor: multi-turn tool
 * calling. It uses no structured-output mode, no provider streaming, no prompt
 * caching, no extended thinking, and no other vendor-specific feature. That
 * makes the surface small enough to express neutrally, so the BI layer —
 * tools, analytics, prompt, caveats — is entirely unaware of which vendor is
 * answering.
 */

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Set when the model emitted arguments that were not valid JSON. The caller
   * feeds this back as a tool error rather than executing with a guess.
   */
  parseError?: string;
}

/** One conversational turn in provider-neutral form. */
export type AgentMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | {
      role: 'tool_results';
      results: Array<{ id: string; name: string; content: string; isError: boolean }>;
    };

export interface LlmTurn {
  /** Text blocks the model produced, in order. */
  text: string[];
  toolCalls: ToolCall[];
}

export interface CompleteArgs {
  system: string;
  tools: ToolSpec[];
  messages: AgentMessage[];
  maxTokens: number;
}

export interface LlmProvider {
  readonly providerName: string;
  readonly model: string;
  complete(args: CompleteArgs): Promise<LlmTurn>;
}

export class LlmError extends Error {
  readonly provider: string;
  readonly status?: number;
  /** Server-directed wait before retrying, when the vendor supplied one. */
  readonly retryAfterMs?: number;
  /** Vendor rate-limit budget headers, for diagnostics. */
  readonly rateLimit?: Record<string, string | undefined>;
  constructor(
    message: string,
    provider: string,
    status?: number,
    extra?: { retryAfterMs?: number; rateLimit?: Record<string, string | undefined> },
  ) {
    super(message);
    this.name = 'LlmError';
    this.provider = provider;
    this.status = status;
    this.retryAfterMs = extra?.retryAfterMs;
    this.rateLimit = extra?.rateLimit;
  }
}

/**
 * Parses tool arguments defensively. Models occasionally emit an empty string
 * for a no-argument call, and very occasionally malformed JSON; neither should
 * take down a conversational turn.
 */
export function parseToolArguments(
  raw: unknown,
): { input: Record<string, unknown>; parseError?: string } {
  if (raw === null || raw === undefined) return { input: {} };
  if (typeof raw === 'object') return { input: raw as Record<string, unknown> };
  const text = String(raw).trim();
  if (!text) return { input: {} };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { input: parsed as Record<string, unknown> };
    }
    return { input: {}, parseError: `Tool arguments must be a JSON object, got: ${text.slice(0, 120)}` };
  } catch {
    return { input: {}, parseError: `Tool arguments were not valid JSON: ${text.slice(0, 120)}` };
  }
}
