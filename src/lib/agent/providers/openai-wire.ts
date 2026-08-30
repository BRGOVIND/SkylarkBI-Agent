import { parseToolArguments, type AgentMessage, type LlmTurn, type ToolSpec } from '../provider';

/**
 * Translation between this agent's neutral message model and the OpenAI Chat
 * Completions wire format.
 *
 * Two vendors we support speak this dialect — Groq natively, and Google's
 * Gemini through its OpenAI-compatibility endpoint — so the translation lives
 * here once rather than being duplicated (and drifting) per adapter. Vendor
 * differences that matter (base URL, auth, error vocabulary, rate-limit
 * headers, retry policy) stay in each adapter.
 */

export interface OpenAiToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAiChatResponse {
  choices?: Array<{
    message?: { content: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string; code?: string | number; status?: string };
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

/**
 * Assistant message -> neutral turn.
 *
 * Tool-call ids are preserved verbatim so the loop can pair each result with
 * the call that produced it. That pairing is what makes parallel calls to the
 * SAME tool (two sector queries, say) unambiguous.
 */
export function decodeAssistantMessage(message: {
  content: string | null;
  tool_calls?: OpenAiToolCall[];
}): LlmTurn {
  const toolCalls = (message.tool_calls ?? [])
    // Guard against non-function tool types this agent does not use.
    .filter((tc) => !tc.type || tc.type === 'function')
    .map((tc, i) => {
      const { input, parseError } = parseToolArguments(tc.function?.arguments);
      return {
        // Some compatibility layers omit the id; synthesise a stable one so
        // results can still be paired positionally within the turn.
        id: tc.id || `call_${i}`,
        name: tc.function?.name ?? '',
        input,
        parseError,
      };
    });

  const content = (message.content ?? '').trim();
  return { text: content ? [content] : [], toolCalls };
}
