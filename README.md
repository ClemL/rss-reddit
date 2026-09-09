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

## Topic tabs

The header carries a row of tabs, each a named group of subreddits cached and
refreshed independently. The defaults group 69 subreddits into nine topics (Dev,
Data, Cloud & IT, AI, Boston, World, Learn, Culture, Tech & Fun); they live in
`DEFAULT_TAB_DEFINITIONS` in `src/lib/tabs.ts` as ordinary source you can edit.

Grouping is not only navigational. **Reddit returns about 25 entries per feed no
matter how many subreddits are combined**, so a single listing of 69 subreddits is
dominated by whichever handful post most and the quieter ones effectively never
surface. Nine groups of three to twelve give each topic its own slice of the
results.

Tabs are plain links, so each is a distinct, shareable, separately cached URL
(`/?tab=boston&t=week`) that works without JavaScript. Switching the time window
keeps you on the current tab. The footer lists the raw Reddit RSS URL behind every
tab, so the same groupings can be pasted into any feed reader.

Override the tabs without touching the source using `FEED_TABS`:

```
FEED_TABS="Dev=programming+rust+golang;Local=boston+mbta;Mine=user/cdawgg/m/tech"
```

Groups are `Label=sub1+sub2`, separated by `;`. A public multireddit works as a
group. A malformed group is skipped rather than failing the deployment, and if
every group is malformed the defaults are used. Setting only `SUBREDDIT` collapses
the app to a single tab and hides the tab bar, so single-subreddit deployments are
unchanged.

### Tabs and the refresh budget

Nine tabs times six time windows would be 54 upstream requests per refresh, far
beyond what Reddit's per-IP budget tolerates (see [Rate limiting](#rate-limiting-http-429)).
The cron therefore refreshes **every tab at the default time window only** — nine
requests, spaced `REFRESH_DELAY_MS` apart. Other windows are fetched on demand the
first time a reader selects one, then cached like anything else.

