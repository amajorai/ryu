"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenuItem,
	DropdownMenuShortcut,
} from "@ryu/ui/components/dropdown-menu.tsx";
import type { Direction } from "@ryu/ui/types/data-grid.ts";
import { ArrowLeftToLineIcon, ArrowRightToLineIcon } from "lucide-react";

/**
 * The grid's inline direction: the nearest `dir` attribute above the grid
 * element (the wrapper renders the grid's resolved `dir`), else the ambient
 * direction. The context menu renders in a portal, so it cannot read the
 * grid's direction from its own DOM position.
 */
export function gridInlineDirection(
	gridElement: Element | null | undefined,
	fallback: Direction
): Direction {
	const attribute = gridElement?.closest("[dir]")?.getAttribute("dir");
	return attribute === "rtl" || attribute === "ltr" ? attribute : fallback;
}

/**
 * The icon and label of the "fill toward the inline end" action.
 *
 * The fill action is `"right"` in grid terms: it copies the selection's first
 * (inline-start) column across the rest. Under `dir="rtl"` the inline start is
 * the right edge, so the copy visibly runs leftward; the label and icon say
 * "Fill left" to match what the user sees, while the action value and the
 * Ctrl+R shortcut stay the same.
 */
export function DataGridFillEndLabel({ dir }: { dir: Direction }) {
	const tl = useLiteralMessages();
	const isRtl = dir === "rtl";
	// Picked per direction (not CSS-mirrored) so the glyph always agrees with
	// the label beside it, even when the grid's `dir` differs from the page's.
	const FillIcon = isRtl ? ArrowLeftToLineIcon : ArrowRightToLineIcon;
	return (
		<>
			<FillIcon data-fill-icon={isRtl ? "left" : "right"} />
			{isRtl ? tl("Fill left") : tl("Fill right")}
		</>
	);
}

interface DataGridFillEndItemProps {
	dir: Direction;
	disabled?: boolean;
	onFill: () => void;
}

/** The context-menu row that fills the selection toward the inline end. */
export function DataGridFillEndItem({
	dir,
	disabled,
	onFill,
}: DataGridFillEndItemProps) {
	return (
		<DropdownMenuItem disabled={disabled} onClick={onFill}>
			<DataGridFillEndLabel dir={dir} />
			<DropdownMenuShortcut>Ctrl+R</DropdownMenuShortcut>
		</DropdownMenuItem>
	);
}
