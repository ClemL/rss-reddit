import "server-only";

import { revalidateTag } from "next/cache";

import { parseAtomFeed, type RedditPost } from "@/lib/atom";
import { UpstreamError, budgetFor, fetchOnce, fetchWithRetry, readBody } from "@/lib/http";
import { kvEnabled, kvGetJson, kvSetJson } from "@/lib/kv";
import type { FeedSource } from "@/lib/source";
import {
  FEED_SOURCE,
  KV_TIMEOUT_MS,
  MIN_FETCH_BUDGET_MS,
  POST_COUNT,
  REFRESH_BUDGET_MS,
  REFRESH_FETCH_ATTEMPTS,
  RENDER_BUDGET_MS,
  RENDER_FETCH_ATTEMPTS,
  REVALIDATE_SECONDS,
  STALE_AFTER_SECONDS,
  UPSTREAM_TIMEOUT_MS,
  USER_AGENT,
  feedUrl,
  type TimeFilter,
} from "@/lib/config";

/** A parsed feed plus the moment it was actually retrieved from Reddit. */
export interface FeedSnapshot {
  subreddit: string;
  filter: TimeFilter;
  posts: RedditPost[];
  /** ISO timestamp of the upstream fetch, not of this render. */
  fetchedAt: string;
}

export interface FeedResult {
  snapshot: FeedSnapshot | null;
  /** True when the newest data on hand is older than it should be. */
  stale: boolean;
  /** Human-readable reason the data is stale, or null. */
  error: string | null;
  /** True when the failure was Reddit rate limiting us (HTTP 429). */
  rateLimited: boolean;
  /** Where the returned data came from, for diagnostics. */
  source: "kv" | "fetch-cache" | "memory" | "none";
}

/**
 * Time bounds for one call. Every caller runs inside a serverless function with
 * a wall-clock limit, so the work is given an absolute deadline rather than a
 * per-step timeout: whatever remains is what the next step may spend, and once
 * it is gone the call returns what it has instead of being killed by the
 * platform mid-render.
 */
export interface FeedOptions {
  /** Absolute epoch milliseconds by which the caller needs an answer. */
  deadline?: number;
}

/**
 * When true, page renders never contact Reddit — only the cron route does.
 * Off by default so a deployment without a working cron still self-heals.
 */
const STRICT_CACHE_ONLY = process.env.STRICT_CACHE_ONLY === "1";

/**
 * Per-instance last-known-good copy. Serverless instances are ephemeral, so
 * this is a best-effort backstop for the no-KV deployment, not durable storage.
 */
const memoryCache = new Map<string, FeedSnapshot>();

/** Milliseconds left before the deadline; never negative. */
function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function cacheKey(source: FeedSource, filter: TimeFilter): string {
  return `feed:${source.key}:${filter}`;
}

/** Each time filter is cached under its own key and its own revalidation tag. */
export function feedTag(source: FeedSource, filter: TimeFilter): string {
  return `reddit-feed:${source.key}:${filter}`;
}

