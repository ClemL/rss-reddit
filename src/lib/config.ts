import { parseFeedSourceOrDefault, type FeedSource } from "@/lib/source";

/**
 * Central configuration. Everything that a deployment might want to change
 * lives here so it is not scattered through the components.
 */

/** Time windows Reddit's `top` listing accepts via the `t` query parameter. */
export const TIME_FILTERS = ["hour", "day", "week", "month", "year", "all"] as const;

export type TimeFilter = (typeof TIME_FILTERS)[number];

export function isTimeFilter(value: unknown): value is TimeFilter {
  return typeof value === "string" && (TIME_FILTERS as readonly string[]).includes(value);
}

/**
 * Coerces arbitrary input (a query string, an env var) to a valid time filter,
 * falling back to the supplied default.
 */
export function parseTimeFilter(value: unknown, fallback: TimeFilter = DEFAULT_TIME_FILTER): TimeFilter {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  return isTimeFilter(normalized) ? normalized : fallback;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Where the feed comes from. Accepts a single subreddit, several combined with
 * `+`, or a public multireddit — see `src/lib/source.ts`.
 */
export const FEED_SOURCE: FeedSource = parseFeedSourceOrDefault(process.env.SUBREDDIT);

/** Convenience alias for the source's display label, e.g. `r/programming`. */
export const SUBREDDIT = FEED_SOURCE.label;

/** How many posts the page renders. */
export const POST_COUNT = positiveInt(process.env.POST_COUNT, 10);

/** Cache lifetime in seconds. Matches the cron cadence in vercel.json by default. */
export const REVALIDATE_SECONDS = positiveInt(process.env.REVALIDATE_SECONDS, 900);

/** Time filter used when the request does not specify one. */
export const DEFAULT_TIME_FILTER: TimeFilter = isTimeFilter(process.env.DEFAULT_TIME_FILTER?.trim().toLowerCase())
  ? (process.env.DEFAULT_TIME_FILTER!.trim().toLowerCase() as TimeFilter)
  : "day";

/**
 * Data older than this is surfaced with a "may be stale" badge even if the last
 * fetch did not visibly fail — it means the refresh cron has stopped landing.
 */
export const STALE_AFTER_SECONDS = REVALIDATE_SECONDS * 2;

/**
 * Retry budget for a page render. Kept to a single extra attempt so a cold cache
 * cannot stall the response; the render falls back to cached data instead.
 */
export const RENDER_FETCH_ATTEMPTS = positiveInt(process.env.RENDER_FETCH_ATTEMPTS, 2);

/**
 * Retry budget for the /api/refresh cron, which has far more headroom than a
 * page render and is where it is worth fighting for the data.
 */
export const REFRESH_FETCH_ATTEMPTS = positiveInt(process.env.REFRESH_FETCH_ATTEMPTS, 3);

/**
 * Pause between the cron's per-filter requests. Reddit budgets unauthenticated
 * requests per source IP, so spacing them out matters more than finishing fast.
 */
export const REFRESH_DELAY_MS = positiveInt(process.env.REFRESH_DELAY_MS, 1500);

/**
 * Reddit rejects some default client user agents outright. A descriptive one is
 * requested by Reddit's API rules and reduces the odds of a 429/403.
 */
export const USER_AGENT =
  process.env.REDDIT_USER_AGENT?.trim() ||
  "web:rss-reddit:1.0.0 (unauthenticated public RSS reader)";

/**
 * Origin the feed is read from. Overridable so the app can be pointed at a
 * local mock or a mirror in tests; production should leave it unset.
 */
export const REDDIT_BASE_URL = (process.env.REDDIT_BASE_URL?.trim() || "https://www.reddit.com").replace(
  /\/+$/,
  "",
);

/**
 * Feed URL for a source. The path is already validated against Reddit's naming
 * rules by `parseFeedSource`, so it is safe to interpolate directly — encoding
 * it here would break the `+` that combines subreddits.
 */
export function feedUrl(source: FeedSource, filter: TimeFilter): string {
  return `${REDDIT_BASE_URL}/${source.path}/top/.rss?t=${filter}`;
}

/** The same listing on Reddit itself, for "open on Reddit" links. */
export function sourceWebUrl(source: FeedSource, filter?: TimeFilter): string {
  const base = `https://www.reddit.com/${source.path}`;
  return filter ? `${base}/top/?t=${filter}` : `${base}/`;
}

/** Public RSS URL, shown in the footer so the data source is inspectable. */
export function sourceFeedUrl(source: FeedSource, filter: TimeFilter): string {
  return `https://www.reddit.com/${source.path}/top/.rss?t=${filter}`;
}
