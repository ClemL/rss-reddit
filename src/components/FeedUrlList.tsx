import { sourceFeedUrl } from "@/lib/config";
import type { TimeFilter } from "@/lib/config";
import type { FeedTab } from "@/lib/tabs";

/**
 * The raw Reddit RSS URL behind every tab, so the same groupings can be pasted
 * into any feed reader instead of only being browsable here.
 */
export function FeedUrlList({ tabs, filter }: { tabs: FeedTab[]; filter: TimeFilter }) {
  return (
    <details className="mt-3 group">
      <summary className="cursor-pointer list-none underline underline-offset-2 hover:text-neutral-800 dark:hover:text-neutral-200">
        RSS URLs for every tab
        <span className="ml-1 opacity-60 group-open:hidden">(show)</span>
      </summary>

      <p className="mt-2">
        Each URL is a plain Reddit feed for that tab&rsquo;s subreddits, using the time
        window currently selected ({filter}). Paste any of them into a feed reader.
      </p>

      <ul className="mt-2 space-y-2">
        {tabs.map((tab) => (
          <li key={tab.id}>
            <span className="font-medium text-neutral-600 dark:text-neutral-300">
              {tab.label}
            </span>{" "}
            <span className="opacity-60">({tab.source.subreddits.length} subreddits)</span>
            <br />
            {/* select-all makes a long URL easy to copy without a JS clipboard call. */}
            <a
              href={sourceFeedUrl(tab.source, filter)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[11px] break-all select-all hover:underline"
            >
              {sourceFeedUrl(tab.source, filter)}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
