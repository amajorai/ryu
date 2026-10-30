// packages/blocks/src/desktop/agent-elements/date-separator.tsx
//
// The centred "Today" / "Yesterday" / "12 March 2026" row that opens each day in
// the transcript.
//
// A quiet centred caption (`text-xs`, tertiary muted, no rules). The floating
// pill lives in floating-date-header.tsx (shown only once this row scrolls away); both call `dayLabel()` from
// date-groups.ts, so the label cannot drift.

import { cn } from "@ryu/ui/lib/utils";
import { memo } from "react";

/** `data-slot` the floating date pill observes to know when a day scrolled away. */
export const DATE_SEPARATOR_SLOT = "chat-date-separator";

/**
 * One day boundary in the transcript.
 *
 * MOUNTED AS A PLAIN, SCROLLER-INVISIBLE ELEMENT, NOT AN ITEM ROW — do not
 * "consistency-fix" this. Two separate reasons, both load-bearing:
 *
 *  1. A scroller item carries `[content-visibility:auto]` with
 *     `[contain-intrinsic-size:auto_10rem]`, i.e. a 160px placeholder reserved
 *     for a ~40px row. Every separator would open a gap it never fills.
 *  2. An item that looked like a turn could be picked as the scroll target when
 *     new content arrives, so a new day would scroll the SEPARATOR to the top
 *     instead of the user's new question. No `messageId` and no anchor keeps it
 *     invisible to the scroller's follow logic: it is a bare row that only
 *     carries the day's label, exactly like the old `MessageScrollerItem`-less
 *     separator before it.
 *
 * A bare `<div>` satisfies both, and keeps the e2e selector below. `chat-date-groups-story.spec.ts:111-122` asserts
 * exactly this shape and must keep passing untouched.
 *
 * It must also stay a DIRECT child of the scroller's Content (the element with
 * `data-slot="message-scroller-content"`): the transcript's follow logic and the
 * date-groups spec both treat it as a plain sibling of the turn rows, never as
 * part of one. Interleave, never wrap.
 */
export const DateSeparator = memo(function DateSeparator({
	className,
	dayKey,
	label,
}: {
	className?: string;
	/** The day this divider opens; the floating pill reads it back. */
	dayKey?: string;
	label: string;
}) {
	return (
		// A centred caption with no rules: the day label is meta, so it takes the
		// tertiary muted tone and no hairlines compete with the transcript. Content
		// is `gap-0` (see message-list.tsx), so the top margin here is the only
		// space above the day boundary; the turn below brings its own.
		<div
			className={cn(
				"mt-6 flex shrink-0 select-none justify-center py-1 text-muted-foreground/70 text-xs",
				className
			)}
			data-day-key={dayKey}
			data-slot={DATE_SEPARATOR_SLOT}
		>
			<span>{label}</span>
		</div>
	);
});
