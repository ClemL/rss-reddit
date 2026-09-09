/**
 * Minimal Redis-over-HTTP client for the key/value store Vercel provisions.
 *
 * Vercel KV is now backed by Upstash Redis, and both the legacy `KV_*` and the
 * marketplace `UPSTASH_REDIS_*` integrations expose the same REST protocol, so
 * talking to it with `fetch` avoids depending on the deprecated `@vercel/kv`
 * package while supporting either set of environment variables.
 *
 * If neither pair of variables is present the app falls back to Next.js's
 * built-in fetch cache; see `src/lib/feed.ts`.
 */

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

/** True when a KV store is configured for this deployment. */
export const kvEnabled: boolean = Boolean(REST_URL && REST_TOKEN);

interface RestResponse<T> {
  result?: T;
  error?: string;
}

async function command<T>(args: (string | number)[]): Promise<T | null> {
  if (!REST_URL || !REST_TOKEN) throw new Error("KV is not configured.");

  const response = await fetch(REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    // The KV store is the cache; its own responses must never be cached.
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`KV request failed with HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as RestResponse<T>;
  if (payload.error) throw new Error(`KV error: ${payload.error}`);
  return payload.result ?? null;
}

/** Reads and JSON-decodes a key. Returns null when absent or undecodable. */
export async function kvGetJson<T>(key: string): Promise<T | null> {
  const raw = await command<string>(["GET", key]);
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Writes a JSON value.
 *
 * Deliberately written without a TTL: the stored snapshot doubles as the
 * last-known-good copy that keeps the site up while Reddit is unreachable, so
 * expiring it would remove the very thing the fallback depends on. Freshness is
 * decided from the snapshot's own `fetchedAt`, not from key expiry.
 */
export async function kvSetJson(key: string, value: unknown): Promise<void> {
  await command(["SET", key, JSON.stringify(value)]);
}
