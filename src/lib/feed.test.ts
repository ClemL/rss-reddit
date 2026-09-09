import { afterEach, describe, expect, it, vi } from "vitest";

import { parseFeedSource } from "@/lib/source";

/**
 * Regression coverage for the failure that took the deployed app down: an
 * upstream that accepts a connection and never answers it. `fetch` has no
 * default timeout, so an unguarded read here ran until Vercel killed the
 * function at 300 seconds and returned FUNCTION_INVOCATION_TIMEOUT instead of
 * the page. `getFeed` must always come back inside its deadline, with the empty
 * state rather than an exception.
 *
 * These load `@/lib/feed` dynamically because `kvEnabled` is decided from the
 * environment at import time, and the two cache strategies need testing
 * separately.
 */

const SOURCE = parseFeedSource("programming");

/**
 * A `fetch` that never answers but does honor its abort signal — the behavior a
 * bare `vi.fn()` stub omits, and the only reason the timeout is observable.
 */
function hangingFetch(): typeof fetch {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
  ) as unknown as typeof fetch;
}

async function loadFeedModule() {
  vi.resetModules();
  return import("@/lib/feed");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("getFeed under a deadline", () => {
  it("returns the empty state instead of hanging when Reddit never answers", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const { getFeed } = await loadFeedModule();

    const started = Date.now();
    const result = await getFeed("day", SOURCE, { deadline: Date.now() + 700 });

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.snapshot).toBeNull();
    expect(result.stale).toBe(true);
    expect(result.source).toBe("none");
    expect(result.error).toMatch(/timed out|Ran out of time/i);
  });

  it("does not contact Reddit at all when the deadline has already passed", async () => {
    const stub = hangingFetch();
    vi.stubGlobal("fetch", stub);
    const { getFeed } = await loadFeedModule();

    const result = await getFeed("day", SOURCE, { deadline: Date.now() - 1 });

    expect(stub).not.toHaveBeenCalled();
    expect(result.snapshot).toBeNull();
    expect(result.error).toMatch(/Ran out of time/i);
  });

  it("survives a KV store that never answers, without spending the whole budget", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://kv.example.test");
    vi.stubEnv("KV_REST_API_TOKEN", "token");
    vi.stubGlobal("fetch", hangingFetch());
    const { getFeed } = await loadFeedModule();

    const started = Date.now();
    const result = await getFeed("day", SOURCE, { deadline: Date.now() + 700 });

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.snapshot).toBeNull();
    expect(result.source).toBe("none");
  });

  it("serves a fetched snapshot and reports it as fresh", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>t3_abc123</id>
          <title>A post</title>
          <link href="https://www.reddit.com/r/programming/comments/abc123/a_post/" />
          <author><name>/u/example</name></author>
          <published>2026-09-09T10:00:00+00:00</published>
        </entry>
      </feed>`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(xml, {
          status: 200,
          headers: { date: new Date().toUTCString() },
        }),
      ) as unknown as typeof fetch,
    );
    const { getFeed } = await loadFeedModule();

    const result = await getFeed("day", SOURCE, { deadline: Date.now() + 5_000 });

    expect(result.error).toBeNull();
    expect(result.stale).toBe(false);
    expect(result.snapshot?.posts).toHaveLength(1);
    expect(result.snapshot?.posts[0]?.title).toBe("A post");
  });

  it("falls back to the last good snapshot when a later fetch stops answering", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>t3_abc123</id>
          <title>Cached post</title>
          <link href="https://www.reddit.com/r/programming/comments/abc123/cached/" />
          <author><name>/u/example</name></author>
          <published>2026-09-09T10:00:00+00:00</published>
        </entry>
      </feed>`;

    // The module keeps its in-memory backstop across calls, so one successful
    // fetch is what a later failing render falls back to.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(xml, { status: 200, headers: { date: new Date().toUTCString() } }),
      ) as unknown as typeof fetch,
    );
    const { getFeed } = await loadFeedModule();
    await getFeed("day", SOURCE, { deadline: Date.now() + 5_000 });

    vi.stubGlobal("fetch", hangingFetch());
    const result = await getFeed("day", SOURCE, { deadline: Date.now() + 700 });

    expect(result.snapshot?.posts[0]?.title).toBe("Cached post");
    expect(result.stale).toBe(true);
    expect(result.source).toBe("memory");
    expect(result.error).toMatch(/timed out/i);
  });
});
