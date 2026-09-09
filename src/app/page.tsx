import { DensityToggle } from "@/components/DensityToggle";
import { FeedUrlList } from "@/components/FeedUrlList";
import { TabBar } from "@/components/TabBar";
import { EmptyState } from "@/components/EmptyState";
import { PostCard } from "@/components/PostCard";
import { StaleNotice } from "@/components/StaleNotice";
import { TimeFilterSelect } from "@/components/TimeFilterSelect";
import {
  DEFAULT_TAB,
  DEFAULT_TIME_FILTER,
  FEED_TABS,
  HAS_MULTIPLE_TABS,
  POST_COUNT,
  parseTab,
  parseTimeFilter,
  sourceFeedUrl,
  sourceWebUrl,
} from "@/lib/config";
import { shortLabel } from "@/lib/source";
import { ageInSeconds, getFeed } from "@/lib/feed";
import { relativeTime } from "@/lib/time";

/**
 * The page is dynamic because the time filter arrives in the query string, but
 * it never talks to Reddit on a normal request: `getFeed` reads the cache that
 * the /api/refresh cron populates.
 */
export const dynamic = "force-dynamic";

/**
 * Ceiling on the whole render. Vercel's default for a serverless function is
 * 300 seconds, which is not a useful bound for a page: a stalled upstream would
 * hold the request open until the platform returns FUNCTION_INVOCATION_TIMEOUT
 * and the visitor sees a 504 instead of the page. `getFeed` gives up well
 * before this (`RENDER_BUDGET_MS`) and renders the cached copy or the empty
 * state, so reaching this limit should not be possible; it is the backstop.
 *
 * Route segment config must be statically analyzable, so this is a literal
 * rather than a value read from the environment.
 */
export const maxDuration = 30;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawFilter = Array.isArray(params.t) ? params.t[0] : params.t;
  const rawTab = Array.isArray(params.tab) ? params.tab[0] : params.tab;

  const filter = parseTimeFilter(rawFilter, DEFAULT_TIME_FILTER);
  const tab = parseTab(rawTab);
  const source = tab.source;

  const { snapshot, stale, error, rateLimited } = await getFeed(filter, source);
  const posts = snapshot?.posts ?? [];

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="page-header border-b border-neutral-200 dark:border-neutral-800">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              Top {POST_COUNT} ·{" "}
              <a
                href={sourceWebUrl(source, filter)}
                target="_blank"
                rel="noopener noreferrer"
                title={source.label}
                className="underline-offset-4 hover:underline"
              >
                {HAS_MULTIPLE_TABS ? tab.label : shortLabel(source)}
              </a>
            </h1>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              {HAS_MULTIPLE_TABS
                ? `${source.subreddits.length} subreddits, ordered as Reddit's RSS feed returns them.`
                : "Ordered as Reddit's RSS feed returns them."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <TimeFilterSelect value={filter} tab={tab.id} defaultTabId={DEFAULT_TAB.id} />
            <DensityToggle />
          </div>
        </div>

        {HAS_MULTIPLE_TABS ? (
          <TabBar
            tabs={FEED_TABS}
            activeId={tab.id}
            filter={filter}
            defaultFilter={DEFAULT_TIME_FILTER}
            defaultTabId={DEFAULT_TAB.id}
          />
        ) : null}

        {stale && snapshot ? (
          <StaleNotice age={relativeTime(snapshot.fetchedAt)} rateLimited={rateLimited} />
        ) : null}
      </header>

      {posts.length > 0 ? (
        <ol className="post-list">
          {posts.map((post, index) => (
            <PostCard key={post.id} post={post} rank={index + 1} />
          ))}
        </ol>
      ) : (
        <EmptyState source={source} rateLimited={rateLimited} error={error} />
      )}

      <footer className="mt-10 border-t border-neutral-200 pt-5 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        <p>
          Source:{" "}
          <a
            href={sourceFeedUrl(source, filter)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Reddit&rsquo;s public RSS feed
          </a>
          . The feed carries no scores or comment counts, so none are shown.
        </p>
        {snapshot ? (
          <p className="mt-1">
            Cached copy fetched {relativeTime(snapshot.fetchedAt)} (
            {ageInSeconds(snapshot.fetchedAt)}s old).
          </p>
        ) : null}

        {HAS_MULTIPLE_TABS ? <FeedUrlList tabs={FEED_TABS} filter={filter} /> : null}
      </footer>
    </main>
  );
}
