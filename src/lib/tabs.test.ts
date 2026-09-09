import { describe, expect, it } from "vitest";

import { findTab, resolveTabs, toTabId } from "@/lib/tabs";

describe("resolveTabs", () => {
  it("returns the default topic tabs when nothing is configured", () => {
    const tabs = resolveTabs({});
    expect(tabs.length).toBeGreaterThan(1);
    expect(tabs.map((tab) => tab.id)).toContain("dev");
    expect(tabs.map((tab) => tab.id)).toContain("cloud-it");
  });

  it("covers every configured subreddit exactly once across the defaults", () => {
    const all = resolveTabs({}).flatMap((tab) => tab.source.subreddits);
    expect(all.length).toBe(69);
    expect(new Set(all).size).toBe(69);
  });

  it("collapses to a single tab when only SUBREDDIT is set", () => {
    const tabs = resolveTabs({ SUBREDDIT: "rust" });
    expect(tabs).toHaveLength(1);
    expect(tabs[0].source.path).toBe("r/rust");
    expect(tabs[0].label).toBe("r/rust");
  });

  it("parses FEED_TABS, which takes precedence over SUBREDDIT", () => {
    const tabs = resolveTabs({
      FEED_TABS: "Dev=programming+rust; Local = boston+mbta ",
      SUBREDDIT: "ignored",
    });
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toMatchObject({ id: "dev", label: "Dev" });
    expect(tabs[0].source.path).toBe("r/programming+rust");
    expect(tabs[1]).toMatchObject({ id: "local", label: "Local" });
  });

  it("accepts a bare group with no label", () => {
    const tabs = resolveTabs({ FEED_TABS: "programming" });
    expect(tabs).toHaveLength(1);
    expect(tabs[0].source.path).toBe("r/programming");
  });

  it("skips a malformed group instead of failing the deployment", () => {
    const tabs = resolveTabs({ FEED_TABS: "Good=programming;Bad=../etc;Also=rust" });
    expect(tabs.map((tab) => tab.id)).toEqual(["good", "also"]);
  });

  it("falls back to the defaults when every group is malformed", () => {
    expect(resolveTabs({ FEED_TABS: "Bad=../etc" }).length).toBeGreaterThan(1);
  });

  it("gives colliding labels distinct ids", () => {
    const tabs = resolveTabs({ FEED_TABS: "A B=programming;A-B=rust" });
    expect(tabs.map((tab) => tab.id)).toEqual(["a-b", "a-b-2"]);
  });

  it("supports a multireddit as a tab", () => {
    const tabs = resolveTabs({ FEED_TABS: "Mine=user/cdawgg/m/tech" });
    expect(tabs[0].source.kind).toBe("multireddit");
    expect(tabs[0].source.path).toBe("user/cdawgg/m/tech");
  });

  it("gives each default tab a distinct cache key", () => {
    const keys = resolveTabs({}).map((tab) => tab.source.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("findTab", () => {
  const tabs = resolveTabs({ FEED_TABS: "Dev=programming;Local=boston" });

  it("finds by id, case-insensitively", () => {
    expect(findTab(tabs, "local").id).toBe("local");
    expect(findTab(tabs, "LOCAL").id).toBe("local");
  });

  it("falls back to the first tab for anything unrecognized", () => {
    for (const bad of ["nope", "", undefined, null, 42, ["local"]]) {
      expect(findTab(tabs, bad).id, String(bad)).toBe("dev");
    }
  });
});

describe("toTabId", () => {
  it("slugifies labels", () => {
    expect(toTabId("Cloud & IT")).toBe("cloud-it");
    expect(toTabId("Tech & Fun")).toBe("tech-fun");
    expect(toTabId("!!!")).toBe("tab");
  });
});
