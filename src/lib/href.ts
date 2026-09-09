import type { TimeFilter } from "@/lib/config";

/**
 * Builds a page URL carrying the tab and time filter, omitting either when it
 * matches the default so the common case stays a clean `/`.
 */
export function buildHref({
  tab,
  filter,
  defaultFilter,
  defaultTabId,
}: {
  tab: string;
  filter: TimeFilter;
  defaultFilter: TimeFilter;
  defaultTabId: string;
}): string {
  const params = new URLSearchParams();
  if (tab !== defaultTabId) params.set("tab", tab);
  if (filter !== defaultFilter) params.set("t", filter);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}
