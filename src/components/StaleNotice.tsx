/**
 * Small, non-blocking indicator shown when the last refresh failed or the cron
 * has not landed recently. The page keeps rendering the previous snapshot.
 */
export function StaleNotice({ age, rateLimited = false }: { age: string; rateLimited?: boolean }) {
  return (
    <p
      role="status"
      className="mt-3 inline-flex items-center gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-2.5 py-1 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
      {rateLimited
        ? `Reddit is rate limiting refreshes — showing the copy from ${age}.`
        : `Data may be stale — last successful refresh ${age}.`}
    </p>
  );
}
