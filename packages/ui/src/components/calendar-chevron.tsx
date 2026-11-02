"use client";

import {
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowUpIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComponentProps } from "react";
import type { ChevronProps, DayPickerProps } from "react-day-picker";

type ChevronOrientation = NonNullable<ChevronProps["orientation"]>;

/**
 * The physical way a DayPicker chevron points. DayPicker's default navigation
 * bar always asks for a "left" previous and a "right" next chevron, whatever
 * its `dir`; only its `navLayout="around"` buttons already swap them under
 * `dir="rtl"`. Under right-to-left the previous button sits at the inline
 * start (the right edge), so its chevron points right. The orientation is
 * resolved here once, in JS, so no CSS mirror or rotation flips it again.
 */
export function calendarChevronOrientation(
	orientation: ChevronOrientation | undefined,
	dir: string | undefined,
	navLayout: DayPickerProps["navLayout"]
): ChevronOrientation {
	const requested = orientation ?? "down";
	if (dir !== "rtl" || navLayout === "around") {
		return requested;
	}
	if (requested === "left") {
		return "right";
	}
	if (requested === "right") {
		return "left";
	}
	return requested;
}

const CHEVRON_GLYPHS = {
	down: ArrowDownIcon,
	left: ArrowLeftIcon,
	right: ArrowRightIcon,
	up: ArrowUpIcon,
} satisfies Record<
	ChevronOrientation,
	ComponentProps<typeof HugeiconsIcon>["icon"]
>;

/**
 * The calendars' month chevron. It draws the glyph for the physical direction
 * {@link calendarChevronOrientation} resolves, so it is never mirrored by a
 * class as well (that flipped it twice under `dir="rtl"`).
 */
export function CalendarChevron({
	className,
	dir,
	disabled: _disabled,
	navLayout,
	orientation,
	...props
}: ChevronProps & {
	dir: string | undefined;
	navLayout: DayPickerProps["navLayout"];
}) {
	const pointing = calendarChevronOrientation(orientation, dir, navLayout);
	// Already oriented for the reading direction above; drawing it through
	// DirectionalIcon or an `rtl:` class would flip it a second time.
	const glyph = CHEVRON_GLYPHS[pointing];
	return (
		<HugeiconsIcon
			className={cn("size-4", className)}
			data-chevron={pointing}
			icon={glyph}
			strokeWidth={2}
			{...props}
		/>
	);
}
