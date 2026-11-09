import type { LiteralMessage } from "@ryu/i18n/react";

// Core's Reflect projection (`apps/core/src/server/memory_reflect.rs`) and the
// desktop's usage-review fallback (`lib/api/memory.ts`) send the activity tile
// labels and each topic's message count as English data. Recognise those exact
// values here and render the reader's language; anything else passes through.

const REFLECT_ACTIVITY_LABELS: Readonly<
	Record<string, (tl: LiteralMessage) => string>
> = {
	Activity: (tl) => tl("Activity"),
	"Active days": (tl) => tl("Active days"),
	"Activity events": (tl) => tl("Activity events"),
	Conversations: (tl) => tl("Conversations"),
	Messages: (tl) => tl("Messages"),
};

/** A Reflect activity tile label in the reader's language. */
export function reflectActivityLabel(raw: string, tl: LiteralMessage): string {
	const label = Object.hasOwn(REFLECT_ACTIVITY_LABELS, raw)
		? REFLECT_ACTIVITY_LABELS[raw]
		: undefined;
	return label ? label(tl) : raw;
}

const TOPIC_MESSAGE_COUNT = /^(\d+) messages?$/;

/**
 * A topic's summary line. Core and the fallback send "N messages" (even for
 * one), so that shape is re-rendered as a localized plural; any other summary
 * is passed through unchanged.
 */
export function topicSummaryText(raw: string, tl: LiteralMessage): string {
	const match = TOPIC_MESSAGE_COUNT.exec(raw.trim());
	if (!match) {
		return raw;
	}
	const count = Number(match[1]);
	return tl("{count, plural, one {# message} other {# messages}}", { count });
}
