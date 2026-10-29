import type { UIMessage } from "ai";
import type { Message } from "@/types/chat.ts";

/**
 * Turning a persisted history row into the message the chat surface renders.
 *
 * Lives on its own (rather than inside ChatPage) because it is the ONE place the
 * "this turn was cut off" rule is applied, and because ChatPage has four separate
 * hydration paths that must not drift apart again — mount, tab re-activation,
 * end-of-resumed-stream, and version select. When two of them disagreed, the
 * interruption marker was dropped every time a tab was reopened.
 */

/** A message was left "running" this long ago ⇒ nothing is coming. Only used by
 * the legacy fallback below; new rows carry a server-side flag instead. */
const STALE_THRESHOLD_MS = 30_000;

// There is no INTERRUPTED_NOTE any more. A turn the node died in the middle of
// used to get "⚠️ Interrupted — this reply was cut off before it finished."
// APPENDED as a trailing text part, i.e. an emoji sentence spliced into the
// model's own prose. It is now the `_interrupted` flag below, which the
// transcript renders as a `Marker` under the turn (message-list.tsx). Same
// information, but it is metadata again: it cannot be copied out with the reply,
// cannot be mistaken for something the agent said, and does not have to be
// pattern-matched back out when the turn resumes.

/** The subset of a loaded history message this mapper reads. */
export interface HistoryRow extends Omit<Message, "timestamp"> {
	/** Server-stamped: Core's boot reconciliation found this turn's run had never
	 * finished, so its text/parts are only what had been flushed. */
	interrupted?: boolean;
	timestamp?: number;
}

export interface HydratedMessage extends UIMessage {
	_interrupted?: boolean;
	originServer?: string;
	persisted?: boolean;
	source?: string;
	widgetInstanceId?: string;
}

/**
 * Map one persisted row to AI SDK `parts`.
 *
 * Structured `parts` win when Core has them (tool rows, reasoning, media survive
 * a reload); otherwise a single text part is built from `content`.
 *
 * Interruption is server-stamped. The old client-side heuristic — assistant, no
 * parts, blank content, older than `STALE_THRESHOLD_MS` — is kept ONLY as the
 * fallback for rows written before that column existed: it can only ever see a
 * turn that saved NOTHING, which is why a truncated-but-non-empty reply used to
 * render as a perfectly ordinary finished message.
 *
 * The flag DECORATES, never substitutes — whatever text did survive is still
 * worth reading, and the transcript draws the marker below it.
 */
export function hydrateHistoryMessage(
	m: HistoryRow,
	now: number
): HydratedMessage {
	const hasParts = Array.isArray(m.parts) && m.parts.length > 0;
	const msSinceUpdate =
		m.timestamp === undefined ? Number.POSITIVE_INFINITY : now - m.timestamp;
	const blankBody = !m.content || m.content.trim() === "";
	const legacyStaleRunning =
		m.role === "assistant" &&
		!hasParts &&
		blankBody &&
		msSinceUpdate > STALE_THRESHOLD_MS;
	const interrupted = m.interrupted === true || legacyStaleRunning;

	const body = hasParts
		? (m.parts ?? [])
		: [{ type: "text" as const, text: m.content }];
	// Client metadata cannot impersonate the server's verified author or storage state.
	const renderMetadata = Object.fromEntries(
		Object.entries(m.metadata ?? {}).filter(
			([key]) => key !== "author" && key !== "ryuPersisted"
		)
	);
	const message: HydratedMessage = {
		id: m.id,
		originServer: m.originServer,
		parts: interrupted && blankBody && !hasParts ? [] : body,
		persisted: m.persisted,
		role: m.role,
		source: m.source,
		widgetInstanceId: m.widgetInstanceId,
	};
	if (Object.keys(renderMetadata).length > 0 || m.author || m.persisted) {
		if (m.author) {
			renderMetadata.author = m.author;
		}
		if (m.persisted) {
			renderMetadata.ryuPersisted = true;
		}
		message.metadata = renderMetadata;
	}
	if (interrupted) {
		// The transcript draws this marker after the surviving message parts.
		message._interrupted = true;
	}
	return message;
}
