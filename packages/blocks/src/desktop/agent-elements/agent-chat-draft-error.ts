// The failed-request card's body, in the reader's language.
//
// A chat turn whose fetch never reached Core rejects with the browser's own
// English `TypeError` ("Failed to fetch", "Load failed", "NetworkError when
// attempting to fetch resource."). Relaying `error.message` put that English
// into an otherwise translated card, so a network failure becomes the shared
// translated sentence from `@ryu/i18n/error-text` instead.
//
// An error that carries Core's localized messages (`i18n`, the `AlertText`
// wire that `localizeCoreError` renders) passes them through unchanged, so the
// card shows Core's coded failure in the reader's locale. Anything else keeps
// its own message, as before.

import { isNetworkFailure, networkFailureText } from "@ryu/i18n/error-text";
import { useOptionalI18n } from "@ryu/i18n/react";
import { useMemo } from "react";

/** The message and optional Core messages for the synthetic error part. */
export interface ChatErrorDisplay {
	/** Core's `AlertText` wire, when the error carries one. */
	i18n?: unknown;
	message: string;
}

function coreMessages(error: Error): unknown {
	const wire = (error as Error & { i18n?: unknown }).i18n;
	return typeof wire === "object" && wire !== null ? wire : undefined;
}

/** What the failed-request card shows for `error`; undefined when there is none. */
export function chatErrorDisplay(
	error: Error | undefined
): ChatErrorDisplay | undefined {
	if (error === undefined) {
		return;
	}
	if (isNetworkFailure(error)) {
		return { message: networkFailureText() };
	}
	const i18n = coreMessages(error);
	return i18n === undefined
		? { message: error.message }
		: { i18n, message: error.message };
}

/**
 * `chatErrorDisplay`, kept stable while the error and locale are unchanged
 * (a fresh part on every render re-normalizes the whole transcript) and
 * re-translated when the reader switches language or a catalog arrives.
 */
export function useChatErrorDisplay(
	error: Error | undefined
): ChatErrorDisplay | undefined {
	const i18n = useOptionalI18n();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `i18n` changes with the locale and catalog version, which networkFailureText reads.
	return useMemo(() => chatErrorDisplay(error), [error, i18n]);
}
