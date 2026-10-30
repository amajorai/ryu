/**
 * A per-message stamp is CLOCK TIME, with the full date in its tooltip — the
 * messaging shape, now that the DATE is carried by the day separators above
 * each run (date-separator.tsx) instead of being repeated on every row.
 *
 * Both go through `@ryu/ui/lib/timezone.ts`, so they follow Appearance →
 * "Date & time" like every other timestamp in the product. They replaced the
 * last two zone-naive formatters in the transcript: a hand-rolled "5m ago"
 * relative age and a hardcoded `en-GB` full stamp, neither of which could
 * follow the setting.
 *
 * Exported so the assistant header in message-list.tsx renders the identical
 * pair; two rows of the same turn showing different clock formats is exactly
 * the drift a shared constant prevents. (The import goes this way — message-list
 * already imports `UserMessage` from here, so the reverse would be a cycle.)
 */
export const MESSAGE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
	hour: "numeric",
	minute: "2-digit",
};

export const MESSAGE_TOOLTIP_OPTIONS: Intl.DateTimeFormatOptions = {
	dateStyle: "medium",
	timeStyle: "short",
};
