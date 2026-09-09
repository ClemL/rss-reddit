/**
 * Stand-in for the `server-only` package under vitest.
 *
 * The real module throws unless it is imported through a React Server Component
 * build, which would make every module that guards itself with it untestable.
 * Wired up in `vitest.config.ts`; it has no effect on the app build.
 */
export {};
