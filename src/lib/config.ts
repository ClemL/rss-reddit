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

/** Subreddit to read. Overridable so the build is not hardcoded to r/programming. */
export const SUBREDDIT = process.env.SUBREDDIT?.trim().replace(/^\/?r\//, "") || "programming";

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

export function feedUrl(subreddit: string, filter: TimeFilter): string {
  return `${REDDIT_BASE_URL}/r/${encodeURIComponent(subreddit)}/top/.rss?t=${filter}`;
}

export function subredditUrl(subreddit: string): string {
  return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/`;
}
