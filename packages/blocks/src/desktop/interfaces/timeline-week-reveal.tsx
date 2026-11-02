import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** How many week days are scrolled out of view on either side. */
export interface HiddenDays {
	after: number;
	before: number;
}

/** Whether the week grid lays its days out right to left. */
function isRightToLeft(scroller: HTMLElement): boolean {
	const view = scroller.ownerDocument.defaultView;
	return view?.getComputedStyle(scroller).direction === "rtl";
}

/**
 * Counts the day headings cut off at either inline edge of the scroller. The
 * sticky gutter sits on the start edge, so the oldest days hide behind it:
 * the left in a left-to-right UI and the right in a right-to-left one.
 */
export function countHiddenDays(
	scroller: HTMLElement,
	gutterWidth: number
): HiddenDays {
	const rtl = isRightToLeft(scroller);
	const contentLeft =
		scroller.getBoundingClientRect().left + scroller.clientLeft;
	const contentRight = contentLeft + scroller.clientWidth;
	let before = 0;
	let after = 0;
	for (const heading of scroller.querySelectorAll<HTMLElement>(
		"[data-week-day-heading]"
	)) {
		// A day counts as hidden once any of it is cut off.
		const rect = heading.getBoundingClientRect();
		const pastStart = rtl
			? rect.right > contentRight - gutterWidth + 1
			: rect.left < contentLeft + gutterWidth - 1;
		const pastEnd = rtl
			? rect.left < contentLeft - 1
			: rect.right > contentRight + 1;
		if (pastStart) {
			before += 1;
		} else if (pastEnd) {
			after += 1;
		}
	}
	return { after, before };
}

/**
 * Scrolls the week to its oldest (start) or newest (end) days. A right-to-left
 * scroller counts `scrollLeft` from 0 at its start edge down to negative values.
 */
export function scrollWeekTo(scroller: HTMLElement, side: "before" | "after") {
	if (side === "before") {
		scroller.scrollLeft = 0;
		return;
	}
	scroller.scrollLeft = isRightToLeft(scroller)
		? -scroller.scrollWidth
		: scroller.scrollWidth;
}

/** The week gutter's buttons that scroll hidden days back into view. */
export function TimelineWeekReveal({
	hidden,
	onReveal,
}: {
	hidden: HiddenDays;
	onReveal: (side: "before" | "after") => void;
}) {
	const tl = useLiteralMessages();
	return (
		<>
			{hidden.before > 0 ? (
				<Button
					aria-label={tl(
						"Show {dayCount, plural, one {# day} other {# days}} earlier",
						{ dayCount: hidden.before }
					)}
					className="px-1.5 tabular-nums"
					onClick={() => onReveal("before")}
					size="xs"
					title={tl("{dayCount, plural, one {# day} other {# days}} earlier", {
						dayCount: hidden.before,
					})}
					type="button"
					variant="ghost-muted"
				>
					<ChevronLeft
						aria-hidden="true"
						className="rtl:-scale-x-100"
						data-icon="inline-start"
					/>
					{hidden.before}
				</Button>
			) : null}
			{hidden.after > 0 ? (
				<Button
					aria-label={tl(
						"Show {dayCount, plural, one {# day} other {# days}} later",
						{ dayCount: hidden.after }
					)}
					className="px-1.5 tabular-nums"
					onClick={() => onReveal("after")}
					size="xs"
					title={tl("{dayCount, plural, one {# day} other {# days}} later", {
						dayCount: hidden.after,
					})}
					type="button"
					variant="ghost-muted"
				>
					{hidden.after}
					<ChevronRight
						aria-hidden="true"
						className="rtl:-scale-x-100"
						data-icon="inline-end"
					/>
				</Button>
			) : null}
		</>
	);
}
