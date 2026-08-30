import { loadConfig } from '../config';
import { SYSTEM_PROMPT, contextPreamble } from './prompt';
import { TOOL_DEFINITIONS, runTool } from './tools';
import { describeError } from '../data';
import { createProvider } from './factory';
import { LlmError, type AgentMessage, type LlmProvider } from './provider';

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
const MAX_TOKENS = 4096;

/**
 * Runs one conversational turn as an async generator of events, so the API
 * route can stream tool activity to the UI as it happens. Tool errors are fed
 * back to the model as tool results rather than aborting the turn — the model
 * can then explain the failure to the user in business terms.
 *
 * Vendor-neutral: everything below talks to an `LlmProvider`, so the same loop
 * drives Anthropic or Groq without change.
 */
export async function* runAgent(
  history: ChatTurn[],
  injected?: LlmProvider,
): AsyncGenerator<AgentEvent> {
  let provider: LlmProvider;
  try {
    provider = injected ?? createProvider(loadConfig());
  } catch (err) {
    yield { type: 'error', ...describeError(err) };
    return;
  }

  const messages: AgentMessage[] = history.map((t, i) => {
    if (t.role === 'user') {
      return {
        role: 'user',
        text:
          i === history.length - 1 ? `${contextPreamble(new Date())}\n\n${t.content}` : t.content,
      };
    }
    return { role: 'assistant', text: t.content, toolCalls: [] };
  });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let turn;
    try {
      turn = await provider.complete({
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFINITIONS,
        messages,
        maxTokens: MAX_TOKENS,
      });
    } catch (err) {
      yield {
        type: 'error',
        kind: 'llm',
        message:
          err instanceof LlmError
            ? `The reasoning model could not be reached (${err.provider}): ${err.message}`
            : err instanceof Error
              ? `The reasoning model could not be reached: ${err.message}`
              : 'The reasoning model could not be reached.',
      };
      return;
    }

    for (const text of turn.text) {
      if (text.trim()) yield { type: 'text', text };
    }

    if (turn.toolCalls.length === 0) {
      yield { type: 'done' };
      return;
    }

    messages.push({
      role: 'assistant',
      text: turn.text.join('\n\n'),
      toolCalls: turn.toolCalls,
    });

    const results: Array<{ id: string; name: string; content: string; isError: boolean }> = [];
    for (const call of turn.toolCalls) {
      // Malformed arguments are reported back to the model instead of being
      // executed with a guessed input.
      if (call.parseError) {
        yield { type: 'tool', name: call.name, label: `${call.name} (bad arguments)`, input: {} };
        results.push({
          id: call.id,
          name: call.name,
          content: JSON.stringify({
            error: call.parseError,
            guidance: 'Re-issue the tool call with a valid JSON object of arguments.',
          }),
          isError: true,
        });
        continue;
      }

      let payload: string;
      let isError = false;
      let label = call.name;
      try {
        const out = await runTool(call.name, call.input);
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
      yield { type: 'tool', name: call.name, label, input: call.input };
      results.push({ id: call.id, name: call.name, content: payload, isError });
    }

    messages.push({ role: 'tool_results', results });
  }

  yield {
    type: 'text',
    text: 'I reached my limit for data lookups on this question. Could you narrow it down a little — for example to a single sector, board, or time period?',
  };
  yield { type: 'done' };
}
