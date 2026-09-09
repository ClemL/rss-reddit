import { afterEach, describe, expect, it, vi } from "vitest";

import { UpstreamError, budgetFor, fetchOnce, fetchWithRetry, parseRetryAfter } from "@/lib/http";

const FAST = { baseDelayMs: 1, maxDelayMs: 5, totalBudgetMs: 100, timeoutMs: 1000 };

function responses(...specs: (number | "network")[]): typeof fetch {
  let call = 0;
  return vi.fn(async () => {
    const spec = specs[Math.min(call, specs.length - 1)];
    call += 1;
    if (spec === "network") throw new TypeError("fetch failed");
    return new Response(spec === 200 ? "<feed/>" : "", { status: spec });
  }) as unknown as typeof fetch;
}

/**
 * Models the one behavior a plain `vi.fn()` stub does not: a real `fetch`
 * rejects when its signal aborts. Without that, a request that is never
 * answered hangs forever — which is exactly the production failure these tests
 * cover, so the stub has to reproduce it.
 */
function hangingFetch(): typeof fetch {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
  ) as unknown as typeof fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("parseRetryAfter", () => {
  it("reads a delay in seconds", () => {
    expect(parseRetryAfter("120")).toBe(120);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90);
  });

  it("never returns a negative delay for a past date", () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    expect(parseRetryAfter(new Date(now - 60_000).toUTCString(), now)).toBe(0);
  });

  it("ignores a missing or unparseable header", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("fetchWithRetry", () => {
  it("returns the first successful response without retrying", async () => {
    const stub = responses(200);
    vi.stubGlobal("fetch", stub);
    const response = await fetchWithRetry("https://example.test/feed", {}, { attempts: 3, ...FAST });
    expect(response.status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("recovers from a transient 429", async () => {
    const stub = responses(429, 429, 200);
    vi.stubGlobal("fetch", stub);
    const response = await fetchWithRetry("https://example.test/feed", {}, { attempts: 3, ...FAST });
    expect(response.status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(3);
  });

  it("recovers from a transient network error", async () => {
    const stub = responses("network", 200);
    vi.stubGlobal("fetch", stub);
    const response = await fetchWithRetry("https://example.test/feed", {}, { attempts: 3, ...FAST });
    expect(response.status).toBe(200);
  });

  it("gives up after the attempt budget and flags rate limiting", async () => {
    const stub = responses(429);
    vi.stubGlobal("fetch", stub);
    const error = await fetchWithRetry("https://example.test/feed", {}, { attempts: 3, ...FAST })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UpstreamError);
    const upstream = error as UpstreamError;
    expect(upstream.status).toBe(429);
    expect(upstream.isRateLimited).toBe(true);
    expect(upstream.attempts).toBe(3);
    expect(stub).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 403, which signals a standing block", async () => {
    const stub = responses(403);
    vi.stubGlobal("fetch", stub);
    const error = await fetchWithRetry("https://example.test/feed", {}, { attempts: 5, ...FAST })
      .catch((caught: unknown) => caught);

    expect((error as UpstreamError).status).toBe(403);
    expect((error as UpstreamError).isRateLimited).toBe(false);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 404", async () => {
    const stub = responses(404);
    vi.stubGlobal("fetch", stub);
    await expect(
      fetchWithRetry("https://example.test/feed", {}, { attempts: 5, ...FAST }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one request when retries are disabled", async () => {
    const stub = responses(429);
    vi.stubGlobal("fetch", stub);
    await expect(
      fetchWithRetry("https://example.test/feed", {}, { attempts: 1, ...FAST }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("stops retrying rather than honoring an unreasonably long Retry-After", async () => {
    const stub = vi.fn(async () =>
      new Response("", { status: 429, headers: { "retry-after": "3600" } }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", stub);

    const started = Date.now();
    await expect(
      fetchWithRetry("https://example.test/feed", {}, { attempts: 3, ...FAST }),
    ).rejects.toBeInstanceOf(UpstreamError);

    // The hour-long hint is capped by maxDelayMs, so this must not actually wait.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stub).toHaveBeenCalledTimes(3);
  });

  it("keeps total waiting inside the budget", async () => {
    const stub = responses(503);
    vi.stubGlobal("fetch", stub);
    const started = Date.now();
    await expect(
      fetchWithRetry("https://example.test/feed", {}, {
        attempts: 6,
        baseDelayMs: 40,
        maxDelayMs: 100,
        totalBudgetMs: 120,
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(Date.now() - started).toBeLessThan(600);
  });
});

describe("budgetFor", () => {
  it("uses the full timeout when there is no deadline", () => {
    expect(budgetFor(8_000)).toBe(8_000);
  });

  it("clamps to the time left before the deadline", () => {
    const now = 1_000_000;
    expect(budgetFor(8_000, now + 1_500, now)).toBe(1_500);
  });

  it("goes non-positive once the deadline has passed", () => {
    const now = 1_000_000;
    expect(budgetFor(8_000, now - 1, now)).toBeLessThanOrEqual(0);
  });
});

describe("fetchOnce", () => {
  it("aborts a request the upstream never answers", async () => {
    vi.stubGlobal("fetch", hangingFetch());

    const started = Date.now();
    const error = await fetchOnce("https://example.test/feed", {}, 80)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).isTimeout).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("refuses to start a request with no time left", async () => {
    const stub = hangingFetch();
    vi.stubGlobal("fetch", stub);

    const error = await fetchOnce("https://example.test/feed", {}, 0)
      .catch((caught: unknown) => caught);

    expect((error as UpstreamError).isTimeout).toBe(true);
    expect(stub).not.toHaveBeenCalled();
  });

  it("passes an abort signal even when the caller supplied none", async () => {
    const stub = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("<feed/>", { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", stub);

    await expect(fetchOnce("https://example.test/feed", {}, 1_000)).resolves.toBeInstanceOf(Response);
  });
});

describe("fetchWithRetry deadlines", () => {
  it("returns by the deadline rather than per-attempt timeouts", async () => {
    vi.stubGlobal("fetch", hangingFetch());

    const started = Date.now();
    const error = await fetchWithRetry("https://example.test/feed", {}, {
      attempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      totalBudgetMs: 100,
      // Ten seconds per attempt, but only 150ms of deadline: the deadline wins.
      timeoutMs: 10_000,
      deadline: Date.now() + 150,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).isTimeout).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("makes no request at all once the deadline has passed", async () => {
    const stub = responses(200);
    vi.stubGlobal("fetch", stub);

    await expect(
      fetchWithRetry("https://example.test/feed", {}, {
        attempts: 3,
        ...FAST,
        deadline: Date.now() - 1,
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(stub).not.toHaveBeenCalled();
  });

  it("still retries a transient failure when the deadline allows it", async () => {
    const stub = responses(503, 200);
    vi.stubGlobal("fetch", stub);

    const response = await fetchWithRetry("https://example.test/feed", {}, {
      attempts: 3,
      ...FAST,
      deadline: Date.now() + 5_000,
    });

    expect(response.status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(2);
  });
});