To refresh something specific by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" ".../api/refresh?tab=boston&t=week"
curl -H "Authorization: Bearer $CRON_SECRET" ".../api/refresh?all=1"   # every window; watch the budget
```

## Display density

A three-level density switch sits in the header. The choice is stored per browser
in `localStorage`, so it persists between visits without appearing in the URL — it
describes how the reader wants the page drawn, not what the page is showing.

| Level     | Cards                          | Excerpts        | Measured list height |
| --------- | ------------------------------ | --------------- | -------------------- |
| Cozy      | Roomy, bordered, 18px titles   | Up to 3 lines   | 496 px (baseline)    |
| Compact   | Tighter, bordered, 15px titles | Clamped to 2    | 336 px (−32%)        |
| Dense     | Hairline rows, 14px titles     | Hidden          | 186 px (−63%)        |

Heights are for the same four posts at a 900px viewport, measured in Chromium.

Every density-dependent value is a CSS custom property in `globals.css`, so the
markup is identical at all three levels and the switch changes nothing but
variables. To retune a level, edit its block there rather than touching the
components. `NEXT_PUBLIC_DEFAULT_DENSITY` sets the level for readers who have not
chosen one.

An inline script in the document head applies the stored density before first
paint, so the page never renders at one density and visibly jumps to another.

## How the caching works

The design goal is that ordinary visitor traffic never reaches Reddit. Reddit is
contacted on a schedule, and the page reads whatever the cache holds.

### The refresh cron

`vercel.json` registers a cron job that calls the `/api/refresh` route handler:

```json
{ "crons": [{ "path": "/api/refresh", "schedule": "0 8 * * *" }] }
```

**The default schedule is once daily, because Vercel's Hobby plan rejects anything more
frequent at deploy time** — see [Plan limits](#plan-limits-read-before-deploying) below.
On a Pro plan, change it to `*/15 * * * *` for a 15-minute refresh.

A daily cron is not a problem for freshness. The cron is a warm-up and a backstop, not
the only refresh path: a page render still refreshes data that has outlived
`REVALIDATE_SECONDS` on its own (see the two backends below). The cron's real value is
keeping *all six* time filters warm, including ones nobody has visited recently.

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
once the data on hand is older than twice `REVALIDATE_SECONDS` (30 minutes by default),
or as soon as a refresh actually fails. The badge names rate limiting specifically when
that is the cause, and clears by itself on the next successful refresh.

Transient failures are retried with exponential backoff and full jitter. The upstream's
`Retry-After` header is honored but capped, so an hour-long hint never blocks a request.
Retry budgets differ by caller: a page render gets 2 attempts, because a visitor should
not wait on a cold cache, while `/api/refresh` gets 3. A 403 is never retried — from a
datacenter IP that means a standing block, and retrying only spends more of the budget.

Only one situation shows no posts: a completely cold cache combined with an unreachable
Reddit. The page then explains what happened, links out to the subreddit, and offers a
retry. It deliberately renders **no** placeholder or bundled sample posts, because
fabricated entries presented as live Reddit data would be worse than an honest empty page.

### Rate limiting (HTTP 429)

This is the most likely problem you will hit in production, and it is usually not caused
by your own traffic.

Reddit budgets its unauthenticated feed **per source IP**. On Vercel — and any serverless
host — outbound requests leave from a shared egress pool, so that budget is shared with
every other tenant using the same address. Reddit's public `.rss` endpoints allow roughly
15–18 sequential requests per IP before returning 429 for everything, and there is no
separate budget per endpoint. A deployment making only a handful of requests an hour can
therefore still be refused.

What this app does about it:

- Retries transient 429s with backoff and jitter, which clears the common short-lived case.
- Serves the last cached snapshot with a rate-limit badge instead of failing.
- **Stops the refresh run at the first 429** rather than attempting the remaining time
  filters, since those would fail too and each attempt digs the hole deeper.
- Spaces the cron's per-filter requests `REFRESH_DELAY_MS` apart (1500 ms by default).

If 429s persist rather than clearing, retrying is not the answer — the shared IP is
saturated or blocked, and the fix is to stop being unauthenticated. Reddit's OAuth Data
API budgets **100 queries per minute per OAuth client ID** rather than per IP, is free for
non-commercial use, and is unaffected by what other tenants on the IP are doing.
Registering an app at <https://www.reddit.com/prefs/apps> and switching the fetch in
`src/lib/feed.ts` to a `client_credentials` token against `oauth.reddit.com` is the
supported path. It also returns scores and comment counts, which the RSS feed does not.

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
| `FEED_TABS`           | nine topic tabs            | `Label=sub1+sub2;Label2=sub3` — overrides `SUBREDDIT`            |
| `SUBREDDIT`           | unset                      | Single subreddit, `a+b+c`, or `user/<name>/m/<multi>`; one tab   |
| `DEFAULT_TIME_FILTER` | `day`                      | `hour`, `day`, `week`, `month`, `year`, or `all`                |
| `POST_COUNT`          | `10`                       | Posts rendered on the page                                      |
| `REVALIDATE_SECONDS`  | `900`                      | Cache lifetime; governs refresh frequency in normal operation    |
| `CRON_SECRET`         | unset                      | Bearer token required by `/api/refresh` when set                |
| `KV_REST_API_URL`     | unset                      | Enables KV caching (with the token below)                       |
| `KV_REST_API_TOKEN`   | unset                      | Enables KV caching (with the URL above)                         |
| `STRICT_CACHE_ONLY`   | unset                      | `1` stops page renders contacting Reddit at all (KV mode only)  |
| `RENDER_FETCH_ATTEMPTS` | `2`                      | Upstream attempts allowed during a page render                  |
| `REFRESH_FETCH_ATTEMPTS` | `3`                     | Upstream attempts allowed in `/api/refresh`                     |
| `REFRESH_DELAY_MS`    | `1500`                     | Pause between the cron's per-filter requests                    |
| `REDDIT_USER_AGENT`   | `web:rss-reddit:1.0.0 …`   | Descriptive user agent, as Reddit asks for                      |
| `REDDIT_BASE_URL`     | `https://www.reddit.com`   | Feed origin; for pointing at a local mock in testing            |
| `NEXT_PUBLIC_DEFAULT_DENSITY` | `cozy`             | `cozy`, `compact`, or `dense` for first-time readers             |

### Changing the subreddit, or reading several at once

`SUBREDDIT` accepts three forms, all of which Reddit serves as public RSS with no
authentication:

| Setting                       | Reads                                      |
| ----------------------------- | ------------------------------------------ |
| `programming`                 | One subreddit                               |
| `programming+rust+golang`     | Several subreddits merged into one listing  |
| `user/cdawgg/m/tech`          | A user's **public** multireddit             |

A full URL is accepted too, so `https://old.reddit.com/r/rust/` and `r/rust` and
`rust` all work. Names are validated against Reddit's own rules before being placed
in a URL, and anything unrecognized falls back to `programming` rather than failing
the build. Cache keys and revalidation tags derive from the source, so switching does
not collide with previously cached data.

