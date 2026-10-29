// Test-only helper. Not part of the package's public entry — nothing under
// `src/*.test.ts` imports it at runtime in a consumer build.

/**
 * The real `preconnect`, captured before any stub replaces `globalThis.fetch`.
 *
 * Bun's `fetch` is a callable that ALSO carries this property, so a bare arrow
 * function is not assignable to `typeof fetch`. Every stub in this package used
 * to paper over that with `as typeof fetch`, which is an unchecked assertion
 * across a genuinely missing member rather than a type-level no-op.
 */
const realPreconnect = globalThis.fetch.preconnect;

/** Replace `globalThis.fetch` with `impl`, keeping the real `preconnect`. */
export function installFetch(
	impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
	globalThis.fetch = Object.assign(impl, { preconnect: realPreconnect });
}
