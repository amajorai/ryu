// packages/blocks/src/desktop/agent-elements/date-separator.tsx
//
// The centred "Today" / "Yesterday" / "12 March 2026" row that opens each day in
// the transcript.
//
// It is a `Marker` (`@ryu/ui/components/marker`, `variant="separator"`), which is
// THE single inline-state row style in the transcript — day boundaries,
// interrupted turns, threshold failover and history notices all draw as one. The
// pill that used to live here moved to floating-date-header.tsx, its only
// remaining consumer: in flow the hairlines read better than a chip, and the
// chip's `bg-background/80 backdrop-blur-sm` only ever existed so the FLOATING
// copy stayed legible over live transcript text. The label itself cannot drift —
// both sites call `dayLabel()` from date-groups.ts.

import { Marker, MarkerContent } from "@ryu/ui/components/marker";
import { cn } from "@ryu/ui/lib/utils";
import { memo } from "react";

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
 * `Marker` satisfies both — it renders a bare `<div>` through `useRender` with no
 * wrapper of its own, and `data-slot` passed as a prop wins over the primitive's
 * own `state.slot` (`mergeObjects(stateProps, resolvedProps)`), so the e2e
 * selector below is preserved. `chat-date-groups-story.spec.ts:111-122` asserts
 * exactly this shape and must keep passing untouched.
 *
 * It must also stay a DIRECT child of the scroller's Content (the element with
 * `data-slot="message-scroller-content"`): the transcript's follow logic and the
 * date-groups spec both treat it as a plain sibling of the turn rows, never as
 * part of one. Interleave, never wrap.
 */
export const DateSeparator = memo(function DateSeparator({
	className,
	label,
}: {
	className?: string;
	label: string;
}) {
	return (
		<Marker
			// Content is `gap-0` (see message-list.tsx): all vertical rhythm between
			// its direct children is explicit top margins, so a run of grouped user
			// messages can sit tighter than the 8px everything else uses. `mt-2`
			// here reproduces the old `gap-2` above the separator, and the turn
			// below it brings its own `mt-2` — so the pair around a day boundary is
			// unchanged at 8px/8px. Tune breathing room with `py-*`, never by
			// widening a gap that would also push every turn apart.
			className={cn("mt-2 shrink-0", className)}
			data-slot="chat-date-separator"
			spacing="turn"
			variant="separator"
		>
			<MarkerContent className="select-none">
				<span className="type-caption font-medium">{label}</span>
			</MarkerContent>
		</Marker>
	);
});