export function ageInSeconds(fetchedAt: string, now: number = Date.now()): number {
  const timestamp = new Date(fetchedAt).getTime();
  if (Number.isNaN(timestamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((now - timestamp) / 1000));
}

function isExpired(snapshot: FeedSnapshot, now: number = Date.now()): boolean {
  return ageInSeconds(snapshot.fetchedAt, now) >= REVALIDATE_SECONDS;
}

function describe(error: unknown, source: FeedSource, filter: TimeFilter): string {
  const context = `${source.label} (t=${filter})`;
  if (error instanceof UpstreamError) {
    const tries = error.attempts > 1 ? ` after ${error.attempts} attempts` : "";
    return `${error.message.replace(/\.$/, "")} for ${context}${tries}.`;
  }
  if (error instanceof Error) return `${error.message} (${context})`;
  return `${String(error)} (${context})`;
}

function isRateLimited(error: unknown): boolean {
  return error instanceof UpstreamError && error.isRateLimited;
}

/**
 * Retrieves and parses the feed.
 *
 * `mode` picks the caching strategy for the HTTP call itself:
 * - `"live"` bypasses every cache (used when KV holds the cached copy, and by
 *   the refresh route).
 * - `"cached"` uses Next.js's fetch cache with `revalidate` + a per-filter tag,
 *   which is the fallback caching layer when no KV store is configured.
 */
async function fetchSnapshot(
  source: FeedSource,
  filter: TimeFilter,
  mode: "live" | "cached",
  deadline: number,
  attempts: number = 1,
): Promise<FeedSnapshot> {
  const url = feedUrl(source, filter);

  const init: RequestInit = {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.8",
    },
    ...(mode === "live"
      ? { cache: "no-store" as const }
      : { next: { revalidate: REVALIDATE_SECONDS, tags: [feedTag(source, filter)] } }),
  };

  // Retrying a request that Next.js is caching would just re-read the same
  // cached entry, so only the uncached "live" mode retries. Either way the
  // request is bounded by the smaller of the per-request timeout and the time
  // left on the deadline.
  //
  // Next.js keeps caching a fetch that carries an `AbortSignal`, and drops the
  // signal when it revalidates the entry in the background, so timing out the
  // foreground request does not cost the cache.
  const response = mode === "live"
    ? await fetchWithRetry(url, init, { attempts, timeoutMs: UPSTREAM_TIMEOUT_MS, deadline })
    : await fetchOnce(url, init, budgetFor(UPSTREAM_TIMEOUT_MS, deadline));

  const xml = await readBody(response, attempts);
  const posts = parseAtomFeed(xml, POST_COUNT);

  if (posts.length === 0) {
    throw new Error(`Feed for ${source.label} (t=${filter}) contained no entries.`);
  }

  // In "cached" mode the body may come from the fetch cache, in which case the
  // upstream `Date` header still reports when Reddit actually served it — which
  // is what the staleness indicator needs, unlike the current time.
  const servedAt = response.headers.get("date");
  const parsedServedAt = servedAt ? new Date(servedAt).getTime() : Number.NaN;
  const fetchedAt = Number.isNaN(parsedServedAt)
    ? new Date().toISOString()
    : new Date(parsedServedAt).toISOString();

  return { subreddit: source.label, filter, posts, fetchedAt };
}

async function readCachedSnapshot(
  source: FeedSource,
  filter: TimeFilter,
  deadline: number,
): Promise<{ snapshot: FeedSnapshot; source: FeedResult["source"] } | null> {
  const key = cacheKey(source, filter);

  if (kvEnabled) {
    try {
      const snapshot = await kvGetJson<FeedSnapshot>(
        key,
        Math.min(KV_TIMEOUT_MS, remainingMs(deadline)),
      );
      if (snapshot?.posts?.length) return { snapshot, source: "kv" };
    } catch {
      // A slow or broken KV store must not decide the whole request: fall
      // through to the in-memory backstop and, failing that, to Reddit.
    }
  }

  const fromMemory = memoryCache.get(key);
  return fromMemory ? { snapshot: fromMemory, source: "memory" } : null;
}

async function writeSnapshot(
  source: FeedSource,
  snapshot: FeedSnapshot,
  deadline: number,
): Promise<void> {
  const key = cacheKey(source, snapshot.filter);
  memoryCache.set(key, snapshot);
  if (!kvEnabled) return;
  try {
    // The data is already in hand, so this write is worth a short grace period
    // past the deadline rather than being skipped and re-fetched next request —
    // but never more than a KV request is allowed anywhere else.
    const writeTimeoutMs = Math.min(
      KV_TIMEOUT_MS,
      Math.max(KV_TIMEOUT_MS / 2, remainingMs(deadline)),
    );
    await kvSetJson(key, snapshot, writeTimeoutMs);
  } catch {
    // A cache write failure must not fail the request that produced the data.
  }
}

/**
 * Data source for the page. Reads the cache first and only contacts Reddit when
 * the cache has nothing usable, so ordinary visitor traffic never reaches
 * Reddit. If a refresh is attempted and fails, the previous snapshot is
 * returned with `stale: true` rather than surfacing an error to the visitor.
 */
