import { afterEach, describe, expect, it, vi } from "vitest";

import { UpstreamError, fetchWithRetry, parseRetryAfter } from "@/lib/http";

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
