import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { DEFAULT_COLUMN_PX, HOUR_PX, longDay } from "./calendar-model.ts";
import { ITEM_RADIUS_CLASS } from "./calendar-parts.tsx";

export const COLUMNS = "grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]";
/** The time gutter's width (3.5rem), left of the seven day columns. */
const GUTTER_PX = 56;
/** A day column's block area is inset this much (4px left, 8px right). */
const COLUMN_INSET_PX = 12;

/** The visible hours are tracked in steps this coarse, to keep scrolling cheap. */
const VIEW_STEP_MINUTES = 5;
/** An hour label within this many minutes of an edge would be cut: hide it. */
const LABEL_EDGE_MINUTES = 7;

/**
 * The scroll offset that opens a week on an hour: its line sits flush under
 * the header's rule (one pixel past it, so the two never double up), and
 * its label is left out, as the reference leaves out midnight's.
 */
export function hourOffset(minute: number): number {
	return minute > 0 ? (minute / 60) * HOUR_PX + 1 : 0;
}

/** Whether an hour line sits too close to the scrolled edges for its label. */
export function labelClipped(
	hour: number,
	range: VisibleMinutes | null
): boolean {
	if (!range) {
		return false;
	}
	const minute = hour * 60;
	return (
		Math.abs(minute - range.from) < LABEL_EDGE_MINUTES ||
		Math.abs(range.to - minute) < LABEL_EDGE_MINUTES
	);
}

interface VisibleMinutes {
	from: number;
	to: number;
}

/**
 * Which hours the week scroller shows, and how wide a day's block area is,
 * kept current on scroll and resize.
 */
export function useVisibleMinutes(scrollerRef: {
	current: HTMLDivElement | null;
}) {
	const [range, setRange] = useState<VisibleMinutes | null>(null);
	const [columnWidth, setColumnWidth] = useState(DEFAULT_COLUMN_PX);
	const refresh = useCallback(() => {
		const scroller = scrollerRef.current;
		if (!scroller || scroller.clientHeight === 0) {
			return;
		}
		const width = Math.floor(
			(scroller.clientWidth - GUTTER_PX) / 7 - COLUMN_INSET_PX
		);
		setColumnWidth((current) => (current === width ? current : width));
		const toMinutes = (px: number) =>
			Math.round((px / HOUR_PX) * (60 / VIEW_STEP_MINUTES)) * VIEW_STEP_MINUTES;
		const from = toMinutes(scroller.scrollTop);
		const to = toMinutes(scroller.scrollTop + scroller.clientHeight);
		setRange((current) =>
			current?.from === from && current.to === to ? current : { from, to }
		);
	}, [scrollerRef]);
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller) {
			return;
		}
		scroller.addEventListener("scroll", refresh, { passive: true });
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(refresh);
		observer?.observe(scroller);
		return () => {
			scroller.removeEventListener("scroll", refresh);
			observer?.disconnect();
		};
	}, [refresh, scrollerRef]);
	return { columnWidth, range, refresh };
}

/**
 * "↑ 2 earlier" / "↓ 1 later": a column's blocks scrolled out of view, like
 * the reference calendars' hints. Choosing it scrolls the first one in.
 */
export function OffscreenHint({
	count,
	date,
	direction,
	onReveal,
	tabStop,
}: {
	count: number;
	date: Date;
	direction: "earlier" | "later";
	onReveal: () => void;
	tabStop: boolean;
}) {
	const tl = useLiteralMessages();
	const Icon = direction === "earlier" ? ChevronUp : ChevronDown;
	return (
		<button
			aria-label={tl(
				"{direction, select, earlier {{count, plural, one {# earlier item} other {# earlier items}}} other {{count, plural, one {# later item} other {# later items}}}} on {day}, show",
				{ count, day: longDay(date), direction }
			)}
			className={cn(
				"pointer-events-auto absolute inset-x-0 mx-auto flex h-5 w-fit max-w-[calc(100%-8px)] items-center gap-0.5 bg-background ps-1 pe-1.5 font-medium text-muted-foreground text-xs tabular-nums outline-none transition-colors",
				ITEM_RADIUS_CLASS,
				"hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
				direction === "earlier" ? "top-1" : "bottom-1"
			)}
			onClick={onReveal}
			tabIndex={tabStop ? 0 : -1}
			type="button"
		>
			<Icon aria-hidden="true" className="size-3.5 shrink-0" />
			<span className="truncate">
				{count}
				<span className="@max-[4.5rem]:hidden"> {direction}</span>
			</span>
		</button>
	);
}

/**
 * A zero-height row pinned to the top or bottom edge of the scrolled hours,
 * lined up with the day columns, that carries the off-screen hints.
 */
export function HintRow({
	cells,
	edge,
}: {
	cells: readonly { content: ReactNode; key: string }[];
	edge: "bottom" | "top";
}) {
	return (
		<div
			className={cn(
				"pointer-events-none sticky z-10 grid h-0",
				COLUMNS,
				edge === "top" ? "top-0" : "bottom-0"
			)}
		>
			<span />
			{cells.map((cell) => (
				<div className="@container relative" key={cell.key}>
					{cell.content}
				</div>
			))}
		</div>
	);
}
