import { NextResponse } from "next/server";

import { SUBREDDIT, TIME_FILTERS, isTimeFilter, type TimeFilter } from "@/lib/config";
import { refreshFeed } from "@/lib/feed";

/** The cron job must always execute; never serve this route from a cache. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Courtesy pause between upstream requests so a refresh is not a burst. */
const DELAY_BETWEEN_FETCHES_MS = 400;

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

  for (const [index, filter] of filters.entries()) {
    if (index > 0) await sleep(DELAY_BETWEEN_FETCHES_MS);
    try {
      const snapshot = await refreshFeed(filter);
      results.push({
        filter,
        ok: true,
        posts: snapshot.posts.length,
        fetchedAt: snapshot.fetchedAt,
      });
    } catch (error) {
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
