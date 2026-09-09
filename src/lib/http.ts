/**
 * Fetch with bounded retries for a flaky, rate-limited upstream.
 *
 * Reddit's unauthenticated endpoints budget requests per source IP. On a
 * serverless host that IP is shared with every other tenant on the same egress
 * pool, so a 429 frequently reflects other people's traffic rather than ours and
 * can clear within seconds. A small number of spaced retries recovers from that
 * case; a standing block is not something retrying can fix, so the budget here
 * is deliberately tight.
 */

/** Failure talking to the upstream feed, carrying enough detail to explain it. */
export class UpstreamError extends Error {
  readonly status?: number;
  readonly isRateLimited: boolean;
  readonly attempts: number;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: {
      status?: number;
      attempts: number;
      retryAfterSeconds?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "UpstreamError";
    this.status = options.status;
    this.isRateLimited = options.status === 429;
    this.attempts = options.attempts;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface RetryOptions {
  /** Total attempts including the first. 1 disables retrying. */
  attempts: number;
  /** Delay before the first retry; doubles each subsequent retry. */
  baseDelayMs: number;
  /** Ceiling on any single wait, including a server-supplied Retry-After. */
  maxDelayMs: number;
  /** Ceiling on time spent waiting across all retries. */
  totalBudgetMs: number;
  /** Per-request timeout, so a hung connection cannot consume the function. */
  timeoutMs: number;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  attempts: 3,
  baseDelayMs: 600,
  maxDelayMs: 4_000,
  totalBudgetMs: 8_000,
  timeoutMs: 8_000,
};

/**
 * Statuses worth a second look. 403 is excluded on purpose: from a datacenter IP
 * it usually means a standing block, and retrying only spends more of the
 * shared budget.
 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Parses Retry-After, which may be seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;

  const trimmed = header.trim();
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds;

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return undefined;
  return Math.max(0, Math.round((asDate - now) / 1000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter, so concurrent instances do not retry in lockstep. */
function jitter(delayMs: number): number {
  return Math.round(delayMs * (0.5 + Math.random() * 0.5));
}

/**
 * Performs the request, retrying only transient failures. Always throws
 * `UpstreamError` on failure so callers can distinguish rate limiting from
 * everything else.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: Partial<RetryOptions> = {},
): Promise<Response> {
  const config = { ...DEFAULT_RETRY_OPTIONS, ...options };
  const attempts = Math.max(1, config.attempts);

  let spentWaitingMs = 0;
  let lastError: UpstreamError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response | undefined;

    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (cause) {
      lastError = new UpstreamError(
        `Network error contacting the feed: ${(cause as Error).message}`,
        { attempts: attempt, cause },
      );
    }

    if (response) {
      if (response.ok) return response;

      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      lastError = new UpstreamError(`Reddit returned HTTP ${response.status}.`, {
        status: response.status,
        attempts: attempt,
        retryAfterSeconds,
      });

      // Release the connection; the body is not used on a failure.
      await response.body?.cancel().catch(() => {});

      if (!RETRYABLE_STATUSES.has(response.status)) throw lastError;
    }

    if (attempt === attempts) break;

    // Prefer the server's own guidance, but never block a request on it.
    const suggestedMs = lastError?.retryAfterSeconds !== undefined
      ? lastError.retryAfterSeconds * 1000
      : config.baseDelayMs * 2 ** (attempt - 1);

    const waitMs = Math.min(jitter(suggestedMs), config.maxDelayMs);
    if (waitMs <= 0 || spentWaitingMs + waitMs > config.totalBudgetMs) break;

    spentWaitingMs += waitMs;
    await sleep(waitMs);
  }

  throw lastError ?? new UpstreamError("Feed request failed.", { attempts });
}
