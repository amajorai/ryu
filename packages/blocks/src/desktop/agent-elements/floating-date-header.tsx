// packages/blocks/src/desktop/agent-elements/floating-date-header.tsx
//
// The floating date pill that names the day you are currently reading, the way
// WhatsApp and Telegram do — but only once that day's own inline divider has
// scrolled out of view, so the two never echo each other on screen.

import { memo, type RefObject, useEffect, useState } from "react";
import { dayLabel } from "./date-groups.ts";
import { DATE_SEPARATOR_SLOT } from "./date-separator.tsx";

/**
 * The day key of the last inline divider that sits wholly ABOVE the viewport,
 * i.e. the divider of the day the topmost visible turn belongs to — or `null`
 * while that divider is still on screen (or there is none above at all).
 *
 * Dividers interleave with the turns in document order, so "the last divider
 * above the top edge" is exactly "the day being read at the top". The state is
 * driven by an IntersectionObserver on the dividers alone: its callback fires
 * only when a divider crosses the viewport's TOP edge, never per scroll frame,
 * and it does no layout reads of its own.
 */
function useDayAboveViewport(
	viewportRef: RefObject<HTMLElement | null>,
	dividersKey: string
): string | null {
	const [dayKey, setDayKey] = useState<string | null>(null);

	useEffect(() => {
		const viewport = viewportRef.current;
		if (
			!(viewport && dividersKey && typeof IntersectionObserver === "function")
		) {
			setDayKey(null);
			return;
		}
		// The dividers render in the same commit as the groups that produce them,
		// and `dividersKey` names each divider's day AND the row carrying it, so
		// re-collecting whenever it changes never leaves a detached node observed.
		const dividers = Array.from(
			viewport.querySelectorAll<HTMLElement>(
				`[data-slot="${DATE_SEPARATOR_SLOT}"][data-day-key]`
			)
		);
		const aboveTop = new WeakMap<Element, boolean>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					// The root extends (effectively) forever downward, so a divider
					// is outside it only when it lies wholly above the top edge.
					aboveTop.set(entry.target, !entry.isIntersecting);
				}
				let next: string | null = null;
				for (const divider of dividers) {
					if (aboveTop.get(divider)) {
						next = divider.getAttribute("data-day-key");
					}
				}
				setDayKey(next);
			},
			// A plain viewport root would miss a jump that carries a divider from
			// above the fold straight to below it (both "not intersecting", so no
			// notification). Stretching the root's bottom edge makes "above the
			// top" the ONLY way out, so every crossing of the top edge reports.
			{ root: viewport, rootMargin: "0px 0px 1000000px 0px", threshold: 0 }
		);
		for (const divider of dividers) {
			observer.observe(divider);
		}
		return () => observer.disconnect();
	}, [dividersKey, viewportRef]);

	return dayKey;
}

/**
 * OUT OF FLOW BY CONSTRUCTION — this is the whole design.
 *
 * Mounted as a direct child of the MessageScroller ROOT (which is `relative`),
 * a sibling of the viewport. `absolute` + `pointer-events-none` means it
 * occupies no space and intercepts no input, so it CANNOT move a scroll anchor.
 *
 * That is not a nicety. The pinned-user-message bar next door sits IN FLOW, and
 * mounting it pushes every anchor below it down — which is why
 * use-pinned-user-message.ts needs `PIN_RELEASE_SLACK` hysteresis and a
 * RAF-deferred first measurement, the fix for the React #185 update loop. A
 * second in-flow element whose visibility is driven by scroll position would
 * reintroduce exactly that loop. Keep this absolute.
 *
 * Visibility rules:
 *  - hidden while the reader rests at the live edge (`atRest`): the newest day
 *    is the one they are reading, and the transcript stays chrome-free;
 *  - hidden while the topmost visible day's own divider is still on screen, so
 *    the pill never duplicates a label the reader can already see;
 *  - otherwise a quiet `text-xs` muted pill just below the top edge, inside the
 *    fixed lane above the pinned-user-message bar (`top-9` on the bar).
 */
export const FloatingDateHeader = memo(function FloatingDateHeader({
	atRest,
	dividersKey,
	startOfToday,
	viewportRef,
}: {
	/** True while the reader follows the live edge (nothing scrolled up). */
	atRest: boolean;
	/** Identity of the rendered day dividers (`dayDividersKey`). */
	dividersKey: string;
	/** Midnight today in the display zone; recomputed when the zone changes. */
	startOfToday: number;
	/** The scroller viewport the dividers scroll inside. */
	viewportRef: RefObject<HTMLElement | null>;
}) {
	const dayKey = useDayAboveViewport(viewportRef, dividersKey);
	if (atRest || dayKey === null) {
		return null;
	}

	return (
		// Keeping this offset independent of the bar's measured height means
		// toggling the pin preference cannot make the date pill jump.
		<div
			// The in-flow divider already announces the date to assistive tech;
			// this is the visual echo of it, so it is hidden from the a11y tree.
			aria-hidden="true"
			className="pointer-events-none absolute inset-x-0 top-1.5 z-30 flex justify-center"
			data-slot="chat-floating-date"
		>
			{/* It floats over the transcript, so it needs a surface to stay legible:
			    a hairline pill on the page tone, never a shadowed badge. */}
			<span
				className="motion-safe:fade-in-0 select-none rounded-full border border-border bg-background px-2.5 py-0.5 text-muted-foreground text-xs motion-safe:animate-in motion-safe:duration-150"
				data-slot="chat-date-chip"
			>
				{dayLabel(dayKey, startOfToday)}
			</span>
		</div>
	);
});
