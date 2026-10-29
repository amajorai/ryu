// packages/services/src/version.ts
//
// The SDK's own version, sent in the server-runtime User-Agent, and the
// version published to npm. `exports-lockstep.test.ts` keeps SDK_VERSION equal
// to package.json, and the docs guard requires the "not yet published" callout
// on every install command while NPM_PUBLISHED_VERSION is null.

/** This package's version (package.json `version`). */
export const SDK_VERSION = "0.1.0";

/**
 * The latest `@ryuhq/services` version on npm, or `null` while it is
 * unpublished. Flip this only in the release that publishes the package.
 */
export const NPM_PUBLISHED_VERSION: string | null = null;
