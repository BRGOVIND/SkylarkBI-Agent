import { describe, expect, it, vi } from 'vitest';
import {
  MondayClient,
  MondayApiError,
  parseRetryAfterHeader,
  parseRetryAfterMessage,
  type MondayClientOptions,
} from '@/lib/monday/client';

/**
 * Rate-limit resilience and resumability for the one-time seeding script.
 *
 * The reconciliation logic under test mirrors `scripts/seed-monday.ts`. It is
 * reproduced here rather than imported because the script is a CLI entry point
 * that reads argv and runs `main()` on import; the pure functions are small and
 * the duplication keeps the test hermetic.
 */

/** A successful GraphQL response, wrapped in the `data` envelope. */
const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** A raw GraphQL body, for error shapes that carry no `data`. */
const raw = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function client(fetchImpl: typeof fetch, opts: Partial<MondayClientOptions> = {}) {
  return new MondayClient({
    token: 't',
    apiVersion: '2024-10',
    maxAttempts: 4,
    maxBackoffMs: 20, // keep tests fast; policy is what matters, not wall time
    fetchImpl,
    ...opts,
  });
}

/* --------------------------- retry-after parsing -------------------------- */

describe('Retry-After parsing', () => {
  it('reads a numeric seconds header', () => {
    expect(parseRetryAfterHeader('30')).toBe(30_000);
    expect(parseRetryAfterHeader(' 5 ')).toBe(5_000);
  });

  it('reads an HTTP-date header', () => {
    const future = new Date(Date.now() + 20_000).toUTCString();
    const ms = parseRetryAfterHeader(future);
    expect(ms).toBeGreaterThan(10_000);
    expect(ms).toBeLessThanOrEqual(20_000);
  });

  it('ignores absent or nonsense headers', () => {
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader('soon')).toBeUndefined();
  });

  it('caps an absurd wait rather than stalling forever', () => {
    expect(parseRetryAfterHeader('99999')).toBe(300_000);
  });

  it('extracts the wait monday.com states inside a complexity error', () => {
    expect(parseRetryAfterMessage('Complexity budget exhausted, retry in 34 seconds')).toBe(34_000);
    expect(parseRetryAfterMessage('Rate limit exceeded. Retry in 7s')).toBe(7_000);
    expect(parseRetryAfterMessage('something else entirely')).toBeUndefined();
  });
});

/* ---------------------------- 429 retry behaviour ------------------------- */