export async function getFeed(
  filter: TimeFilter,
  source: FeedSource = FEED_SOURCE,
  options: FeedOptions = {},
): Promise<FeedResult> {
  // Defaulted here rather than at the call site so a caller that forgets still
  // gets a bounded render: this function is what stands between a stalled
  // Reddit connection and the platform's function timeout.
  const deadline = options.deadline ?? Date.now() + RENDER_BUDGET_MS;

  const cached = await readCachedSnapshot(source, filter, deadline);

  const serveCached = (
    hit: NonNullable<typeof cached>,
    error: unknown = null,
  ): FeedResult => ({
    snapshot: hit.snapshot,
    stale: error !== null || ageInSeconds(hit.snapshot.fetchedAt) >= STALE_AFTER_SECONDS,
    error: error === null ? null : describe(error, source, filter),
    rateLimited: isRateLimited(error),
    source: hit.source,
  });

  const outOfTime = (): UpstreamError =>
    new UpstreamError("Ran out of time before Reddit answered.", { attempts: 1, timeout: true });

  /** Too little left to finish a request, so spending it would help nobody. */
  const exhausted = (): boolean => remainingMs(deadline) < MIN_FETCH_BUDGET_MS;

  const giveUp = (error: unknown): FeedResult =>
    cached
      ? serveCached(cached, error)
      : {
          snapshot: null,
          stale: true,
          error: describe(error, source, filter),
          rateLimited: isRateLimited(error),
          source: "none",
        };

  if (kvEnabled) {
    if (cached && (!isExpired(cached.snapshot) || STRICT_CACHE_ONLY)) {
      return serveCached(cached);
    }

    if (exhausted()) return giveUp(outOfTime());

    // Cache is empty or past its lifetime and the cron has not caught up.
    try {
      const snapshot = await fetchSnapshot(source, filter, "live", deadline, RENDER_FETCH_ATTEMPTS);
      await writeSnapshot(source, snapshot, deadline);
      return { snapshot, stale: false, error: null, rateLimited: false, source: "kv" };
    } catch (error) {
      return giveUp(error);
    }
  }

  if (exhausted()) return giveUp(outOfTime());

  // No KV store: Next.js's fetch cache holds the response for REVALIDATE_SECONDS,
  // so this call is a cache read on all but the first request of each interval.
  try {
    const snapshot = await fetchSnapshot(source, filter, "cached", deadline);
    await writeSnapshot(source, snapshot, deadline);
    return {
      snapshot,
      stale: ageInSeconds(snapshot.fetchedAt) >= STALE_AFTER_SECONDS,
      error: null,
      rateLimited: false,
      source: "fetch-cache",
    };
  } catch (cachedError) {
    if (cached) return serveCached(cached, cachedError);
    if (exhausted()) return giveUp(cachedError);

    // Nothing cached anywhere: this is a cold start, and the single cached
    // attempt above cannot retry. Fall back to an uncached, retrying fetch so a
    // transient rate limit does not leave the page permanently empty. It shares
    // the same deadline, so this second try cannot double the render's cost.
    try {
      const snapshot = await fetchSnapshot(source, filter, "live", deadline, RENDER_FETCH_ATTEMPTS);
      await writeSnapshot(source, snapshot, deadline);
      return { snapshot, stale: false, error: null, rateLimited: false, source: "memory" };
    } catch (liveError) {
      return giveUp(liveError);
    }
  }
}

/**
 * Forces a refresh of one time filter. Used by the cron route handler.
 * Throws on failure so the caller can report per-filter status.
 */
export async function refreshFeed(
  filter: TimeFilter,
  source: FeedSource = FEED_SOURCE,
  options: FeedOptions = {},
): Promise<FeedSnapshot> {
  const deadline = options.deadline ?? Date.now() + REFRESH_BUDGET_MS;

  if (kvEnabled) {
    const snapshot = await fetchSnapshot(source, filter, "live", deadline, REFRESH_FETCH_ATTEMPTS);
    await writeSnapshot(source, snapshot, deadline);
    return snapshot;
  }

  // Drop the tagged entry, then immediately re-populate it so the next visitor
  // is served from a warm fetch cache instead of triggering the refetch.
  // `{ expire: 0 }` expires the tag now rather than after a cacheLife profile.
  revalidateTag(feedTag(source, filter), { expire: 0 });

  try {
    const snapshot = await fetchSnapshot(source, filter, "cached", deadline);
    await writeSnapshot(source, snapshot, deadline);
    return snapshot;
  } catch (error) {
    // The tag is already expired, so the next page render will try again. Spend
    // one retrying uncached fetch to refresh the in-memory last-known-good copy,
    // which is what keeps the page populated until then — but only if the run
    // still has time for it, since both fetches share the one deadline.
    if (!(error instanceof UpstreamError)) throw error;
    if (remainingMs(deadline) < MIN_FETCH_BUDGET_MS) throw error;
    const snapshot = await fetchSnapshot(source, filter, "live", deadline, REFRESH_FETCH_ATTEMPTS);
    await writeSnapshot(source, snapshot, deadline);
    return snapshot;
  }
}
