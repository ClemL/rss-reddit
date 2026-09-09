"use client";

import { useEffect, useState } from "react";

import { DENSITIES, DENSITY_STORAGE_KEY, isDensity, type Density } from "@/lib/density";

const LABELS: Record<Density, string> = {
  cozy: "Cozy",
  compact: "Compact",
  dense: "Dense",
};

const HINTS: Record<Density, string> = {
  cozy: "Roomy cards with excerpts",
  compact: "Tighter rows, shorter excerpts",
  dense: "Link list, no excerpts",
};

function apply(density: Density): void {
  document.documentElement.dataset.density = density;
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    // Private browsing or blocked storage: the choice still applies this visit.
  }
}

/**
 * Display-density switch.
 *
 * The value lives in localStorage rather than the URL because it is a per-reader
 * preference, not part of what the page is showing. The server always renders
 * the default, and an inline script in the layout applies the stored value
 * before paint; this component starts from whatever that script set, so there is
 * no hydration mismatch and no flash.
 */
export function DensityToggle() {
  const [density, setDensity] = useState<Density>("cozy");

  useEffect(() => {
    const current = document.documentElement.dataset.density;
    if (isDensity(current)) setDensity(current);
  }, []);

  return (
    <div
      role="group"
      aria-label="Display density"
      className="inline-flex overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700"
    >
      {DENSITIES.map((option) => {
        const active = option === density;
        return (
          <button
            key={option}
            type="button"
            title={HINTS[option]}
            aria-pressed={active}
            onClick={() => {
              setDensity(option);
              apply(option);
            }}
            className={`px-2 py-1 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-500 ${
              active
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "bg-white text-neutral-600 hover:bg-neutral-100 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800"
            }`}
          >
            {LABELS[option]}
          </button>
        );
      })}
    </div>
  );
}
