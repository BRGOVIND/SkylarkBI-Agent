import Anthropic from '@anthropic-ai/sdk';
import {
  LlmError,
  type AgentMessage,
  type CompleteArgs,
  type LlmProvider,
  type LlmTurn,
  type ToolSpec,
} from '../provider';

/**
 * Anthropic adapter. Preserves the original behaviour exactly; only the
 * message construction moved here from the agent loop.
 */

export function toAnthropicMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      out.push({ role: 'assistant', content: blocks });
    } else {
      // Anthropic carries tool results as a single user turn of result blocks.
      out.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: r.content,
          is_error: r.isError,
        })),
      });
    }
  }
  return out;
}

export function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

export class AnthropicProvider implements LlmProvider {
  readonly providerName = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: { apiKey: string; model: string; client?: Anthropic }) {
    this.model = opts.model;
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
  }

  async complete(args: CompleteArgs): Promise<LlmTurn> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: args.maxTokens,
        system: args.system,
        tools: toAnthropicTools(args.tools),
        messages: toAnthropicMessages(args.messages),
      });
    } catch (err) {
      throw new LlmError(
        err instanceof Error ? err.message : 'Anthropic request failed',
        this.providerName,
        (err as { status?: number })?.status,
      );
    }

    const text: string[] = [];
    const toolCalls = [];
    for (const block of response.content) {
      if (block.type === 'text' && block.text) text.push(block.text);
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return { text, toolCalls };
  }
}
