import { MondayClient, MondayApiError } from './client';

export interface RawItem {
  id: string;
  name: string;
  /** Column title (verbatim from monday.com) -> display text, or null when empty. */
  values: Record<string, string | null>;
}

export interface BoardColumn {
  id: string;
  title: string;
  type: string;
}

export interface RawBoard {
  boardId: string;
  boardName: string;
  columns: BoardColumn[];
  items: RawItem[];
  /** True when we stopped early because of the safety page cap. */
  truncated: boolean;
}

const BOARD_QUERY = `
  query($boardId: [ID!], $limit: Int!) {
    boards(ids: $boardId) {
      id
      name
      columns { id title type }
      items_page(limit: $limit) {
        cursor
        items {
          id
          name
          column_values { id text }
        }
      }
    }
  }
`;

const NEXT_PAGE_QUERY = `
  query($cursor: String!, $limit: Int!) {
    next_items_page(cursor: $cursor, limit: $limit) {
      cursor
      items {
        id
        name
        column_values { id text }
      }
    }
  }
`;

interface GqlItem {
  id: string;
  name: string;
  column_values: Array<{ id: string; text: string | null }>;
}

interface BoardResp {
  boards: Array<{
    id: string;
    name: string;
    columns: BoardColumn[];
    items_page: { cursor: string | null; items: GqlItem[] };
  }> | null;
}

interface NextResp {
  next_items_page: { cursor: string | null; items: GqlItem[] } | null;
}

const PAGE_SIZE = 250;
const MAX_PAGES = 60; // 15k items — far beyond expected board size, guards runaway loops.

function toRawItems(items: GqlItem[], byId: Map<string, string>): RawItem[] {
  return items.map((it) => {
    const values: Record<string, string | null> = {};
    for (const cv of it.column_values) {
      const title = byId.get(cv.id) ?? cv.id;
      const text = cv.text;
      values[title] = text === null || text === '' ? null : text;
    }
    return { id: it.id, name: it.name, values };
  });
}

/**
 * Fetches a full monday.com board (all columns, all items) with cursor pagination.
 * Read-only: uses `client.query`, which refuses mutations.
 */
export async function fetchBoard(client: MondayClient, boardId: string): Promise<RawBoard> {
  const first = await client.query<BoardResp>(BOARD_QUERY, { boardId: [boardId], limit: PAGE_SIZE });

  const board = first.boards?.[0];
  if (!board) {
    throw new MondayApiError(
      `Board ${boardId} was not found, or the API token has no access to it. ` +
        `Verify the board ID and that the token's user is a subscriber of the board.`,
      { retryable: false },
    );
  }

  const byId = new Map(board.columns.map((c) => [c.id, c.title]));
  const items: RawItem[] = toRawItems(board.items_page.items, byId);

  let cursor = board.items_page.cursor;
  let pages = 1;
  let truncated = false;

  while (cursor) {
    if (pages >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const next = await client.query<NextResp>(NEXT_PAGE_QUERY, { cursor, limit: PAGE_SIZE });
    const page = next.next_items_page;
    if (!page) break;
    items.push(...toRawItems(page.items, byId));
    cursor = page.cursor;
    pages++;
  }

  return {
    boardId: board.id,
    boardName: board.name,
    columns: board.columns,
    items,
    truncated,
  };
}
