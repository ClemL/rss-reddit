import { describe, expect, it } from "vitest";

import {
  InvalidSourceError,
  parseFeedSource,
  parseFeedSourceOrDefault,
  shortLabel,
} from "@/lib/source";

describe("parseFeedSource", () => {
  it("parses a bare subreddit name", () => {
    const source = parseFeedSource("programming");
    expect(source).toMatchObject({ kind: "subreddit", path: "r/programming", label: "r/programming" });
  });

  it("accepts an r/ prefix, a full URL, and old.reddit.com", () => {
    for (const input of [
      "r/programming",
      "/r/programming/",
      "https://www.reddit.com/r/programming/",
      "https://old.reddit.com/r/programming",
      "https://www.reddit.com/r/programming/top/.rss",
    ]) {
      expect(parseFeedSource(input).path, input).toBe("r/programming");
    }
  });

  it("combines several subreddits with +", () => {
    const source = parseFeedSource("programming+rust+golang");
    expect(source.kind).toBe("combined");
    expect(source.path).toBe("r/programming+rust+golang");
    expect(source.subreddits).toEqual(["programming", "rust", "golang"]);
    // The cache key must stay distinct per combination.
    expect(source.key).toBe("programming_rust_golang");
  });

  it("parses a public multireddit in both u/ and user/ forms", () => {
    for (const input of [
      "user/cdawgg/m/tech",
      "u/cdawgg/m/tech",
      "https://old.reddit.com/user/cdawgg/m/tech/",
    ]) {
      const source = parseFeedSource(input);
      expect(source.kind, input).toBe("multireddit");
      expect(source.path, input).toBe("user/cdawgg/m/tech");
      expect(source.label, input).toBe("u/cdawgg/m/tech");
    }
  });

  it("rejects a bare user profile with an explanation", () => {
    const attempt = () => parseFeedSource("https://old.reddit.com/user/cdawgg/");
    expect(attempt).toThrow(InvalidSourceError);
    expect(attempt).toThrow(/subscription lists private/i);
    expect(attempt).toThrow(/multireddit/i);
  });

  it("rejects names that could inject path or query segments", () => {
    for (const bad of [
      "programming/../secret",
      "programming?limit=100",
      "programming#x",
      "../../etc",
      "a",
      "",
      "   ",
      "programming+not a name",
    ]) {
      expect(() => parseFeedSource(bad), bad).toThrow(InvalidSourceError);
    }
  });

  it("tolerates a stray separator rather than failing on a typo", () => {
    // Harmless: empty segments are dropped, so nothing can be injected.
    expect(parseFeedSource("programming+").path).toBe("r/programming");
    expect(parseFeedSource("+programming").path).toBe("r/programming");
    expect(parseFeedSource("rust++golang").path).toBe("r/rust+golang");
  });

  it("falls back to r/programming instead of throwing", () => {
    expect(parseFeedSourceOrDefault(undefined).path).toBe("r/programming");
    expect(parseFeedSourceOrDefault("!!!").path).toBe("r/programming");
    expect(parseFeedSourceOrDefault("rust").path).toBe("r/rust");
  });
});

describe("shortLabel", () => {
  it("summarizes a long combination", () => {
    expect(shortLabel(parseFeedSource("a1+b2+c3+d4+e5"))).toBe("r/a1+b2+c3 +2");
  });

  it("leaves short sources alone", () => {
    expect(shortLabel(parseFeedSource("programming"))).toBe("r/programming");
    expect(shortLabel(parseFeedSource("u/cdawgg/m/tech"))).toBe("u/cdawgg/m/tech");
  });
});
