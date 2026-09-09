import { parseFeedSource, type FeedSource } from "@/lib/source";

/**
 * Named groups of subreddits, each rendered as a tab and cached separately.
 *
 * Splitting a large subscription list into topic tabs is not only navigational.
 * Reddit returns roughly 25 entries per feed regardless of how many subreddits
 * are combined, so one listing of 69 subreddits is dominated by whichever few
 * are busiest and the quiet ones effectively never appear. Smaller groups give
 * each topic its own slice.
 */
export interface FeedTab {
  /** URL-safe identifier used in `?tab=`. */
  id: string;
  label: string;
  source: FeedSource;
}

interface TabDefinition {
  label: string;
  subreddits: string;
}

/**
 * Default tabs. Override with the `FEED_TABS` environment variable, or replace
 * this list outright — it is ordinary source, not configuration-by-magic.
 */
const DEFAULT_TAB_DEFINITIONS: TabDefinition[] = [
  {
    label: "Dev",
    subreddits:
      "programming+coding+csharp+dotnet+webdev+compsci+VisualStudio+ProgrammerTIL+AskProgramming",
  },
  { label: "Data", subreddits: "SQL+SQLServer+PowerShell" },
  {
    label: "Cloud & IT",
    subreddits:
      "AZURE+sysadmin+ITCareerQuestions+ITManagers+cto+ExperiencedDevs+windowsinsiders+iiiiiiitttttttttttt",
  },
  { label: "AI", subreddits: "Anthropic+ClaudeAI+ChatGPT" },
  {
    label: "Boston",
    subreddits:
      "boston+massachusetts+CambridgeMA+Somerville+medfordma+QuincyMa+mbta+MassachusettsPolitics",
  },
  { label: "World", subreddits: "news+worldnews+geopolitics+NeutralPolitics+economy+Economics" },
  {
    label: "Learn",
    subreddits:
      "askscience+explainlikeimfive+AskHistorians+history+AskSocialScience+todayilearned+YouShouldKnow+LifeProTips+educationalgifs+nonfictionbooks+BettermentBookClub+learners_cabin",
  },
  {
    label: "Culture",
    subreddits:
      "HobbyDrama+SubredditDrama+OutOfTheLoop+DepthHub+RedditForGrownups+changemyview+DeepThoughts+Stoicism+quotes+IAmA+ask",
  },
  {
    label: "Tech & Fun",
    subreddits:
      "ProgrammerHumor+softwaregore+apple+gadgets+buildapcsales+technology+InternetIsBeautiful+geographymemes+mealtimevideos",
  },
];

/** `Dev=programming+rust;Boston=boston+mbta` — labels may contain spaces. */
function parseTabDefinitions(raw: string): TabDefinition[] {
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      if (separator === -1) return { label: entry, subreddits: entry };
      return {
        label: entry.slice(0, separator).trim(),
        subreddits: entry.slice(separator + 1).trim(),
      };
    })
    .filter((definition) => definition.label && definition.subreddits);
}

export function toTabId(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tab"
  );
}

function buildTabs(definitions: TabDefinition[]): FeedTab[] {
  const tabs: FeedTab[] = [];
  const seen = new Set<string>();

  for (const definition of definitions) {
    let source: FeedSource;
    try {
      source = parseFeedSource(definition.subreddits);
    } catch {
      // Skip a malformed group rather than failing the whole deployment.
      continue;
    }

    let id = toTabId(definition.label);
    let suffix = 2;
    while (seen.has(id)) id = `${toTabId(definition.label)}-${suffix++}`;
    seen.add(id);

    tabs.push({ id, label: definition.label, source });
  }

  return tabs;
}

/**
 * Resolves the tab set. `FEED_TABS` wins; a lone `SUBREDDIT` produces a single
 * tab, which keeps single-subreddit deployments working unchanged; otherwise the
 * defaults above are used.
 */
export function resolveTabs(env: {
  FEED_TABS?: string;
  SUBREDDIT?: string;
}): FeedTab[] {
  const fromEnv = env.FEED_TABS?.trim();
  if (fromEnv) {
    const tabs = buildTabs(parseTabDefinitions(fromEnv));
    if (tabs.length > 0) return tabs;
  }

  const single = env.SUBREDDIT?.trim();
  if (single) {
    const tabs = buildTabs([{ label: single, subreddits: single }]);
    if (tabs.length > 0) {
      // Label a single tab by what it resolves to, not by the raw input.
      return tabs.map((tab) => ({ ...tab, label: tab.source.label }));
    }
  }

  return buildTabs(DEFAULT_TAB_DEFINITIONS);
}

export function findTab(tabs: FeedTab[], id: unknown): FeedTab {
  if (typeof id === "string") {
    const match = tabs.find((tab) => tab.id === id.trim().toLowerCase());
    if (match) return match;
  }
  return tabs[0];
}