describe('429 handling', () => {
  it('retries a 429 and succeeds once the limit clears', async () => {
    const f = vi
      .fn()
      .mockImplementationOnce(async () => new Response('', { status: 429 }))
      .mockImplementationOnce(async () => new Response('', { status: 429 }))
      .mockImplementationOnce(async () => json({ create_item: { id: '1' } }));

    const res = await client(f as unknown as typeof fetch).unsafeMutate<{ create_item: { id: string } }>(
      'mutation { create_item { id } }',
    );
    expect(res.create_item.id).toBe('1');
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('honours the server-directed Retry-After instead of guessing', async () => {
    const notices: Array<{ delayMs: number; serverDirected: boolean }> = [];
    const f = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response('', { status: 429, headers: { 'Retry-After': '10' } }),
      )
      .mockImplementationOnce(async () => json({ ok: true }));

    await client(f as unknown as typeof fetch, {
      maxBackoffMs: 30, // clamps the 10s instruction so the test stays fast
      onRetry: (n: { delayMs: number; serverDirected: boolean }) =>
        notices.push({ delayMs: n.delayMs, serverDirected: n.serverDirected }),
    }).query('query { me { id } }');

    expect(notices).toHaveLength(1);
    expect(notices[0].serverDirected).toBe(true);
  });

  it('surfaces the server-directed wait on the error object', async () => {
    const f = vi.fn().mockImplementation(
      async () => new Response('', { status: 429, headers: { 'Retry-After': '12' } }),
    );
    const err = await client(f as unknown as typeof fetch, { maxAttempts: 1 })
      .query('query { me { id } }')
      .catch((e) => e as MondayApiError);
    expect(err).toBeInstanceOf(MondayApiError);
    expect((err as MondayApiError).retryAfterMs).toBe(12_000);
    expect((err as MondayApiError).message).toMatch(/wait 12s/);
  });

  it('retries a complexity-budget GraphQL error using its stated wait', async () => {
    const f = vi
      .fn()
      .mockImplementationOnce(async () =>
        raw({ errors: [{ message: 'Complexity budget exhausted, retry in 2 seconds' }] }),
      )
      .mockImplementationOnce(async () => json({ ok: true }));
    const notices: boolean[] = [];
    await client(f as unknown as typeof fetch, {
      maxBackoffMs: 20,
      onRetry: (n: { serverDirected: boolean }) => notices.push(n.serverDirected),
    }).query('query { boards { id } }');
    expect(f).toHaveBeenCalledTimes(2);
    expect(notices[0]).toBe(true);
  });
});

/* ---------------------------- retry exhaustion ---------------------------- */

describe('retry exhaustion', () => {
  it('gives up after the bounded number of attempts, never looping forever', async () => {
    const f = vi.fn().mockImplementation(async () => new Response('', { status: 429 }));
    const c = client(f as unknown as typeof fetch, { maxAttempts: 4 });
    await expect(c.query('query { me { id } }')).rejects.toThrow(/rate limit/i);
    expect(f).toHaveBeenCalledTimes(4); // exactly maxAttempts, no more
  });

  it('does not retry a non-retryable auth failure', async () => {
    const f = vi.fn().mockImplementation(async () => new Response('', { status: 401 }));
    await expect(client(f as unknown as typeof fetch).query('query { me { id } }')).rejects.toThrow(
      /rejected the API token/i,
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('reports the final failure as a MondayApiError the caller can classify', async () => {
    const f = vi.fn().mockImplementation(async () => new Response('', { status: 429 }));
    const err = await client(f as unknown as typeof fetch, { maxAttempts: 2 })
      .query('query { me { id } }')
      .catch((e) => e as MondayApiError);
    expect(err).toBeInstanceOf(MondayApiError);
    expect((err as MondayApiError).status).toBe(429);
    expect((err as MondayApiError).retryable).toBe(true);
  });
});

/* -------------------------- board reuse / discovery ----------------------- */

/** Mirrors `findBoardByName` in the seeding script. */
function pickBoardByName(boards: Array<{ id: string; name: string }>, name: string): string | null {
  const matches = boards.filter((b) => b.name.trim() === name.trim());
  if (matches.length > 1) throw new Error(`Found ${matches.length} boards named "${name}"`);
  return matches[0]?.id ?? null;
}

describe('existing board reuse', () => {
  const boards = [
    { id: '5030964935', name: 'Skylark — Deals' },
    { id: '999', name: 'Some other board' },
  ];

  it('finds the already-created Deals board by exact name', () => {
    expect(pickBoardByName(boards, 'Skylark — Deals')).toBe('5030964935');
  });

  it('tolerates surrounding whitespace', () => {
    expect(pickBoardByName(boards, '  Skylark — Deals  ')).toBe('5030964935');
  });

  it('returns null when no board matches, so the caller creates one', () => {
    expect(pickBoardByName(boards, 'Skylark — Work Orders')).toBeNull();
  });

  it('refuses to guess when the name is ambiguous', () => {
    const dupes = [
      { id: '1', name: 'Skylark — Deals' },
      { id: '2', name: 'Skylark — Deals' },
    ];
    expect(() => pickBoardByName(dupes, 'Skylark — Deals')).toThrow(/Found 2 boards/);
  });
});

/* -------------------- fingerprinting and reconciliation ------------------- */

type ColType = 'date' | 'numbers' | 'text';

function toDateValue(v: string): string | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (d) return `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`;
  return null;
}

function canonicalCell(raw: string | null, type: ColType): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  if (type === 'date') return toDateValue(v) ?? '';
  if (type === 'numbers') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? String(n) : '';
  }
  return v;
}

function canonicalName(raw: string): string {
  const v = raw.trim();
  if (!v) return '(unnamed)';
  return /^\(unnamed(\s+\d+)?\)$/i.test(v) ? '(unnamed)' : v;
}

function fingerprint(name: string, cells: Array<[string, string]>): string {
  return JSON.stringify([canonicalName(name), [...cells].sort((a, b) => a[0].localeCompare(b[0]))]);
}

interface Row {
  name: string;
  cells: Map<string, string>;
  fp: string;
}
interface Item {
  id: string;
  name: string;
  values: Record<string, string | null>;
}

const COLUMNS = new Map<string, ColType>([
  ['Deal Status', 'text'],
  ['Masked Deal value', 'numbers'],
  ['Created Date', 'date'],
]);

function planRow(name: string, raw: Record<string, string>): Row {
  const cells = new Map<string, string>();
  for (const [h, t] of COLUMNS) cells.set(h, canonicalCell(raw[h] ?? '', t));
  return { name: canonicalName(name), cells, fp: fingerprint(name, [...cells]) };
}

/** Mirrors the placeholder rule in the seeding script. */
const PLACEHOLDER_NAME = /^(task|item|subitem)\s*\d+$/i;

function isKnownPlaceholder(item: Item): boolean {
  if (!PLACEHOLDER_NAME.test(item.name.trim())) return false;
  for (const header of COLUMNS.keys()) {
    if ((item.values[header] ?? '').trim() !== '') return false;
  }
  return true;
}

function reconcile(planned: Row[], items: Item[]) {
  const boardCounts = new Map<string, string[]>();
  for (const item of items) {
    const cells: Array<[string, string]> = [];
    for (const [h, t] of COLUMNS) cells.push([h, canonicalCell(item.values[h] ?? null, t)]);
    const fp = fingerprint(item.name, cells);
    const b = boardCounts.get(fp);
    if (b) b.push(item.id);
    else boardCounts.set(fp, [item.id]);
  }
  const remaining = new Map([...boardCounts].map(([fp, ids]) => [fp, ids.length]));
  const pending: Row[] = [];
  let matched = 0;
  for (const row of planned) {
    const left = remaining.get(row.fp) ?? 0;
    if (left > 0) {
      remaining.set(row.fp, left - 1);
      matched++;
    } else pending.push(row);
  }
  const unmatched: string[] = [];
  const placeholders: string[] = [];
  for (const [fp, left] of remaining) {
    if (left <= 0) continue;
    for (const id of (boardCounts.get(fp) ?? []).slice(-left)) {
      const item = items.find((i) => i.id === id)!;
      if (isKnownPlaceholder(item)) placeholders.push(id);
      else unmatched.push(id);
    }
  }
  return { matched, pending, unmatched, placeholders };
}

const asItem = (id: string, name: string, v: Record<string, string | null>): Item => ({
  id,
  name,
  values: v,
});

describe('already-seeded row detection', () => {
  const rowA = planRow('Naruto', {
    'Deal Status': 'Open',
    'Masked Deal value': '489360',
    'Created Date': '2025-11-01 00:00:00',
  });
  const rowB = planRow('Sasuke', {
    'Deal Status': 'Won',
    'Masked Deal value': '1000',
    'Created Date': '2025-11-02 00:00:00',
  });

  it('matches a row to the item monday.com created from it', () => {
    // Note the round-trip: the source date carried a time component, and
    // monday.com hands back a bare date.
    const items = [
      asItem('i1', 'Naruto', {
        'Deal Status': 'Open',
        'Masked Deal value': '489360',
        'Created Date': '2025-11-01',
      }),
    ];
    const r = reconcile([rowA, rowB], items);
    expect(r.matched).toBe(1);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0].name).toBe('Sasuke');
    expect(r.unmatched).toEqual([]);
  });

  it('is idempotent — a fully seeded board yields nothing pending', () => {
    const items = [
      asItem('i1', 'Naruto', {
        'Deal Status': 'Open',
        'Masked Deal value': '489360',
        'Created Date': '2025-11-01',
      }),
      asItem('i2', 'Sasuke', {
        'Deal Status': 'Won',
        'Masked Deal value': '1000',
        'Created Date': '2025-11-02',
      }),
    ];
    const r = reconcile([rowA, rowB], items);
    expect(r.pending).toEqual([]);
    expect(r.matched).toBe(2);
  });

  it('does not rely on row order', () => {
    // Board returns the items reversed relative to the sheet.
    const items = [
      asItem('i2', 'Sasuke', {
        'Deal Status': 'Won',
        'Masked Deal value': '1000',
        'Created Date': '2025-11-02',
      }),
      asItem('i1', 'Naruto', {
        'Deal Status': 'Open',
        'Masked Deal value': '489360',
        'Created Date': '2025-11-01',
      }),
    ];
    expect(reconcile([rowA, rowB], items).pending).toEqual([]);
  });

  it('tolerates numeric formatting differences on round-trip', () => {
    const row = planRow('Zoro', { 'Masked Deal value': '1000.50', 'Deal Status': 'Open' });
    const items = [asItem('i1', 'Zoro', { 'Masked Deal value': '1000.5', 'Deal Status': 'Open' })];
    expect(reconcile([row], items).pending).toEqual([]);
  });

  it('distinguishes rows that differ only in one field', () => {
    const a = planRow('Luffy', { 'Deal Status': 'Open', 'Masked Deal value': '100' });
    const b = planRow('Luffy', { 'Deal Status': 'Won', 'Masked Deal value': '100' });
    const items = [asItem('i1', 'Luffy', { 'Deal Status': 'Open', 'Masked Deal value': '100' })];
    const r = reconcile([a, b], items);
    expect(r.matched).toBe(1);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0].cells.get('Deal Status')).toBe('Won');
  });

  it('reconciles rows the earlier script named "(unnamed N)" by position', () => {
    const row = planRow('', { 'Deal Status': 'Open', 'Masked Deal value': '5' });
    const items = [asItem('i1', '(unnamed 47)', { 'Deal Status': 'Open', 'Masked Deal value': '5' })];
    expect(reconcile([row], items).pending).toEqual([]);
  });

  it('flags board rows that correspond to no source row', () => {
    const items = [
      asItem('i9', 'Ghost Deal', { 'Deal Status': 'Open', 'Masked Deal value': '7' }),
    ];
    const r = reconcile([rowA], items);
    expect(r.unmatched).toEqual(['i9']);
    expect(r.pending).toHaveLength(1); // rowA still needs inserting
  });
});

