import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AtomParseError, parseAtomFeed } from "@/lib/atom";

function fixture(name: string): string {
  return readFileSync(join(__dirname, "__fixtures__", name), "utf8");
}

const feed = fixture("programming-top-day.atom.xml");

describe("parseAtomFeed", () => {
  it("preserves the feed's own ordering", () => {
    const posts = parseAtomFeed(feed);
    expect(posts.map((post) => post.id)).toEqual([
      "t3_aaa111",
      "t3_bbb222",
      "t3_ccc333",
      "t3_ddd444",
    ]);
  });

  it("points a link post's url at the external [link] target", () => {
    const [post] = parseAtomFeed(feed);
    expect(post.url).toBe("https://blog.example.com/why-types-matter");
    expect(post.permalink).toBe(
      "https://www.reddit.com/r/programming/comments/aaa111/why_types_matter/",
    );
    expect(post.isSelfPost).toBe(false);
    expect(post.excerpt).toBe("");
  });

  it("decodes titles and author metadata", () => {
    const [post] = parseAtomFeed(feed);
    expect(post.title).toBe("Why types matter more than you think");
    expect(post.author).toBe("/u/linkposter");
    expect(post.authorUrl).toBe("https://www.reddit.com/user/linkposter");
    expect(post.publishedAt).toBe("2026-09-09T09:30:00.000Z");
  });

  it("marks a self post and extracts a plain-text excerpt", () => {
    const post = parseAtomFeed(feed)[1];
    expect(post.isSelfPost).toBe(true);
    expect(post.url).toBe(post.permalink);
    expect(post.excerpt).toContain("rewriting our build pipeline in Rust & the results");
    expect(post.excerpt).toContain("11 minutes to 90 seconds");
    // The submission footer must not leak into the excerpt.
    expect(post.excerpt).not.toContain("[link]");
    expect(post.excerpt).not.toContain("submitted by");
    // Markup is stripped, but entities the author typed stay literal text —
    // "&lt;three&gt;" is prose, not a tag, and React escapes it on render.
    expect(post.excerpt).not.toMatch(/<\/?(div|p|br|a|span|table)\b/i);
    expect(post.excerpt).toContain("<three>");
  });

  it("keeps a numeric title as a string", () => {
    const post = parseAtomFeed(feed)[2];
    expect(post.title).toBe("2038");
    expect(typeof post.title).toBe("string");
  });

  it("falls back to the permalink when no [link] anchor is present", () => {
    const post = parseAtomFeed(feed)[3];
    expect(post.url).toBe(post.permalink);
    expect(post.isSelfPost).toBe(true);
  });

  it("applies the post limit", () => {
    expect(parseAtomFeed(feed, 2)).toHaveLength(2);
    expect(parseAtomFeed(feed, 99)).toHaveLength(4);
  });

  it("handles a feed containing exactly one entry", () => {
    const posts = parseAtomFeed(fixture("single-entry.atom.xml"));
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://example.net/only");
  });

  it("never reports a score or a comment count", () => {
    for (const post of parseAtomFeed(feed)) {
      expect(post).not.toHaveProperty("score");
      expect(post).not.toHaveProperty("commentCount");
    }
  });

  it("rejects empty and non-Atom input", () => {
    expect(() => parseAtomFeed("")).toThrow(AtomParseError);
    expect(() => parseAtomFeed("   ")).toThrow(AtomParseError);
    expect(() => parseAtomFeed("<html><body>blocked</body></html>")).toThrow(AtomParseError);
  });

  it("returns an empty list for a well-formed feed with no entries", () => {
    const empty = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>';
    expect(parseAtomFeed(empty)).toEqual([]);
  });
});
