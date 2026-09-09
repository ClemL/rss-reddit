import "server-only";

import { revalidateTag } from "next/cache";

import { parseAtomFeed, type RedditPost } from "@/lib/atom";
import { kvEnabled, kvGetJson, kvSetJson } from "@/lib/kv";
import {
  POST_COUNT,
  REVALIDATE_SECONDS,
  STALE_AFTER_SECONDS,
  SUBREDDIT,
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
  /** Where the returned data came from, for diagnostics. */
  source: "kv" | "fetch-cache" | "memory" | "none";
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

function cacheKey(subreddit: string, filter: TimeFilter): string {
  return `feed:${subreddit}:${filter}`;
}

/** Each time filter is cached under its own key and its own revalidation tag. */
export function feedTag(subreddit: string, filter: TimeFilter): string {
  return `reddit-feed:${subreddit}:${filter}`;
}

export function ageInSeconds(fetchedAt: string, now: number = Date.now()): number {
  const timestamp = new Date(fetchedAt).getTime();
  if (Number.isNaN(timestamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((now - timestamp) / 1000));
}

function isExpired(snapshot: FeedSnapshot, now: number = Date.now()): boolean {
  return ageInSeconds(snapshot.fetchedAt, now) >= REVALIDATE_SECONDS;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
  subreddit: string,
  filter: TimeFilter,
  mode: "live" | "cached",
): Promise<FeedSnapshot> {
  const url = feedUrl(subreddit, filter);

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.8",
    },
    ...(mode === "live"
      ? { cache: "no-store" as const }
      : { next: { revalidate: REVALIDATE_SECONDS, tags: [feedTag(subreddit, filter)] } }),
  });

  if (!response.ok) {
    throw new Error(`Reddit returned HTTP ${response.status} for r/${subreddit} (t=${filter}).`);
  }

  const xml = await response.text();
  const posts = parseAtomFeed(xml, POST_COUNT);

  if (posts.length === 0) {
    throw new Error(`Feed for r/${subreddit} (t=${filter}) contained no entries.`);
  }

  // In "cached" mode the body may come from the fetch cache, in which case the
  // upstream `Date` header still reports when Reddit actually served it — which
  // is what the staleness indicator needs, unlike the current time.
  const servedAt = response.headers.get("date");
  const parsedServedAt = servedAt ? new Date(servedAt).getTime() : Number.NaN;
  const fetchedAt = Number.isNaN(parsedServedAt)
    ? new Date().toISOString()
    : new Date(parsedServedAt).toISOString();

  return { subreddit, filter, posts, fetchedAt };
}

async function readCachedSnapshot(
  subreddit: string,
  filter: TimeFilter,
): Promise<{ snapshot: FeedSnapshot; source: FeedResult["source"] } | null> {
  const key = cacheKey(subreddit, filter);

  if (kvEnabled) {
    try {
      const snapshot = await kvGetJson<FeedSnapshot>(key);
      if (snapshot?.posts?.length) return { snapshot, source: "kv" };
    } catch {
      // Fall through to the in-memory backstop below.
    }
  }

  const fromMemory = memoryCache.get(key);
  return fromMemory ? { snapshot: fromMemory, source: "memory" } : null;
}

async function writeSnapshot(snapshot: FeedSnapshot): Promise<void> {
  const key = cacheKey(snapshot.subreddit, snapshot.filter);
  memoryCache.set(key, snapshot);
  if (!kvEnabled) return;
  try {
    await kvSetJson(key, snapshot);
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
  subreddit: string = SUBREDDIT,
): Promise<FeedResult> {
  const cached = await readCachedSnapshot(subreddit, filter);

  if (kvEnabled) {
    if (cached && (!isExpired(cached.snapshot) || STRICT_CACHE_ONLY)) {
      return {
        snapshot: cached.snapshot,
        stale: ageInSeconds(cached.snapshot.fetchedAt) >= STALE_AFTER_SECONDS,
        error: null,
        source: cached.source,
      };
    }

    // Cache is empty or past its lifetime and the cron has not caught up.
    try {
      const snapshot = await fetchSnapshot(subreddit, filter, "live");
      await writeSnapshot(snapshot);
      return { snapshot, stale: false, error: null, source: "kv" };
    } catch (error) {
      return cached
        ? { snapshot: cached.snapshot, stale: true, error: describe(error), source: cached.source }
        : { snapshot: null, stale: true, error: describe(error), source: "none" };
    }
  }

  // No KV store: Next.js's fetch cache holds the response for REVALIDATE_SECONDS,
  // so this call is a cache read on all but the first request of each interval.
  try {
    const snapshot = await fetchSnapshot(subreddit, filter, "cached");
    await writeSnapshot(snapshot);
    return {
      snapshot,
      stale: ageInSeconds(snapshot.fetchedAt) >= STALE_AFTER_SECONDS,
      error: null,
      source: "fetch-cache",
    };
  } catch (error) {
    return cached
      ? { snapshot: cached.snapshot, stale: true, error: describe(error), source: cached.source }
      : { snapshot: null, stale: true, error: describe(error), source: "none" };
  }
}

/**
 * Forces a refresh of one time filter. Used by the cron route handler.
 * Throws on failure so the caller can report per-filter status.
 */
export async function refreshFeed(
  filter: TimeFilter,
  subreddit: string = SUBREDDIT,
): Promise<FeedSnapshot> {
  if (kvEnabled) {
    const snapshot = await fetchSnapshot(subreddit, filter, "live");
    await writeSnapshot(snapshot);
    return snapshot;
  }

  // Drop the tagged entry, then immediately re-populate it so the next visitor
  // is served from a warm fetch cache instead of triggering the refetch.
  // `{ expire: 0 }` expires the tag now rather than after a cacheLife profile.
  revalidateTag(feedTag(subreddit, filter), { expire: 0 });
  const snapshot = await fetchSnapshot(subreddit, filter, "cached");
  await writeSnapshot(snapshot);
  return snapshot;
}
