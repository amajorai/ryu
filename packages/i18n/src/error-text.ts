// Browser network failures, in the reader's language.
//
// A `fetch()` that never reaches the server rejects with a `TypeError` whose
// message is the browser's own English ("Failed to fetch" in Chromium, "Load
// failed" in Safari, "NetworkError when attempting to fetch resource." in
// Firefox). Screens that relay `error.message` showed that English to every
// reader. Shared fetch wrappers pass the rejection through
// `rethrowNetworkFailure` so the message becomes one translated sentence; the
// browser's error stays on `cause` for logs and the console.

import { translate as tl } from "./active-locale.ts";

/** The `TypeError` messages browsers give a fetch that got no response. */
const NETWORK_FAILURE_MESSAGES = new Set([
	"failed to fetch",
	"load failed",
	"networkerror when attempting to fetch resource.",
	"network request failed",
]);

/** Whether `error` is a browser fetch that never reached the server. */
export function isNetworkFailure(error: unknown): boolean {
	if (!(error instanceof Error) || error.name !== "TypeError") {
		return false;
	}
	return NETWORK_FAILURE_MESSAGES.has(error.message.trim().toLowerCase());
}

/** The translated sentence shown when the server could not be reached. */
export function networkFailureText(): string {
	return tl("Couldn't reach the server. Check your connection and try again.");
}

/**
 * `error`, or a translated `Error` in its place when it is a network failure.
 * The original error stays on `cause`.
 */
export function normalizeNetworkError(error: unknown): unknown {
	if (!isNetworkFailure(error)) {
		return error;
	}
	return new Error(networkFailureText(), { cause: error });
}

/**
 * Rethrow a fetch rejection, translated when it is a network failure:
 * `await fetch(url, init).catch(rethrowNetworkFailure)`.
 */
export function rethrowNetworkFailure(error: unknown): never {
	throw normalizeNetworkError(error);
}

/**
 * The text to show for a caught error: the translated network sentence, the
 * error's own message, or `fallback` when the thrown value is not an `Error`.
 */
export function errorText(error: unknown, fallback: string): string {
	if (isNetworkFailure(error)) {
		return networkFailureText();
	}
	return error instanceof Error && error.message ? error.message : fallback;
}
