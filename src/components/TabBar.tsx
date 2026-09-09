import Link from "next/link";

import type { FeedTab } from "@/lib/tabs";
import type { TimeFilter } from "@/lib/config";

import { buildHref } from "@/lib/href";

/**
 * Topic tabs. Rendered as real links rather than buttons so each tab is a
 * distinct, shareable, separately cached URL and works without JavaScript.
 */
export function TabBar({
  tabs,
  activeId,
  filter,
  defaultFilter,
  defaultTabId,
}: {
  tabs: FeedTab[];
  activeId: string;
  filter: TimeFilter;
  defaultFilter: TimeFilter;
  defaultTabId: string;
}) {
  return (
    <nav
      aria-label="Topics"
      className="-mx-4 mt-3 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <ul className="flex w-max gap-1">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <li key={tab.id}>
              <Link
                href={buildHref({ tab: tab.id, filter, defaultFilter, defaultTabId })}
                aria-current={active ? "page" : undefined}
                title={tab.source.label}
                scroll={false}
                className={`block rounded-md px-2.5 py-1 text-xs whitespace-nowrap transition-colors ${
                  active
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                }`}
              >
                {tab.label}
                <span
                  className={`ml-1.5 tabular-nums ${active ? "opacity-60" : "opacity-40"}`}
                >
                  {tab.source.subreddits.length}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
