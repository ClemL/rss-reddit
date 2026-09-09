import { describe, expect, it } from "vitest";

import { absoluteTime, displayHost, relativeTime } from "@/lib/time";

const now = Date.parse("2026-09-09T12:00:00.000Z");

function ago(seconds: number): string {
  return new Date(now - seconds * 1000).toISOString();
}

describe("relativeTime", () => {
  it("formats each unit compactly", () => {
    expect(relativeTime(ago(5), now)).toBe("just now");
    expect(relativeTime(ago(59), now)).toBe("just now");
    expect(relativeTime(ago(60), now)).toBe("1m ago");
    expect(relativeTime(ago(42 * 60), now)).toBe("42m ago");
    expect(relativeTime(ago(3 * 3600), now)).toBe("3h ago");
    expect(relativeTime(ago(6 * 86400), now)).toBe("6d ago");
    expect(relativeTime(ago(70 * 86400), now)).toBe("2mo ago");
    expect(relativeTime(ago(400 * 86400), now)).toBe("1y ago");
  });

  it("does not produce negative durations for clock skew", () => {
    expect(relativeTime(new Date(now + 30_000).toISOString(), now)).toBe("just now");
  });

  it("degrades safely on an unparseable timestamp", () => {
    expect(relativeTime("not a date", now)).toBe("unknown");
    expect(absoluteTime("not a date")).toBe("");
  });
});

describe("displayHost", () => {
  it("strips the www prefix", () => {
    expect(displayHost("https://www.example.com/a/b")).toBe("example.com");
    expect(displayHost("https://blog.example.co.uk/x")).toBe("blog.example.co.uk");
  });

  it("returns null for a non-URL", () => {
    expect(displayHost("nonsense")).toBeNull();
  });
});