describe('duplicate source rows survive a resume', () => {
  const dupe = () =>
    planRow('Scooby-Doo', {
      'Deal Status': 'Won',
      'Masked Deal value': '',
      'Created Date': '2025-11-27',
    });

  it('counts duplicates as a multiset rather than collapsing them', () => {
    const planned = [dupe(), dupe(), dupe()];
    const items = [
      asItem('i1', 'Scooby-Doo', {
        'Deal Status': 'Won',
        'Masked Deal value': null,
        'Created Date': '2025-11-27',
      }),
    ];
    const r = reconcile(planned, items);
    // One of three identical rows is on the board, so exactly two remain.
    expect(r.matched).toBe(1);
    expect(r.pending).toHaveLength(2);
    expect(r.unmatched).toEqual([]);
  });

  it('inserts nothing more once every copy is present', () => {
    const planned = [dupe(), dupe()];
    const mk = (id: string) =>
      asItem(id, 'Scooby-Doo', {
        'Deal Status': 'Won',
        'Masked Deal value': null,
        'Created Date': '2025-11-27',
      });
    expect(reconcile(planned, [mk('i1'), mk('i2')]).pending).toEqual([]);
  });
});

describe("monday.com's default placeholder row", () => {
  const row = planRow('Naruto', { 'Deal Status': 'Open', 'Masked Deal value': '489360' });
  const empty = { 'Deal Status': null, 'Masked Deal value': null, 'Created Date': null };

  it('recognises the empty "Task 1" row monday.com creates with a new board', () => {
    const r = reconcile([row], [asItem('2848283277', 'Task 1', empty)]);
    expect(r.placeholders).toEqual(['2848283277']);
    expect(r.unmatched).toEqual([]); // does not block the import
    expect(r.pending).toHaveLength(1); // the real row is still pending
  });

  it('recognises the other default names monday.com uses', () => {
    for (const name of ['Item 1', 'Task 2', 'Subitem 1', 'task 1', 'Item  3']) {
      expect(isKnownPlaceholder(asItem('x', name, empty))).toBe(true);
    }
  });

  // The safety check must stay narrow: these are the ways it could be weakened.
  it('does NOT treat a placeholder-named row carrying data as a placeholder', () => {
    const withData = asItem('x', 'Task 1', { ...empty, 'Deal Status': 'Open' });
    expect(isKnownPlaceholder(withData)).toBe(false);
    const r = reconcile([row], [withData]);
    expect(r.unmatched).toEqual(['x']); // still blocks
    expect(r.placeholders).toEqual([]);
  });

  it('does NOT treat an arbitrary empty row as a placeholder', () => {
    const ghost = asItem('g', 'Ghost Deal', empty);
    expect(isKnownPlaceholder(ghost)).toBe(false);
    expect(reconcile([row], [ghost]).unmatched).toEqual(['g']);
  });

  it('does NOT match names that merely resemble the default pattern', () => {
    for (const name of ['Task 1 - urgent', 'Tasks 1', 'My Task 1', 'Task', 'Task one']) {
      expect(isKnownPlaceholder(asItem('x', name, empty))).toBe(false);
    }
  });

  it('still blocks when a genuine unknown row accompanies a placeholder', () => {
    const r = reconcile([row], [
      asItem('p', 'Task 1', empty),
      asItem('g', 'Ghost Deal', { ...empty, 'Masked Deal value': '99' }),
    ]);
    expect(r.placeholders).toEqual(['p']);
    expect(r.unmatched).toEqual(['g']);
  });

  it('never diverts a real source row into the placeholder bucket', () => {
    // A source row named "Task 1" would be matched normally, never skipped.
    const taskRow = planRow('Task 1', { 'Deal Status': 'Open' });
    const r = reconcile([taskRow], [asItem('i1', 'Task 1', { ...empty, 'Deal Status': 'Open' })]);
    expect(r.matched).toBe(1);
    expect(r.pending).toEqual([]);
    expect(r.placeholders).toEqual([]);
    expect(r.unmatched).toEqual([]);
  });
});

