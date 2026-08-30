import { describe, expect, it, vi } from 'vitest';
import { MondayClient, MondayApiError } from '@/lib/monday/client';
import { fetchBoard } from '@/lib/monday/fetch';
import { resolveSchema, DEAL_ALIASES, WORK_ORDER_ALIASES } from '@/lib/monday/schema';
import type { DealField, WorkOrderField } from '@/lib/monday/schema';

const ok = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function client(fetchImpl: typeof fetch, maxAttempts = 3) {
  return new MondayClient({ token: 't', apiVersion: '2024-10', maxAttempts, fetchImpl });
}

describe('MondayClient read-only guarantee', () => {
  it('refuses to execute a mutation', async () => {
    const spy = vi.fn();
    await expect(
      client(spy as unknown as typeof fetch).query('mutation { create_item(board_id: 1) { id } }'),
    ).rejects.toThrow(/read-only/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a mutation hidden inside a larger document', async () => {
    const spy = vi.fn();
    await expect(
      client(spy as unknown as typeof fetch).query('query Q { boards { id } }\nmutation M { x }'),
    ).rejects.toThrow(/read-only/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows ordinary queries through', async () => {
    const f = vi.fn().mockResolvedValue(ok({ boards: [] }));
    const res = await client(f as unknown as typeof fetch).query<{ boards: unknown[] }>('query { boards { id } }');
    expect(res.boards).toEqual([]);
  });
});

describe('MondayClient error handling', () => {
  it('treats 401 as a non-retryable auth failure', async () => {
    const f = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    await expect(client(f as unknown as typeof fetch).query('query { me { id } }')).rejects.toThrow(
      /rejected the API token/i,
    );
    expect(f).toHaveBeenCalledTimes(1); // no retries on auth failure
  });

  it('retries on 429 and succeeds', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(ok({ boards: [{ id: '1' }] }));
    const res = await client(f as unknown as typeof fetch).query<{ boards: unknown[] }>('query { boards { id } }');
    expect(res.boards).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx then gives up with a clear error', async () => {
    const f = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    await expect(client(f as unknown as typeof fetch).query('query { boards { id } }')).rejects.toThrow(
      /server error/i,
    );
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('surfaces GraphQL errors', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'Field does not exist' }] }), { status: 200 }),
    );
    await expect(client(f as unknown as typeof fetch).query('query { nope }')).rejects.toThrow(
      /Field does not exist/,
    );
  });

  it('retries GraphQL complexity budget errors', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ message: 'Complexity budget exhausted' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(ok({ boards: [] }));
    await client(f as unknown as typeof fetch).query('query { boards { id } }');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('handles a malformed non-JSON response', async () => {
    // A fresh Response per call: a retried request cannot re-read a used body.
    const f = vi.fn().mockImplementation(async () => new Response('<html>gateway</html>', { status: 200 }));
    await expect(client(f as unknown as typeof fetch).query('query { boards { id } }')).rejects.toThrow(
      /malformed/i,
    );
  });

  it('handles a network failure', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(client(f as unknown as typeof fetch).query('query { boards { id } }')).rejects.toBeInstanceOf(
      MondayApiError,
    );
  });
});

