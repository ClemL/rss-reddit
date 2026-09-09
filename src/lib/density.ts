/** Display densities offered by the density switch, loosest to tightest. */
export const DENSITIES = ["cozy", "compact", "dense"] as const;

export type Density = (typeof DENSITIES)[number];

export const DENSITY_STORAGE_KEY = "rss-reddit:density";

export function isDensity(value: unknown): value is Density {
  return typeof value === "string" && (DENSITIES as readonly string[]).includes(value);
}

/** Density applied when the reader has not chosen one. */
export const DEFAULT_DENSITY: Density = isDensity(process.env.NEXT_PUBLIC_DEFAULT_DENSITY)
  ? (process.env.NEXT_PUBLIC_DEFAULT_DENSITY as Density)
  : "cozy";

/**
 * Runs before first paint to apply the stored density, so the page never renders
 * at one density and then jumps to another. Kept tiny and dependency-free
 * because it is inlined into the document head.
 */
export const DENSITY_INIT_SCRIPT = `
(function(){try{
  var stored = localStorage.getItem(${JSON.stringify(DENSITY_STORAGE_KEY)});
  var allowed = ${JSON.stringify(DENSITIES)};
  document.documentElement.dataset.density =
    allowed.indexOf(stored) === -1 ? ${JSON.stringify(DEFAULT_DENSITY)} : stored;
}catch(e){
  document.documentElement.dataset.density = ${JSON.stringify(DEFAULT_DENSITY)};
}})();
`.trim();
