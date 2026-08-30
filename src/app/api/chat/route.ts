import { NextRequest } from 'next/server';
import { runAgent, type ChatTurn } from '@/lib/agent/run';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_TURNS = 24;
const MAX_CHARS = 4000;

/**
 * Streams agent events to the browser as newline-delimited JSON.
 *
 * All secrets and all monday.com access stay on this side of the boundary; the
 * client only ever sees rendered text and tool labels.
 */
export async function POST(req: NextRequest) {
  let body: { messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const raw = body.messages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return Response.json({ error: 'messages must be a non-empty array.' }, { status: 400 });
  }
  if (raw.length > MAX_TURNS) {
    return Response.json({ error: 'Conversation too long. Please start a new chat.' }, { status: 400 });
  }

  const history: ChatTurn[] = [];
  for (const m of raw) {
    if (
      typeof m !== 'object' ||
      m === null ||
      ((m as ChatTurn).role !== 'user' && (m as ChatTurn).role !== 'assistant') ||
      typeof (m as ChatTurn).content !== 'string'
    ) {
      return Response.json({ error: 'Each message needs a role of user|assistant and string content.' }, { status: 400 });
    }
    const t = m as ChatTurn;
    if (!t.content.trim()) continue;
    history.push({ role: t.role, content: t.content.slice(0, MAX_CHARS) });
  }
  if (!history.length || history[history.length - 1].role !== 'user') {
    return Response.json({ error: 'The last message must be from the user.' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      try {
        for await (const event of runAgent(history)) send(event);
      } catch (err) {
        send({
          type: 'error',
          kind: 'unknown',
          message: err instanceof Error ? err.message : 'The agent stopped unexpectedly.',
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
