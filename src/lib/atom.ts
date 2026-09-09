import { XMLParser } from "fast-xml-parser";

/** A single post, normalized out of one Atom `<entry>`. */
export interface RedditPost {
  /** Reddit's fullname, e.g. `t3_1abc23`. Stable, used as the React key. */
  id: string;
  title: string;
  /** Display form as Reddit publishes it, e.g. `/u/example`. */
  author: string;
  authorUrl: string | null;
  /** ISO-8601 publication timestamp. */
  publishedAt: string;
  /** Reddit comments page for the post. */
  permalink: string;
  /**
   * The `[link]` target: the external article for link posts, and the
   * permalink itself for self posts.
   */
  url: string;
  /** True when the submission is a Reddit-hosted text post. */
  isSelfPost: boolean;
  /** Plain-text excerpt of the self-text, empty for link posts. */
  excerpt: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  // Titles like "2024" or "1.0" must stay strings, never become numbers.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});

type XmlNode = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Reads a node that may be a bare string or `{ "#text": "..." }`. */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const node = value as XmlNode;
    if (typeof node["#text"] === "string") return node["#text"];
  }
  return "";
}

/**
 * Picks an `<link>` href. Atom permits repeated links; Reddit emits a single
 * `alternate` link pointing at the comments page.
 */
function linkHref(value: unknown): string {
  for (const link of asArray(value as XmlNode | XmlNode[])) {
    if (link && typeof link === "object") {
      const href = (link as XmlNode)["@_href"];
      const rel = (link as XmlNode)["@_rel"];
      if (typeof href === "string" && (rel === undefined || rel === "alternate")) return href;
    }
    if (typeof link === "string") return link;
  }
  return "";
}

/**
 * Reddit's `<content>` HTML ends with a footer of the form
 * `<span><a href="…">[link]</a></span> <span><a href="…">[comments]</a></span>`.
 * The `[link]` href is the only place the external URL appears in the feed.
 */
function extractAnchorByLabel(html: string, label: string): string | null {
  const pattern = new RegExp(
    `<a\\b[^>]*\\bhref="([^"]*)"[^>]*>\\s*\\[${label}\\]\\s*</a>`,
    "i",
  );
  return pattern.exec(html)?.[1]?.trim() || null;
}

/** Strips the submission footer, tags and entities down to a readable excerpt. */
function excerptFromContent(html: string, maxLength = 280): string {
  const body = html.split(/<!--\s*SC_ON\s*-->/i)[0] ?? html;
  const plain = body
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#32;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length <= maxLength) return plain;
  const cut = plain.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function normalizeUrl(candidate: string, fallback: string): string {
  const value = candidate.trim();
  if (!value) return fallback;
  // Reject anything that is not http(s) — the feed is third-party content.
  try {
    const parsed = new URL(value, "https://www.reddit.com");
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : fallback;
  } catch {
    return fallback;
  }
}

function entryToPost(entry: XmlNode, index: number): RedditPost | null {
  const permalinkRaw = linkHref(entry.link);
  const title = text(entry.title);
  if (!title && !permalinkRaw) return null;

  const permalink = normalizeUrl(permalinkRaw, "https://www.reddit.com");
  const content = text(entry.content);
  const externalHref = extractAnchorByLabel(content, "link");
  const url = externalHref ? normalizeUrl(externalHref, permalink) : permalink;

  const author = entry.author as XmlNode | undefined;
  const authorName = text(author?.name) || "unknown";
  const authorUri = text(author?.uri);

  const publishedRaw = text(entry.published) || text(entry.updated);
  const published = new Date(publishedRaw);

  const isSelfPost = url === permalink;

  return {
    id: text(entry.id) || `${permalink}#${index}`,
    title: title || "(untitled)",
    author: authorName,
    authorUrl: authorUri ? normalizeUrl(authorUri, "") || null : null,
    publishedAt: Number.isNaN(published.getTime()) ? new Date(0).toISOString() : published.toISOString(),
    permalink,
    url,
    isSelfPost,
    excerpt: isSelfPost ? excerptFromContent(content) : "",
  };
}

export class AtomParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomParseError";
  }
}

/**
 * Parses a Reddit Atom feed into posts, preserving the feed's own ordering.
 *
 * The feed carries no score or comment count, so neither is produced here —
 * position in the list is the only ranking signal available.
 */
export function parseAtomFeed(xml: string, limit?: number): RedditPost[] {
  if (!xml || !xml.trim()) throw new AtomParseError("Feed body was empty.");

  let document: XmlNode;
  try {
    document = parser.parse(xml) as XmlNode;
  } catch (cause) {
    throw new AtomParseError(`Feed was not well-formed XML: ${(cause as Error).message}`);
  }

  const feed = document.feed as XmlNode | undefined;
  if (!feed) throw new AtomParseError("Feed did not contain an Atom <feed> element.");

  const posts = asArray(feed.entry as XmlNode | XmlNode[])
    .map(entryToPost)
    .filter((post): post is RedditPost => post !== null);

  return typeof limit === "number" ? posts.slice(0, limit) : posts;
}
