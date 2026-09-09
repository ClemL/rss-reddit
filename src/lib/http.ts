/**
 * Fetch with a hard per-request timeout and bounded retries for a flaky,
 * rate-limited upstream.
 *
 * Two failure modes matter here and they need different handling:
 *
 * - Reddit's unauthenticated endpoints budget requests per source IP. On a
 *   serverless host that IP is shared with every other tenant on the same egress
 *   pool, so a 429 frequently reflects other people's traffic rather than ours
 *   and can clear within seconds. A small number of spaced retries recovers from
 *   that case; a standing block is not something retrying can fix, so the budget
 *   here is deliberately tight.
 *
 * - A connection that is accepted and then never answered. `fetch` has no
 *   default timeout, so an unguarded call waits indefinitely and the serverless
 *   function is killed by the platform instead of rendering anything. Every
 *   request therefore carries an `AbortSignal.timeout`, and callers may impose
 *   an absolute `deadline` that clamps the timeout of each remaining attempt.
 */

/** Failure talking to the upstream feed, carrying enough detail to explain it. */
export class UpstreamError extends Error {
  readonly status?: number;
  readonly isRateLimited: boolean;
  /** True when the request was aborted for taking too long rather than failing. */
  readonly isTimeout: boolean;
  readonly attempts: number;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: {
      status?: number;
      attempts: number;
      retryAfterSeconds?: number;
      timeout?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "UpstreamError";
    this.status = options.status;
    this.isRateLimited = options.status === 429;
    this.isTimeout = options.timeout === true;
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
  /**
   * Absolute epoch milliseconds by which the caller needs an answer. No attempt
   * starts after it, and every attempt's timeout is clamped to what is left, so
   * the whole call returns by the deadline rather than overshooting it by a
   * timeout's worth on the final attempt.
   */
  deadline?: number;
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

/** Both an `AbortSignal.timeout` firing and an explicit abort land here. */
function isAbort(error: unknown): boolean {
  const name = (error as { name?: string } | null | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Milliseconds a request started now may run for: the configured timeout, or
 * whatever is left before the deadline if that is sooner.
 */
export function budgetFor(timeoutMs: number, deadline?: number, now: number = Date.now()): number {
  return deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - now);
}

/**
 * One request with a hard timeout, with every failure normalized to
 * `UpstreamError`. Used directly where the caller supplies its own caching (the
 * Next.js fetch cache), and as the single attempt inside `fetchWithRetry`.
 */
export async function fetchOnce(
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_RETRY_OPTIONS.timeoutMs,
  attempt: number = 1,
): Promise<Response> {
  if (!(timeoutMs > 0)) {
    throw new UpstreamError("Ran out of time before the feed could be contacted.", {
      attempts: attempt,
      timeout: true,
    });
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    if (isAbort(cause)) {
      throw new UpstreamError(`Feed request timed out after ${timeoutMs}ms.`, {
        attempts: attempt,
        timeout: true,
        cause,
      });
    }
    throw new UpstreamError(`Network error contacting the feed: ${(cause as Error).message}`, {
      attempts: attempt,
      cause,
    });
  }

  if (!response.ok) {
    // Release the connection; the body is not used on a failure.
    await response.body?.cancel().catch(() => {});
    throw new UpstreamError(`Reddit returned HTTP ${response.status}.`, {
      status: response.status,
      attempts: attempt,
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
    });
  }

  return response;
}

/**
 * Reads a response body, normalizing failures the same way `fetchOnce` does.
 * The request's timeout also governs the body stream, so a response whose
 * headers arrive promptly and whose body then stalls surfaces here as a timeout.
 */
export async function readBody(response: Response, attempts: number = 1): Promise<string> {
  try {
    return await response.text();
  } catch (cause) {
    if (isAbort(cause)) {
      throw new UpstreamError("Feed response body timed out before it finished.", {
        attempts,
        timeout: true,
        cause,
      });
    }
    throw new UpstreamError(`Network error reading the feed: ${(cause as Error).message}`, {
      attempts,
      cause,
    });
  }
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
    try {
      return await fetchOnce(url, init, budgetFor(config.timeoutMs, config.deadline), attempt);
    } catch (error) {
      lastError = error as UpstreamError;
      // A refusal that will not change on a retry ends the call immediately.
      if (lastError.status !== undefined && !RETRYABLE_STATUSES.has(lastError.status)) throw lastError;
      // Out of time is out of time; further attempts would only repeat this.
      if (lastError.isTimeout && budgetFor(config.timeoutMs, config.deadline) <= 0) throw lastError;
    }

    if (attempt === attempts) break;

    // Prefer the server's own guidance, but never block a request on it.
    const suggestedMs = lastError?.retryAfterSeconds !== undefined
      ? lastError.retryAfterSeconds * 1000
      : config.baseDelayMs * 2 ** (attempt - 1);

    const waitMs = Math.min(jitter(suggestedMs), config.maxDelayMs);
    if (waitMs <= 0 || spentWaitingMs + waitMs > config.totalBudgetMs) break;
    // Waiting only to find the deadline passed wastes the caller's remaining time.
    if (config.deadline !== undefined && Date.now() + waitMs >= config.deadline) break;

    spentWaitingMs += waitMs;
    await sleep(waitMs);
  }

  throw lastError ?? new UpstreamError("Feed request failed.", { attempts });
}
