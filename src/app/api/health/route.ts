import { configStatus } from '@/lib/config';
import { loadBusinessData, describeError, snapshotAgeSeconds } from '@/lib/data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Connectivity and setup check. Deliberately reports only counts and setup
 * state — never any board content, and never the value of any secret.
 */
export async function GET() {
  const cfg = configStatus();
  if (!cfg.ok) {
    return Response.json(
      {
        status: 'not_configured',
        missingEnvVars: cfg.missing,
        llm: { provider: cfg.provider, model: cfg.model },
        hint: 'Set these environment variables and redeploy. See .env.example.',
      },
      { status: 503 },
    );
  }

  try {
    const data = await loadBusinessData();
    return Response.json({
      status: 'ok',
      monday: 'connected',
      // Which vendor is answering, never any key material.
      llm: { provider: cfg.provider, model: cfg.model },
      snapshotFetchedAt: data.fetchedAt,
      snapshotAgeSeconds: snapshotAgeSeconds(data),
      boards: {
        deals: {
          boardId: data.quality.deals.boardId,
          itemsFetched: data.quality.deals.totalItemsFetched,
          usableRecords: data.deals.length,
          unresolvedColumns: data.quality.deals.unresolvedColumns,
        },
        workOrders: {
          boardId: data.quality.workOrders.boardId,
          itemsFetched: data.quality.workOrders.totalItemsFetched,
          usableRecords: data.workOrders.length,
          unresolvedColumns: data.quality.workOrders.unresolvedColumns,
        },
      },
    });
  } catch (err) {
    const e = describeError(err);
    return Response.json({ status: 'error', kind: e.kind, message: e.message }, { status: 502 });
  }
}
