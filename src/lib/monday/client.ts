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
  /** Server-directed wait before retrying, when monday.com supplied one. */
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    opts: { status?: number; retryable?: boolean; details?: unknown; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'MondayApiError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * monday.com signals how long to wait in two different places: a `Retry-After`
 * header on 429s, and free text inside complexity-budget GraphQL errors
 * ("retry in 34 seconds"). Both are honoured — guessing a backoff when the
 * server has told us the answer is how a seeding run burns its retries.
 */
export function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 300) * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    if (delta > 0) return Math.min(delta, 300_000);
  }
  return undefined;
}

export function parseRetryAfterMessage(message: string): number | undefined {
  const m = message.match(/retry\s+in\s+(\d+)\s*(seconds?|s\b)?/i);
  if (!m) return undefined;
  const seconds = Number(m[1]);
  return Number.isFinite(seconds) ? Math.min(seconds, 300) * 1000 : undefined;
}

export interface RetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  /** True when monday.com dictated the delay rather than us guessing it. */
  serverDirected: boolean;
  error: MondayApiError;
}

export interface MondayClientOptions {
  token: string;
  apiVersion: string;
  /** Total attempts per request, including the first. */
  maxAttempts?: number;
  timeoutMs?: number;
  /**
   * Ceiling on a single backoff wait. The web app keeps this short so a request
   * fails fast; the seeding script raises it, because monday.com's rate-limit
   * window is per-minute and outlasting it is the whole point there.
   */
  maxBackoffMs?: number;
  /** Called before each retry, for progress logging. */
  onRetry?: (notice: RetryNotice) => void;
  fetchImpl?: typeof fetch;
}

const MUTATION_RE = /\bmutation\b/i;

export class MondayClient {
  private readonly token: string;
  private readonly apiVersion: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly onRetry?: (notice: RetryNotice) => void;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MondayClientOptions) {
    this.token = opts.token;
    this.apiVersion = opts.apiVersion;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 8_000;
    this.onRetry = opts.onRetry;
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
        // Bounded: a non-retryable error or the final attempt ends the loop, so
        // this can never spin indefinitely.
        if (!e.retryable || attempt === this.maxAttempts) break;

        // Prefer the server's own instruction; fall back to exponential
        // backoff with jitter (jitter avoids lockstep retries).
        const serverDirected = e.retryAfterMs !== undefined;
        const backoff = Math.min(this.maxBackoffMs, 500 * 2 ** (attempt - 1));
        const delay = serverDirected
          ? Math.min(e.retryAfterMs as number, this.maxBackoffMs) + 250
          : backoff + Math.random() * 250;

        this.onRetry?.({
          attempt,
          maxAttempts: this.maxAttempts,
          delayMs: Math.round(delay),
          serverDirected,
          error: e,
        });
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
      const retryAfterMs = parseRetryAfterHeader(res.headers?.get?.('retry-after') ?? null);
      throw new MondayApiError(
        res.status === 429
          ? `monday.com rate limit hit (429)${retryAfterMs ? `; server asked to wait ${Math.round(retryAfterMs / 1000)}s` : ''}.`
          : `monday.com server error (${res.status}).`,
        { status: res.status, retryable: true, retryAfterMs },
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
      // Complexity/rate errors are transient and worth retrying. monday.com
      // often states the wait inside the message itself.
      const retryable = /complexity|rate limit|budget|too many requests/i.test(msg);
      throw new MondayApiError(`monday.com GraphQL error: ${msg}`, {
        retryable,
        status: res.status,
        retryAfterMs: retryable ? parseRetryAfterMessage(msg) : undefined,
      });
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
