// Dependency-free so the sandboxed Island preload can import it at runtime
// (see `preload/sandbox.test.ts`); the reply is validated by
// `parseSystemLanguages` in `language-selection.ts`.

/**
 * Island renderer → main: the OS's preferred languages as the main process
 * reads them (`app.getPreferredSystemLanguages()`). The renderer's own
 * `navigator.languages` is Chromium's accept-language list, which can stop at an
 * OS language Ryu has no pack for.
 */
export const SYSTEM_LANGUAGES_CHANNEL = "language-packs:system-languages";
