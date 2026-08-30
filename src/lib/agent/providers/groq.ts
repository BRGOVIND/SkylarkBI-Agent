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
  error?: { message?: string; type?: string };
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

export class GroqProvider implements LlmProvider {
  readonly providerName = 'groq';
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { apiKey: string; model: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async complete(args: CompleteArgs): Promise<LlmTurn> {
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
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: ChatResponse;
    try {
      body = JSON.parse(text) as ChatResponse;
    } catch {
      throw new LlmError(`Groq returned a non-JSON response (HTTP ${res.status}).`, this.providerName, res.status);
    }

    if (res.status === 401 || res.status === 403) {
      throw new LlmError('Groq rejected the API key (401/403). Check GROQ_API_KEY.', this.providerName, res.status);
    }
    if (res.status === 429) {
      throw new LlmError(
        'Groq rate limit reached (429). Wait a moment and try again, or lower the request rate.',
        this.providerName,
        429,
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
