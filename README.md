# rss-reddit

A single-page Next.js (App Router, TypeScript) app that lists the top 10 posts from a
subreddit — r/programming by default — using Reddit's public RSS endpoint. Built to
deploy on Vercel.

Each post shows its title (linked to the submission's external target), the author, a
relative publication time, and a separate link to the Reddit comments page. A dropdown
switches the time window between the past hour, day, week, month, year, and all time.

## What the feed does and does not provide

The data source is an **Atom** feed (not RSS 2.0), parsed with `fast-xml-parser`:

```
https://www.reddit.com/r/programming/top/.rss?t=day
```

Each `<entry>` provides a title, author, publication timestamp, a permalink to the
Reddit thread, an HTML `content` block, and — inside that HTML — the `[link]` anchor
holding the external URL.

Two things are deliberately absent from this app because they are absent from the feed:

- **No scores or upvote counts.** The feed carries none, so none are displayed and none
  are inferred. The list order is the feed's own top-N ordering and nothing more. The
  rank number beside each post reflects position in the feed, not a score.
- **No comments.** The feed carries no comment bodies or counts. Rather than making
  additional requests, each post links out to its Reddit comments page.

## How the caching works

The design goal is that ordinary visitor traffic never reaches Reddit. Reddit is
contacted on a schedule, and the page reads whatever the cache holds.

### The refresh cron

`vercel.json` registers a cron job that calls the `/api/refresh` route handler every 15
minutes:

```json
{ "crons": [{ "path": "/api/refresh", "schedule": "*/15 * * * *" }] }
```

`/api/refresh` fetches and parses the feed for **every** time filter and stores each one
separately, with a 400 ms pause between upstream requests so a refresh is not a burst.
Passing `?t=week` refreshes just that one variant. `POST` is accepted as well as `GET`,
so a refresh can be triggered by hand.

If `CRON_SECRET` is set, the route requires `Authorization: Bearer <secret>`; Vercel Cron
sends that header automatically. If it is unset, the route is open — acceptable for a
read-only public feed, but setting it is recommended.

The route returns HTTP 200 as long as at least one filter refreshed, because a partial
failure leaves the previously cached data intact and is therefore not an outage. It
returns 502 only when every filter failed.

### The two cache backends

**Vercel KV / Redis (used when `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set).**
Each time filter is stored under its own key, `feed:<subreddit>:<filter>`, as a snapshot
containing the parsed posts plus the timestamp of the upstream fetch. A page render
reads that key and serves it; it only contacts Reddit when the snapshot is missing
entirely, or older than `REVALIDATE_SECONDS` and the cron has not caught up. In steady
state, page renders perform **zero** Reddit requests.

Snapshots are written **without a TTL** on purpose. The stored copy doubles as the
last-known-good data that keeps the site up while Reddit is unreachable, so expiring the
key would delete the very thing the fallback depends on. Freshness is judged from the
snapshot's own `fetchedAt` field, never from key expiry.

This app talks to the store over its Redis REST protocol using `fetch`, so it has no
dependency on the deprecated `@vercel/kv` package. Both the legacy `KV_*` and the
marketplace `UPSTASH_REDIS_REST_*` variable pairs are accepted.

**Next.js fetch cache (the fallback when no KV store is configured).** The feed request
is issued with `next: { revalidate: 900, tags: ["reddit-feed:<subreddit>:<filter>"] }`,
so Next.js's Data Cache holds the response and each time filter carries its own
revalidation tag. `/api/refresh` expires the tag and immediately re-fetches to leave the
cache warm.

This mode is a reasonable default but is weaker than KV in two respects: the cache is
per-deployment rather than shared, and Next.js revalidates in the background, so a page
render does not directly observe an upstream failure. Use KV if you have it.

### Failure handling

A failed or non-200 fetch never produces an error page. The last successfully cached
snapshot keeps being served, and a small "data may be stale" badge appears in the header
once the data on hand is older than twice `REVALIDATE_SECONDS` (30 minutes by default).
The badge clears by itself on the next successful refresh.

Only one situation shows no posts: a completely cold cache combined with an unreachable
Reddit. In that case the page explains what happened instead of erroring.

Observed behavior with a 20-second revalidate window and a simulated Reddit outage:

| Phase                              | Posts rendered | Stale badge |
| ---------------------------------- | -------------- | ----------- |
| Healthy, across several refreshes   | yes            | no          |
| Reddit down, within threshold       | yes            | no          |
| Reddit down, past threshold         | yes            | yes         |
| Reddit recovered                    | yes            | no          |

## Configuration

Every value below is an environment variable with a working default, so the app runs
with no configuration at all. See `.env.example`.

| Variable              | Default                    | Purpose                                                        |
| --------------------- | -------------------------- | -------------------------------------------------------------- |
| `SUBREDDIT`           | `programming`              | Subreddit to read, without the `r/` prefix                      |
| `DEFAULT_TIME_FILTER` | `day`                      | `hour`, `day`, `week`, `month`, `year`, or `all`                |
| `POST_COUNT`          | `10`                       | Posts rendered on the page                                      |
| `REVALIDATE_SECONDS`  | `900`                      | Cache lifetime; keep aligned with the cron schedule             |
| `CRON_SECRET`         | unset                      | Bearer token required by `/api/refresh` when set                |
| `KV_REST_API_URL`     | unset                      | Enables KV caching (with the token below)                       |
| `KV_REST_API_TOKEN`   | unset                      | Enables KV caching (with the URL above)                         |
| `STRICT_CACHE_ONLY`   | unset                      | `1` stops page renders contacting Reddit at all (KV mode only)  |
| `REDDIT_USER_AGENT`   | `web:rss-reddit:1.0.0 …`   | Descriptive user agent, as Reddit asks for                      |
| `REDDIT_BASE_URL`     | `https://www.reddit.com`   | Feed origin; for pointing at a local mock in testing            |

### Changing the subreddit

Set `SUBREDDIT` (for example `SUBREDDIT=rust`) in `.env.local` locally, or in Project
Settings → Environment Variables on Vercel, then redeploy. Nothing else is hardcoded to
r/programming. Cache keys and revalidation tags include the subreddit name, so changing
it does not collide with previously cached data.

### Changing the default time filter

Set `DEFAULT_TIME_FILTER` to one of the six accepted values. It applies when the visitor
has not chosen one. The dropdown always offers all six regardless, and the selection
travels in the query string (`/?t=week`), which keeps each variant separately cached and
individually shareable. An unrecognized or malformed `?t=` value falls back to the
default rather than being passed to Reddit.

### Changing the post count

Set `POST_COUNT`. It is applied when the feed is parsed, so the cached snapshot holds
exactly that many posts.

### Changing the refresh interval

Edit the `schedule` in `vercel.json` and set `REVALIDATE_SECONDS` to the equivalent
number of seconds so the two agree. Note that Vercel's Hobby plan limits cron jobs to
one invocation per day; on Hobby, leave `STRICT_CACHE_ONLY` unset so page renders can
still refresh expired data on their own.

## Running locally

```bash
npm install
npm run dev          # http://localhost:3000
```

```bash
npm test             # parser and formatting unit tests (vitest)
npm run typecheck    # tsc --noEmit
npm run build        # production build
```

The test suite runs against checked-in Atom fixtures in `src/lib/__fixtures__/`, so it
needs no network access and doubles as a regression guard on the feed shape: link posts
versus self posts, entries with no `[link]` anchor, numeric titles, HTML entities, and
single-entry feeds.

## Deploying to Vercel

1. Import the repository into Vercel. The framework preset is detected automatically.
2. Optionally add a Redis store from the Vercel Marketplace; it populates
   `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
3. Set `CRON_SECRET` to a random string.
4. Deploy. The cron in `vercel.json` is registered on deployment.
5. Warm the cache immediately rather than waiting for the first cron tick:

   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://<your-deployment>/api/refresh
   ```

## A caveat about the data source

This app depends on Reddit's **public, unauthenticated RSS endpoint**. There is no API
key, no OAuth, and no formal contract behind it.

That endpoint is not a supported, versioned API. Reddit has previously changed access
rules for its public interfaces with little notice, and it may rate-limit, alter the
markup of, or block this endpoint at any time — particularly for requests originating
from cloud provider IP ranges, which includes Vercel's. **Nothing should be built on the
assumption that it will keep working.**

The code is written with that in mind: fetch failures degrade to cached data rather than
errors, the parser tolerates missing fields instead of throwing, and the whole upstream
dependency is confined to `src/lib/atom.ts` and `src/lib/feed.ts`. If the endpoint
changes shape or disappears, those two files are what you replace — with Reddit's
authenticated OAuth API, or another source entirely.

## Project layout

```
src/
  app/
    layout.tsx            root layout and metadata
    page.tsx              the page; reads the cache, never Reddit directly
    globals.css           Tailwind entry point
    api/refresh/route.ts  cron target; refreshes and stores every time filter
  components/
    PostCard.tsx          one post
    TimeFilterSelect.tsx  time window dropdown (the only client component)
    StaleNotice.tsx       "data may be stale" badge
  lib/
    config.ts             environment configuration and feed URLs
    atom.ts               Atom parsing and post normalization
    feed.ts               caching, stale fallback, refresh
    kv.ts                 Redis-over-HTTP client
    time.ts               relative time and host formatting
vercel.json               cron schedule
```

Styling is Tailwind CSS v4 only — no component library — with a responsive layout and
dark mode driven by the visitor's system preference.
