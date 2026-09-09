import type { RedditPost } from "@/lib/atom";
import { absoluteTime, displayHost, relativeTime } from "@/lib/time";

/**
 * One post. The title links to the submission's `[link]` target — the external
 * article for link posts, the Reddit thread for self posts — while "Comments"
 * always links to the Reddit permalink.
 *
 * The Atom feed carries no score and no comment count, so neither is displayed;
 * `rank` reflects nothing more than the feed's own ordering.
 */
export function PostCard({ post, rank }: { post: RedditPost; rank: number }) {
  const host = post.isSelfPost ? null : displayHost(post.url);

  return (
    <li className="post-card group border-neutral-200 bg-white transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900/40 dark:hover:border-neutral-700">
      <span
        aria-hidden="true"
        className="post-rank pt-px text-sm text-neutral-300 dark:text-neutral-600"
      >
        {rank}
      </span>

      <div className="min-w-0 flex-1">
        <h2 className="post-title font-medium text-balance">
          <a
            href={post.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {post.title}
          </a>
          {host ? (
            <span className="ml-2 align-middle text-xs font-normal whitespace-nowrap text-neutral-400 dark:text-neutral-500">
              {host}
            </span>
          ) : null}
        </h2>

        {post.excerpt ? (
          <p className="post-excerpt text-neutral-600 dark:text-neutral-400">
            {post.excerpt}
          </p>
        ) : null}

        <div className="post-meta flex flex-wrap items-center gap-x-3 gap-y-1 text-neutral-500 dark:text-neutral-400">
          <span>
            by{" "}
            {post.authorUrl ? (
              <a
                href={post.authorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-neutral-800 hover:underline dark:hover:text-neutral-200"
              >
                {post.author}
              </a>
            ) : (
              post.author
            )}
          </span>

          <span aria-hidden="true">·</span>

          <time dateTime={post.publishedAt} title={absoluteTime(post.publishedAt)}>
            {relativeTime(post.publishedAt)}
          </time>

          <span aria-hidden="true">·</span>

          <a
            href={post.permalink}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-neutral-600 hover:text-neutral-900 hover:underline dark:text-neutral-300 dark:hover:text-white"
          >
            Comments
          </a>
        </div>
      </div>
    </li>
  );
}
