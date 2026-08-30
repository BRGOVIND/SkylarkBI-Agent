/**
 * Minimal Monday.com GraphQL API v2 client.
 *
 * Read-only by construction: `query()` rejects any operation containing a
 * GraphQL `mutation`, so no code path in the running agent can write to
 * monday.com even if a future prompt or tool tried to.
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';

export class MondayApiError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly details?: unknown;
  constructor(message: string, opts: { status?: number; retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = 'MondayApiError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

export interface MondayClientOptions {
  token: string;
  apiVersion: string;
  /** Total attempts per request, including the first. */
  maxAttempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const MUTATION_RE = /\bmutation\b/i;

export class MondayClient {
  private readonly token: string;
  private readonly apiVersion: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MondayClientOptions) {
    this.token = opts.token;
    this.apiVersion = opts.apiVersion;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (MUTATION_RE.test(query)) {
      throw new MondayApiError(
        'Refusing to execute a GraphQL mutation: this client is read-only.',
      );
    }
    return this.execute<T>(query, variables);
  }

  /**
   * Escape hatch used ONLY by the offline setup script (scripts/seed-monday.ts)
   * to create boards. Never reachable from the web application.
   */
  async unsafeMutate<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.execute<T>(query, variables);
  }

  private async execute<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let lastError: MondayApiError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.attempt<T>(query, variables);
      } catch (err) {
        const e =
          err instanceof MondayApiError
            ? err
            : new MondayApiError(
                err instanceof Error ? err.message : 'Unknown monday.com transport error',
                { retryable: true },
              );
        lastError = e;
        if (!e.retryable || attempt === this.maxAttempts) break;
        // Exponential backoff with jitter; monday.com rate-limits aggressively.
        const delay = Math.min(8_000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError ?? new MondayApiError('monday.com request failed');
  }

  private async attempt<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(MONDAY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.token,
          'API-Version': this.apiVersion,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new MondayApiError(
        aborted ? `monday.com request timed out after ${this.timeoutMs}ms` : 'Network error contacting monday.com',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new MondayApiError(
        'monday.com rejected the API token (401/403). Check MONDAY_API_TOKEN and that the token can read both boards.',
        { status: res.status, retryable: false },
      );
    }
    if (res.status === 429 || res.status >= 500) {
      throw new MondayApiError(
        res.status === 429
          ? 'monday.com rate limit hit (429).'
          : `monday.com server error (${res.status}).`,
        { status: res.status, retryable: true },
      );
    }

    const text = await res.text();
    let body: { data?: T; errors?: Array<{ message: string }>; error_message?: string };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new MondayApiError('monday.com returned a malformed (non-JSON) response.', {
        status: res.status,
        retryable: res.ok,
        details: text.slice(0, 400),
      });
    }

    if (body.errors?.length) {
      const msg = body.errors.map((e) => e.message).join('; ');
      // Complexity/rate errors are transient and worth retrying.
      const retryable = /complexity|rate limit|budget/i.test(msg);
      throw new MondayApiError(`monday.com GraphQL error: ${msg}`, { retryable, status: res.status });
    }
    if (body.error_message) {
      throw new MondayApiError(`monday.com error: ${body.error_message}`, { status: res.status });
    }
    if (!res.ok) {
      throw new MondayApiError(`monday.com HTTP ${res.status}`, { status: res.status });
    }
    if (body.data === undefined || body.data === null) {
      throw new MondayApiError('monday.com response contained no data field.', {
        status: res.status,
        details: text.slice(0, 400),
      });
    }
    return body.data;
  }
}
