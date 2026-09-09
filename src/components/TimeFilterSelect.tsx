"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { DEFAULT_TIME_FILTER, TIME_FILTERS, type TimeFilter } from "@/lib/config";
import { buildHref } from "@/lib/href";

const LABELS: Record<TimeFilter, string> = {
  hour: "Past hour",
  day: "Past 24 hours",
  week: "Past week",
  month: "Past month",
  year: "Past year",
  all: "All time",
};

/**
 * Time-window picker. Navigation carries the selection in the query string so
 * each variant is a distinct, separately cached URL and remains shareable.
 */
export function TimeFilterSelect({
  value,
  tab,
  defaultTabId,
}: {
  value: TimeFilter;
  tab: string;
  defaultTabId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="time-filter" className="text-sm text-neutral-500 dark:text-neutral-400">
        Top of
      </label>
      <select
        id="time-filter"
        name="t"
        value={value}
        disabled={isPending}
        onChange={(event) => {
          const next = event.target.value as TimeFilter;
          startTransition(() => {
            // Changing the window must keep the reader on the same tab.
            router.push(
              buildHref({
                tab,
                filter: next,
                defaultFilter: DEFAULT_TIME_FILTER,
                defaultTabId,
              }),
              { scroll: false },
            );
          });
        }}
        className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 shadow-sm transition-colors hover:border-neutral-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:border-neutral-600"
      >
        {TIME_FILTERS.map((filter) => (
          <option key={filter} value={filter}>
            {LABELS[filter]}
          </option>
        ))}
      </select>
      <span
        aria-live="polite"
        className={`text-xs text-neutral-400 transition-opacity ${isPending ? "opacity-100" : "opacity-0"}`}
      >
        Loading…
      </span>
    </div>
  );
}