describe('the real board 5030964935 state', () => {
  it('reproduces the observed 21 imported / 1 placeholder / 325 pending split', () => {
    const rows = Array.from({ length: 346 }, (_, i) =>
      planRow(`Deal ${i}`, { 'Deal Status': 'Open', 'Masked Deal value': String(i) }),
    );
    const items: Item[] = rows.slice(0, 21).map((r, i) =>
      asItem(`i${i}`, r.name, {
        'Deal Status': r.cells.get('Deal Status') ?? null,
        'Masked Deal value': r.cells.get('Masked Deal value') ?? null,
        'Created Date': r.cells.get('Created Date') ?? null,
      }),
    );
    items.push(
      asItem('2848283277', 'Task 1', {
        'Deal Status': null,
        'Masked Deal value': null,
        'Created Date': null,
      }),
    );

    const r = reconcile(rows, items);
    expect(items).toHaveLength(22); // matches "rows on board: 22"
    expect(r.matched).toBe(21); // matches "already imported: 21"
    expect(r.pending).toHaveLength(325); // matches "still to import: 325"
    expect(r.placeholders).toEqual(['2848283277']);
    expect(r.unmatched).toEqual([]); // no longer blocks
  });
});

describe('resume after partial seeding', () => {
  /** 346 rows, of which a 429 interrupted the run partway through. */
  function sheet(n: number): Row[] {
    return Array.from({ length: n }, (_, i) =>
      planRow(`Deal ${i}`, {
        'Deal Status': i % 2 ? 'Open' : 'Won',
        'Masked Deal value': String(1000 + i),
        'Created Date': '2025-11-01',
      }),
    );
  }
  function seeded(rows: Row[], upTo: number): Item[] {
    return rows.slice(0, upTo).map((r, i) =>
      asItem(`i${i}`, r.name, {
        'Deal Status': r.cells.get('Deal Status') ?? null,
        'Masked Deal value': r.cells.get('Masked Deal value') ?? null,
        'Created Date': r.cells.get('Created Date') ?? null,
      }),
    );
  }

  it('resumes exactly where the interrupted run stopped', () => {
    const rows = sheet(346);
    const r = reconcile(rows, seeded(rows, 120));
    expect(r.matched).toBe(120);
    expect(r.pending).toHaveLength(226);
    expect(r.unmatched).toEqual([]);
  });

  it('a second resume after further progress inserts only the remainder', () => {
    const rows = sheet(346);
    const r = reconcile(rows, seeded(rows, 300));
    expect(r.pending).toHaveLength(46);
  });

  it('completes cleanly when the board already holds every row', () => {
    const rows = sheet(346);
    const r = reconcile(rows, seeded(rows, 346));
    expect(r.pending).toEqual([]);
    expect(r.unmatched).toEqual([]);
  });

  it('handles an empty board as a fresh start', () => {
    const rows = sheet(10);
    expect(reconcile(rows, []).pending).toHaveLength(10);
  });
});