Set it in `.env.local` locally, or in Project Settings → Environment Variables on
Vercel, then redeploy.

### What is not possible: reading someone's subscriptions

Pointing this app at a profile URL like `https://old.reddit.com/user/cdawgg/` to pull
"the subreddits I subscribe to" **cannot work**, and not because of a missing feature.
Reddit treats a subscription list as private account data. There is no public endpoint
that exposes it — not RSS, not JSON — and no way to derive it from a profile page. The
API endpoint that returns subscriptions, `/subreddits/mine/subscriber`, requires OAuth
and always returns *the authenticated account's own* subscriptions; authenticating as
one user never reveals another user's list. Passing a bare profile URL therefore fails
with an explanation rather than silently doing something else.

Two things do achieve the practical goal:

- **A public multireddit.** Create one on Reddit, add the subreddits you want, set it
  to public, and use `user/<you>/m/<name>`. This is the closest equivalent to a
  subscription list, because its owner has explicitly chosen to publish it, and it
  stays in sync when you edit it on Reddit.
- **A combined list.** `SUBREDDIT=programming+rust+golang` needs no account at all,
  but is fixed at deploy time.

Reading *your own* live subscriptions would require adding a Reddit OAuth sign-in flow
with the `mysubreddits` scope, so each visitor authenticates as themselves. That is a
different application from this one — a personal reader rather than a public page — and
is not implemented here.

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

`REVALIDATE_SECONDS` (default `900`) controls how long cached data is considered fresh,
and is what actually governs refresh frequency in normal operation. Change it alone to
make the site refresh more or less often.

The cron `schedule` in `vercel.json` is separate, and is constrained by your Vercel plan
(below). On Pro, setting it to match `REVALIDATE_SECONDS` — `*/15 * * * *` for 900
seconds — means the cron does the refreshing and visitors never trigger an upstream
fetch. On Hobby, leave the daily schedule and leave `STRICT_CACHE_ONLY` unset so page
renders keep data fresh themselves.

### Plan limits (read before deploying)

Vercel's Hobby plan permits **at most one cron invocation per day**, and this is enforced
when the deployment is created, not at runtime. A schedule such as `*/15 * * * *` or even
the hourly `0 * * * *` **fails the deployment** with:

```
Hobby accounts are limited to daily cron jobs.
```

The committed schedule (`0 8 * * *`) is daily, so it deploys on any plan. Hobby also caps
a project at two cron jobs, and fires a daily job at some point within its scheduled hour
rather than exactly on the minute. Pro removes the frequency limit; see
[Vercel's cron pricing docs](https://vercel.com/docs/cron-jobs/usage-and-pricing).

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
4. Deploy. The cron in `vercel.json` is registered on deployment. If you are on Pro and
   want the 15-minute refresh, change the schedule to `*/15 * * * *` first.
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
errors, transient failures are retried, the parser tolerates missing fields instead of
throwing, and the whole upstream dependency is confined to `src/lib/atom.ts`,
`src/lib/http.ts` and `src/lib/feed.ts`. If the endpoint changes shape or disappears,
those are the files you replace — with Reddit's authenticated OAuth API, or another
source entirely. See [Rate limiting](#rate-limiting-http-429) for the most common way
this bites in practice.

## Project layout

```
src/
  app/
    layout.tsx            root layout and metadata
    page.tsx              the page; reads the cache, never Reddit directly
    globals.css           Tailwind entry point and the density custom properties
    api/refresh/route.ts  cron target; refreshes and stores every time filter
  components/
    PostCard.tsx          one post
    TimeFilterSelect.tsx  time window dropdown (client)
    DensityToggle.tsx     display density switch (client)
    TabBar.tsx            topic tabs
    FeedUrlList.tsx       raw RSS URL for each tab
    StaleNotice.tsx       "data may be stale" badge
    EmptyState.tsx        cold-cache-and-unreachable explanation
  lib/
    config.ts             environment configuration and feed URLs
    source.ts             parses a subreddit, combination or multireddit
    tabs.ts               topic tab definitions and resolution
    href.ts               builds tab/time-window URLs
    density.ts            density levels and the pre-paint init script
    atom.ts               Atom parsing and post normalization
    http.ts               retrying fetch, backoff, Retry-After handling
    feed.ts               caching, stale fallback, refresh
    kv.ts                 Redis-over-HTTP client
    time.ts               relative time and host formatting
vercel.json               cron schedule
```

Styling is Tailwind CSS v4 only — no component library — with a responsive layout and
dark mode driven by the visitor's system preference.
