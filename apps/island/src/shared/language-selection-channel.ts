// Dependency-free so the sandboxed Island preload can import it at runtime
// (see `preload/sandbox.test.ts`); the contract lives in `language-selection.ts`.

/** Island renderer → main: save a language choice made in the Island picker. */
export const LANGUAGE_SELECTION_CHANNEL = "language-packs:select";
