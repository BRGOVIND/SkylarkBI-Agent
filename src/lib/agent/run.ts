import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config';
import { SYSTEM_PROMPT, contextPreamble } from './prompt';
import { TOOL_DEFINITIONS, runTool } from './tools';
import { describeError } from '../data';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentEvent =
  | { type: 'tool'; name: string; label: string; input: unknown }
  | { type: 'text'; text: string }
  | { type: 'error'; message: string; kind: string }
  | { type: 'done' };

const MAX_TOOL_ROUNDS = 6;

/**
 * Runs one conversational turn as an async generator of events, so the API
 * route can stream tool activity to the UI as it happens. Tool errors are fed
 * back to the model as tool results rather than aborting the turn — the model
 * can then explain the failure to the user in business terms.
 */
export async function* runAgent(history: ChatTurn[]): AsyncGenerator<AgentEvent> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const e = describeError(err);
    yield { type: 'error', ...e };
    return;
  }

  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  const messages: Anthropic.MessageParam[] = history.map((t, i) => ({
    role: t.role,
    content:
      t.role === 'user' && i === history.length - 1
        ? `${contextPreamble(new Date())}\n\n${t.content}`
        : t.content,
  }));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: cfg.anthropicModel,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFINITIONS,
        messages,
      });
    } catch (err) {
      yield {
        type: 'error',
        kind: 'llm',
        message:
          err instanceof Error
            ? `The reasoning model could not be reached: ${err.message}`
            : 'The reasoning model could not be reached.',
      };
      return;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        yield { type: 'text', text: block.text };
      }
    }

    if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
      yield { type: 'done' };
      return;
    }

    messages.push({ role: 'assistant', content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      let payload: string;
      let isError = false;
      let label = use.name;
      try {
        const out = await runTool(use.name, (use.input ?? {}) as Record<string, unknown>);
        label = out.label;
        payload = JSON.stringify(out.result);
      } catch (err) {
        const e = describeError(err);
        isError = true;
        payload = JSON.stringify({
          error: e.message,
          kind: e.kind,
          guidance:
            e.kind === 'monday_api'
              ? 'Tell the user the monday.com boards could not be read, quote the reason, and suggest checking the API token and board IDs. Do not invent figures.'
              : 'Tell the user the request could not be completed and why. Do not invent figures.',
        });
      }
      yield { type: 'tool', name: use.name, label, input: use.input };
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: payload,
        is_error: isError,
      });
    }

    messages.push({ role: 'user', content: results });
  }

  yield {
    type: 'text',
    text: 'I reached my limit for data lookups on this question. Could you narrow it down a little — for example to a single sector, board, or time period?',
  };
  yield { type: 'done' };
}
