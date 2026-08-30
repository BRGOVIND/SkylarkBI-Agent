import { loadConfig } from './config';
import { MondayClient, MondayApiError } from './monday/client';
import { fetchBoard } from './monday/fetch';
import { normalizeDeals, normalizeWorkOrders } from './normalize';
import type { BusinessDataset } from './normalize/types';

/**
 * Fetches and normalises both boards, with a short server-side cache.
 *
 * A single conversational turn can trigger several analytics tools; without a
 * cache each one would re-query monday.com and quickly exhaust the API budget.
 * The TTL is short so the agent stays close to live board state.
 */

interface CacheEntry {
  data: BusinessDataset;
  expiresAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<BusinessDataset> | null = null;

export function invalidateCache(): void {
  cache = null;
}

export interface LoadOptions {
  forceRefresh?: boolean;
}

export async function loadBusinessData(opts: LoadOptions = {}): Promise<BusinessDataset> {
  const now = Date.now();
  if (!opts.forceRefresh && cache && cache.expiresAt > now) return cache.data;

  // Collapse concurrent requests onto one upstream fetch.
  if (!inflight) inflight = fetchFresh();
  const pending = inflight;

  try {
    return await pending;
  } catch (err) {
    // Serve stale data rather than failing outright when monday.com is down.
    // The snapshot's age travels with it (fetchedAt) so the agent can say so.
    if (cache) return cache.data;
    throw err;
  } finally {
    if (inflight === pending) inflight = null;
  }
}

async function fetchFresh(): Promise<BusinessDataset> {
  {
    const cfg = loadConfig();
    const client = new MondayClient({ token: cfg.mondayToken, apiVersion: cfg.mondayApiVersion });

    const [dealsBoard, woBoard] = await Promise.all([
      fetchBoard(client, cfg.dealsBoardId),
      fetchBoard(client, cfg.workOrdersBoardId),
    ]);

    const deals = normalizeDeals(dealsBoard);
    const workOrders = normalizeWorkOrders(woBoard);

    const data: BusinessDataset = {
      deals: deals.deals,
      workOrders: workOrders.workOrders,
      quality: { deals: deals.quality, workOrders: workOrders.quality },
      fetchedAt: new Date().toISOString(),
    };

    cache = { data, expiresAt: Date.now() + cfg.cacheTtlSeconds * 1000 };
    return data;
  }
}

/** Age in seconds of the snapshot currently held in cache. */
export function snapshotAgeSeconds(data: BusinessDataset): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(data.fetchedAt)) / 1000));
}

export function describeError(err: unknown): { message: string; kind: string } {
  if (err instanceof MondayApiError) {
    return { message: err.message, kind: 'monday_api' };
  }
  if (err instanceof Error && err.name === 'ConfigError') {
    return { message: err.message, kind: 'config' };
  }
  return {
    message: err instanceof Error ? err.message : 'Unexpected error',
    kind: 'unknown',
  };
}