describe('fetchBoard', () => {
  const columns = [
    { id: 'c1', title: 'Deal Status', type: 'text' },
    { id: 'c2', title: 'Masked Deal value', type: 'numbers' },
  ];

  it('maps column ids to titles and treats empty text as null', async () => {
    const f = vi.fn().mockResolvedValue(
      ok({
        boards: [
          {
            id: '9',
            name: 'Deals',
            columns,
            items_page: {
              cursor: null,
              items: [
                { id: 'i1', name: 'Naruto', column_values: [
                  { id: 'c1', text: 'Open' },
                  { id: 'c2', text: '' },
                ] },
              ],
            },
          },
        ],
      }),
    );
    const board = await fetchBoard(client(f as unknown as typeof fetch), '9');
    expect(board.items[0].values['Deal Status']).toBe('Open');
    expect(board.items[0].values['Masked Deal value']).toBeNull();
  });

  it('follows the cursor across pages', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          boards: [
            {
              id: '9',
              name: 'Deals',
              columns,
              items_page: {
                cursor: 'CUR1',
                items: [{ id: 'i1', name: 'A', column_values: [{ id: 'c1', text: 'Open' }] }],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        ok({
          next_items_page: {
            cursor: null,
            items: [{ id: 'i2', name: 'B', column_values: [{ id: 'c1', text: 'Won' }] }],
          },
        }),
      );
    const board = await fetchBoard(client(f as unknown as typeof fetch), '9');
    expect(board.items).toHaveLength(2);
    expect(board.truncated).toBe(false);
  });

  it('gives an actionable error when the board is missing or inaccessible', async () => {
    const f = vi.fn().mockResolvedValue(ok({ boards: [] }));
    await expect(fetchBoard(client(f as unknown as typeof fetch), '404')).rejects.toThrow(
      /was not found, or the API token has no access/i,
    );
  });

  it('handles an empty board', async () => {
    const f = vi.fn().mockResolvedValue(
      ok({ boards: [{ id: '9', name: 'Deals', columns, items_page: { cursor: null, items: [] } }] }),
    );
    const board = await fetchBoard(client(f as unknown as typeof fetch), '9');
    expect(board.items).toEqual([]);
  });
});

describe('resolveSchema', () => {
  it('matches the exact titles produced by the supplied spreadsheets', () => {
    const cols = [
      'Deal Name', 'Owner code', 'Client Code', 'Deal Status', 'Close Date (A)',
      'Closure Probability', 'Masked Deal value', 'Tentative Close Date', 'Deal Stage',
      'Product deal', 'Sector/service', 'Created Date',
    ].map((t, i) => ({ id: `c${i}`, title: t, type: 'text' }));
    const r = resolveSchema<DealField>(cols, DEAL_ALIASES);
    expect(r.unresolved).toEqual([]);
    expect(r.map.dealValue).toBe('Masked Deal value');
    expect(r.map.sector).toBe('Sector/service');
    expect(r.map.actualCloseDate).toBe('Close Date (A)');
    expect(r.map.tentativeCloseDate).toBe('Tentative Close Date');
  });

  it('resolves the work order board titles', () => {
    const cols = [
      'Deal name masked', 'Customer Name Code', 'Serial #', 'Execution Status', 'Sector',
      'Amount in Rupees (Excl of GST) (Masked)', 'Billed Value in Rupees (Excl of GST.) (Masked)',
      'Amount Receivable (Masked)', 'BD/KAM Personnel code', 'WO Status (billed)',
    ].map((t, i) => ({ id: `w${i}`, title: t, type: 'text' }));
    const r = resolveSchema<WorkOrderField>(cols, WORK_ORDER_ALIASES);
    expect(r.map.orderValueExGst).toBe('Amount in Rupees (Excl of GST) (Masked)');
    expect(r.map.billedExGst).toBe('Billed Value in Rupees (Excl of GST.) (Masked)');
    expect(r.map.receivable).toBe('Amount Receivable (Masked)');
    expect(r.map.ownerCode).toBe('BD/KAM Personnel code');
  });

  it('tolerates casing and punctuation differences', () => {
    const cols = [
      { id: 'a', title: 'deal  name', type: 'text' },
      { id: 'b', title: 'SECTOR / SERVICE', type: 'text' },
    ];
    const r = resolveSchema<DealField>(cols, DEAL_ALIASES);
    expect(r.map.dealName).toBe('deal  name');
    expect(r.map.sector).toBe('SECTOR / SERVICE');
  });

  it('never claims the same column for two fields', () => {
    const cols = [{ id: 'a', title: 'Sector', type: 'text' }];
    const r = resolveSchema<DealField>(cols, DEAL_ALIASES);
    const used = Object.values(r.map);
    expect(new Set(used).size).toBe(used.length);
  });

  it('reports unresolved and unmapped columns', () => {
    const cols = [
      { id: 'a', title: 'Deal Name', type: 'text' },
      { id: 'b', title: 'Some Custom Column', type: 'text' },
    ];
    const r = resolveSchema<DealField>(cols, DEAL_ALIASES);
    expect(r.unresolved).toContain('dealValue');
    expect(r.unmapped).toContain('Some Custom Column');
  });
});
