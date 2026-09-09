import { NextResponse } from "next/server";

import { REFRESH_DELAY_MS, SUBREDDIT, TIME_FILTERS, isTimeFilter, type TimeFilter } from "@/lib/config";
import { refreshFeed } from "@/lib/feed";
import { UpstreamError } from "@/lib/http";

/** The cron job must always execute; never serve this route from a cache. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Vercel kills the function at this many seconds. The refresh paces itself well
 * inside the limit, but a slow upstream should not take the whole budget.
 */
export const maxDuration = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on cron invocations when
 * the CRON_SECRET environment variable is set. When it is not set the route is
 * left open, which is acceptable for a public read-only feed but is called out
 * in the README.
 */
function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

interface RefreshOutcome {
  filter: TimeFilter;
  ok: boolean;
  posts?: number;
  fetchedAt?: string;
  error?: string;
  /** Set when the filter was not attempted because the budget was exhausted. */
  skipped?: boolean;
}

async function handle(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  // `?t=day` refreshes a single variant; omitting it refreshes all of them,
  // since each time filter is cached separately.
  const requested = new URL(request.url).searchParams.get("t");
  const filters: readonly TimeFilter[] = isTimeFilter(requested) ? [requested] : TIME_FILTERS;

  const results: RefreshOutcome[] = [];
  let rateLimited = false;

  for (const [index, filter] of filters.entries()) {
    // Reddit budgets unauthenticated requests per source IP. Once it starts
    // refusing, the remaining filters would fail too and each attempt digs the
    // hole deeper, so stop and leave the rest to the next run.
    if (rateLimited) {
      results.push({ filter, ok: false, skipped: true, error: "Skipped: rate limited earlier in this run." });
      continue;
    }

    if (index > 0) await sleep(REFRESH_DELAY_MS);

    try {
      const snapshot = await refreshFeed(filter);
      results.push({
        filter,
        ok: true,
        posts: snapshot.posts.length,
        fetchedAt: snapshot.fetchedAt,
      });
    } catch (error) {
      if (error instanceof UpstreamError && error.isRateLimited) rateLimited = true;
      results.push({
        filter,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const succeeded = results.filter((result) => result.ok).length;

  // A partial failure still returns 200: the previously cached data is intact
  // and the site keeps serving it, so this is not an outage.
  return NextResponse.json(
    {
      ok: succeeded > 0,
      subreddit: SUBREDDIT,
      refreshedAt: new Date().toISOString(),
      succeeded,
      attempted: results.length,
      rateLimited,
      results,
    },
    { status: succeeded > 0 ? 200 : 502 },
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request);
}

/** Allows manual triggering with POST as well as the cron's GET. */
export async function POST(request: Request): Promise<NextResponse> {
  return handle(request);
}
