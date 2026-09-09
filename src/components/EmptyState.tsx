import { sourceWebUrl } from "@/lib/config";
import type { FeedSource } from "@/lib/source";

/**
 * Shown only when the cache is completely cold *and* the feed could not be
 * reached — the one case with nothing truthful to render.
 *
 * It deliberately shows no posts rather than placeholder or bundled sample
 * content: fabricated entries presented as live Reddit data would be worse than
 * an honest empty page.
 */
export function EmptyState({
  source,
  rateLimited,
  error,
}: {
  source: FeedSource;
  rateLimited: boolean;
  error: string | null;
}) {
  return (
    <div className="mt-10 rounded-lg border border-dashed border-neutral-300 p-6 sm:p-8 dark:border-neutral-700">
      <h2 className="text-sm font-semibold">
        {rateLimited ? "Reddit is rate limiting this app" : "No posts to show yet"}
      </h2>

      <div className="mt-2 space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
        {rateLimited ? (
          <>
            <p>
              Reddit answered with HTTP 429 (too many requests) and nothing has been cached
              yet, so there is no earlier copy to fall back on.
            </p>
            <p>
              Reddit budgets its public feed per source IP address. On shared hosting that
              address is used by other applications too, so this can happen without this app
              having made many requests. It often clears on its own within a few minutes.
            </p>
          </>
        ) : (
          <p>
            {error
              ? `The feed could not be reached and nothing has been cached yet: ${error}`
              : "The cache is empty. Trigger /api/refresh, or wait for the scheduled refresh."}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <a
          href="/"
          className="font-medium underline underline-offset-2 hover:text-neutral-900 dark:hover:text-white"
        >
          Try again
        </a>
        <a
          href={sourceWebUrl(source)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline underline-offset-2 hover:text-neutral-900 dark:hover:text-white"
        >
          Open {source.label} on Reddit
        </a>
      </div>

      {rateLimited && error ? (
        <p className="mt-4 font-mono text-xs break-words text-neutral-400 dark:text-neutral-500">
          {error}
        </p>
      ) : null}
    </div>
  );
}
