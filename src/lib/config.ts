import { type FeedSource } from "@/lib/source";
import { findTab, resolveTabs, type FeedTab } from "@/lib/tabs";

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
 * Tabs to offer. `FEED_TABS` overrides them; a lone `SUBREDDIT` collapses to a
 * single tab — see `src/lib/tabs.ts`.
 */
export const FEED_TABS: FeedTab[] = resolveTabs({
  FEED_TABS: process.env.FEED_TABS,
  SUBREDDIT: process.env.SUBREDDIT,
});

/** True when there is nothing to switch between, so the tab bar is pointless. */
export const HAS_MULTIPLE_TABS = FEED_TABS.length > 1;

/** Tab used when the request does not name one. */
export const DEFAULT_TAB: FeedTab = FEED_TABS[0];

/** Source of the default tab, used where a single source is still assumed. */
export const FEED_SOURCE: FeedSource = DEFAULT_TAB.source;

/** Convenience alias for the default source's label. */
export const SUBREDDIT = FEED_SOURCE.label;

export function parseTab(value: unknown): FeedTab {
  return findTab(FEED_TABS, value);
}

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
 * Hard ceiling on a single upstream request, aborted rather than left hanging.
 * `fetch` has no default timeout, so without this a connection Reddit accepts
 * and never answers runs until the platform kills the whole function.
 */
export const UPSTREAM_TIMEOUT_MS = positiveInt(process.env.UPSTREAM_TIMEOUT_MS, 8_000);

/**
 * Total time a page render may spend on I/O before it stops trying and renders
 * whatever it already has. Must stay comfortably below the `maxDuration`
 * exported by the page so the response is produced by the app, not by the
 * platform's timeout.
 */
export const RENDER_BUDGET_MS = positiveInt(process.env.RENDER_BUDGET_MS, 9_000);

/**
 * Total time the /api/refresh cron may spend before it stops and reports what
 * it managed. Kept below that route's `maxDuration` for the same reason.
 */
export const REFRESH_BUDGET_MS = positiveInt(process.env.REFRESH_BUDGET_MS, 45_000);

/**
 * Hard ceiling on a single KV request. The KV store is the fast path, so an
 * unresponsive one must be abandoned quickly rather than delaying the render it
 * exists to accelerate.
 */
export const KV_TIMEOUT_MS = positiveInt(process.env.KV_TIMEOUT_MS, 2_000);

/**
 * Below this much remaining budget an upstream request is not worth starting:
 * it would abort mid-flight, having spent the time without producing data.
 */
export const MIN_FETCH_BUDGET_MS = positiveInt(process.env.MIN_FETCH_BUDGET_MS, 400);

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
