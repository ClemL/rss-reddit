/**
 * Resolves the `SUBREDDIT` setting into a Reddit feed location.
 *
 * Three forms are accepted, all of which Reddit serves as public RSS without
 * authentication:
 *
 *   programming                 a single subreddit
 *   programming+rust+golang     several subreddits combined into one listing
 *   user/someone/m/tech         someone's *public* multireddit
 *
 * A user's actual subscriptions are not among them: Reddit treats a
 * subscription list as private account data with no public endpoint, so there
 * is no way to derive one from a profile URL. A public multireddit is the
 * closest equivalent, because its owner has explicitly chosen to publish it.
 */

export type FeedSourceKind = "subreddit" | "combined" | "multireddit";

export interface FeedSource {
  kind: FeedSourceKind;
  /** Reddit path without leading or trailing slashes, e.g. `r/programming`. */
  path: string;
  /** Short label for headings, e.g. `r/programming` or `u/someone/m/tech`. */
  label: string;
  /** Filesystem- and cache-key-safe identifier. */
  key: string;
  /** Individual subreddit names, empty for a multireddit. */
  subreddits: string[];
}

// Reddit's own naming rules, applied so a malformed setting cannot inject path
// segments or query parameters into the feed URL.
const SUBREDDIT_NAME = /^[A-Za-z0-9_]{2,21}$/;
const USERNAME = /^[A-Za-z0-9_-]{3,20}$/;
const MULTI_NAME = /^[A-Za-z0-9_]{2,50}$/;

export const DEFAULT_SOURCE_INPUT = "programming";

export class InvalidSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSourceError";
  }
}

function stripDecoration(raw: string): string {
  let value = raw.trim();
  // Accept a pasted URL as well as a bare name.
  value = value.replace(/^https?:\/\/(?:[a-z]+\.)?reddit\.com\//i, "");
  value = value.replace(/^\/+/, "").replace(/\/+$/, "");
  // Drop a trailing listing or feed suffix, e.g. ".../top/.rss".
  value = value.replace(/\/(top|hot|new|rising|controversial)(\/\.rss)?$/i, "");
  value = value.replace(/\/?\.rss$/i, "");
  return value.trim();
}

/**
 * Parses the setting, throwing `InvalidSourceError` when it does not match one
 * of the supported forms. Callers that must not fail should use
 * `parseFeedSourceOrDefault`.
 */
export function parseFeedSource(raw: string): FeedSource {
  const value = stripDecoration(raw);
  if (!value) throw new InvalidSourceError("Feed source was empty.");

  // user/<name>/m/<multi>, also accepted as u/<name>/m/<multi>.
  const multi = /^(?:u|user)\/([^/]+)\/m\/([^/]+)$/i.exec(value);
  if (multi) {
    const [, username, multiName] = multi;
    if (!USERNAME.test(username)) {
      throw new InvalidSourceError(`"${username}" is not a valid Reddit username.`);
    }
    if (!MULTI_NAME.test(multiName)) {
      throw new InvalidSourceError(`"${multiName}" is not a valid multireddit name.`);
    }
    return {
      kind: "multireddit",
      path: `user/${username}/m/${multiName}`,
      label: `u/${username}/m/${multiName}`,
      key: `u_${username}__m_${multiName}`,
      subreddits: [],
    };
  }

  // A bare profile URL: valid input to attempt, but not something we can serve.
  const profile = /^(?:u|user)\/([^/]+)$/i.exec(value);
  if (profile) {
    throw new InvalidSourceError(
      `A user profile is not a feed source. Reddit keeps subscription lists private, ` +
        `so u/${profile[1]}'s subscribed subreddits cannot be read. Use a public ` +
        `multireddit (user/${profile[1]}/m/<name>) or a combined list ` +
        `(sub1+sub2+sub3) instead.`,
    );
  }

  const withoutPrefix = value.replace(/^r\//i, "");
  const names = withoutPrefix.split("+").map((name) => name.trim()).filter(Boolean);

  if (names.length === 0) throw new InvalidSourceError("No subreddit names given.");

  for (const name of names) {
    if (!SUBREDDIT_NAME.test(name)) {
      throw new InvalidSourceError(`"${name}" is not a valid subreddit name.`);
    }
  }

  const joined = names.join("+");
  return {
    kind: names.length > 1 ? "combined" : "subreddit",
    path: `r/${joined}`,
    label: `r/${joined}`,
    key: names.join("_"),
    subreddits: names,
  };
}

/** Parses, falling back to r/programming rather than throwing at import time. */
export function parseFeedSourceOrDefault(raw: string | undefined): FeedSource {
  try {
    return parseFeedSource(raw ?? DEFAULT_SOURCE_INPUT);
  } catch {
    return parseFeedSource(DEFAULT_SOURCE_INPUT);
  }
}

/** Heading text: compact for one subreddit, summarized for a long combination. */
export function shortLabel(source: FeedSource, maxNames = 3): string {
  if (source.kind !== "combined" || source.subreddits.length <= maxNames) return source.label;
  const shown = source.subreddits.slice(0, maxNames).join("+");
  return `r/${shown} +${source.subreddits.length - maxNames}`;
}
