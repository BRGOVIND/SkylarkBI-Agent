import { NextRequest } from 'next/server';
import { runAgent, type ChatTurn } from '@/lib/agent/run';
import { LIMITS } from '@/lib/datasets/limits';
import type { DatasetSnapshot } from '@/lib/datasets/types';

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
  let body: { messages?: unknown; datasets?: unknown };
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

  /**
   * Datasets are held by the browser and returned with each question. They are
   * shape-checked rather than trusted: a malformed snapshot is dropped instead
   * of reaching the query engine.
   */
  const datasets: DatasetSnapshot[] = [];
  if (body.datasets !== undefined) {
    if (!Array.isArray(body.datasets)) {
      return Response.json({ error: 'datasets must be an array.' }, { status: 400 });
    }
    if (body.datasets.length > LIMITS.datasets) {
      return Response.json(
        { error: `At most ${LIMITS.datasets} datasets can be active at once.` },
        { status: 400 },
      );
    }
    for (const d of body.datasets) {
      const snap = d as Partial<DatasetSnapshot>;
      if (
        !snap ||
        typeof snap !== 'object' ||
        typeof snap.id !== 'string' ||
        typeof snap.name !== 'string' ||
        typeof snap.rowCount !== 'number' ||
        !Array.isArray(snap.columns) ||
        !snap.data ||
        typeof snap.data !== 'object'
      ) {
        return Response.json({ error: 'A dataset was malformed.' }, { status: 400 });
      }
      datasets.push(snap as DatasetSnapshot);
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      try {
        for await (const event of runAgent(history, undefined, datasets)) send(event);
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
