// packages/blocks/src/desktop/agent-elements/floating-date-header.tsx
//
// The sticky date chip that names the day you are currently reading, the way
// WhatsApp and Telegram do.

import { memo } from "react";
import { type DayGroup, dayKeyAtTurnIndex, dayLabel } from "./date-groups.ts";

/**
 * OUT OF FLOW BY CONSTRUCTION — this is the whole design.
 *
 * Mounted as a direct child of the MessageScroller ROOT (which is `relative`),
 * a sibling of the viewport, exactly where `ChatToc` lives. `absolute` +
 * `pointer-events-none` means it occupies no space and intercepts no input, so
 * it CANNOT move a scroll anchor.
 *
 * That is not a nicety. The pinned-user-message bar next door sits IN FLOW, and
 * mounting it pushes every anchor below it down — which is why
 * use-pinned-user-message.ts needs `PIN_RELEASE_SLACK` hysteresis and a
 * RAF-deferred first measurement, the fix for the React #185 update loop. A
 * second in-flow element whose visibility is driven by scroll position would
 * reintroduce exactly that loop. Keep this absolute.
 *
 * The state comes from a scroll-position read the message list owns and passes
 * down (`currentAnchorId`) — the anchor the transcript's user messages were
 * stamped with. This is a SECOND CONSUMER of the same single value the chat TOC
 * reads; no new observer, no new effect, no setState-in-effect, no layout reads
 * of our own.
 *
 * Known imprecision, shipped deliberately: the anchor flips ~`topOffset` px
 * BEFORE the separator reaches the top edge (same tolerance the TOC uses).
 */
export const FloatingDateHeader = memo(function FloatingDateHeader({
	groups,
	startOfToday,
	turnIndexByAnchorId,
	currentAnchorId,
}: {
	/** Day runs for the transcript, in turn order. */
	groups: readonly DayGroup[];
	/** Midnight today in the display zone; recomputed when the zone changes. */
	startOfToday: number;
	/** Anchor id (the turn's user-message id) → its flat turn index. */
	turnIndexByAnchorId: ReadonlyMap<string, number>;
	/** The user message currently at the top of the transcript, if any. */
	currentAnchorId?: string | null;
}) {
	// Nothing anchored yet (empty transcript, or a scroll position above the
	// first anchor) — say nothing rather than guess a date.
	if (groups.length === 0) {
		return null;
	}
	const turnIndex = currentAnchorId
		? turnIndexByAnchorId.get(currentAnchorId)
		: groups[0]?.startIndex;
	if (turnIndex === undefined) {
		return null;
	}
	// Resolved by CONTAINMENT, not by the anchor's own turn: only turns with a
	// user message are anchors (`scrollAnchor={Boolean(turn.userMsg)}`), so a
	// group that opens with an assistant-only turn is entered while the current
	// anchor still names a turn in the PREVIOUS group.
	const dayKey = dayKeyAtTurnIndex(groups, turnIndex);
	if (dayKey === null) {
		return null;
	}

	return (
		// The chip owns the fixed lane ABOVE the pinned-user-message bar. Keeping
		// this offset independent of the bar's measured height means toggling the
		// pin preference cannot make the date header jump.
		<div
			// The in-flow separator already announces the date to assistive tech;
			// this is the visual echo of it, so it is hidden from the a11y tree.
			aria-hidden="true"
			className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center"
			data-slot="chat-floating-date"
		>
			{/* Keep the floating echo as text only. It sits in a dedicated lane, so
			    it never needs a filled pill to stay legible; the pinned message below
			    is the only scroll chrome that gets a surface. */}
			<span
				className="select-none font-medium text-[11px] text-muted-foreground"
				data-slot="chat-date-chip"
			>
				{dayLabel(dayKey, startOfToday)}
			</span>
		</div>
	);
});
