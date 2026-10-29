/**
 * Folding a resumed turn back into the assistant message it continues.
 *
 * Extracted from the chat page purely so it can be tested: the bug class this
 * guards against — a reconnect that wrote `parts` wholesale from a partial
 * stream, deleting every tool row, Thinking trace and stats part of a turn it
 * had merely RECONNECTED to — is invisible until you reload a chat that was
 * resumed.
 */

import type { NativeSdkValue } from "./utils/native-sdk-observation.ts";

/**
 * Fold a resumed turn's reconstructed message into the assistant message it
 * continues.
 *
 * Core's resume stream replays the running turn from its first chunk, so the
 * reconstructed `parts` are the whole turn so far and REPLACE the persisted ones
 * (which lag by up to one checkpoint). Without a replay (`replayed: false`) they
 * cover only frames after reattaching, so they are appended instead.
 *
 * Either way the message keeps its id, role and server metadata, and
 * `_interrupted` is cleared: the history mapper stamps that flag on a turn Core
 * recorded as cut off (`apps/desktop/src/lib/chat-history-hydrate.ts`), and the
 * transcript draws it as an "Interrupted — this reply was cut off" marker under
 * the turn. A live reattach is proof the turn is running again, so leaving the
 * flag on parks a crash notice underneath a reply that is still streaming.
 */
export function mergeResumedTurnMessage<T extends { parts?: NativeSdkValue[] }>(
	message: T,
	resumedParts: NativeSdkValue[],
	replayed: boolean
) {
	return {
		...message,
		_interrupted: false,
		parts: replayed
			? resumedParts
			: [...(message.parts ?? []), ...resumedParts],
	};
}
