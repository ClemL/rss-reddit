import { DensityToggle } from "@/components/DensityToggle";
import { EmptyState } from "@/components/EmptyState";
import { PostCard } from "@/components/PostCard";
import { StaleNotice } from "@/components/StaleNotice";
import { TimeFilterSelect } from "@/components/TimeFilterSelect";
import {
  DEFAULT_TIME_FILTER,
  FEED_SOURCE,
  POST_COUNT,
  SUBREDDIT,
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

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.t) ? params.t[0] : params.t;
  const filter = parseTimeFilter(raw, DEFAULT_TIME_FILTER);

  const { snapshot, stale, error, rateLimited } = await getFeed(filter);
  const posts = snapshot?.posts ?? [];

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="page-header border-b border-neutral-200 dark:border-neutral-800">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              Top {POST_COUNT} ·{" "}
              <a
                href={sourceWebUrl(FEED_SOURCE, filter)}
                target="_blank"
                rel="noopener noreferrer"
                title={FEED_SOURCE.label}
                className="underline-offset-4 hover:underline"
              >
                {shortLabel(FEED_SOURCE)}
              </a>
            </h1>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              Ordered as Reddit&rsquo;s RSS feed returns them.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <TimeFilterSelect value={filter} />
            <DensityToggle />
          </div>
        </div>

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
        <EmptyState subreddit={SUBREDDIT} rateLimited={rateLimited} error={error} />
      )}

      <footer className="mt-10 border-t border-neutral-200 pt-5 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        <p>
          Source:{" "}
          <a
            href={sourceFeedUrl(FEED_SOURCE, filter)}
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
      </footer>
    </main>
  );
}
