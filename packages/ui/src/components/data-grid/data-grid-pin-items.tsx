"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import type { Direction } from "@ryu/ui/types/data-grid.ts";
import { PinIcon, PinOffIcon } from "lucide-react";
import { gridInlineDirection } from "./data-grid-fill-end-item.tsx";

/** TanStack's pin side: `"left"` is the inline start, `"right"` the end. */
export type GridPinSide = "left" | "right";

/**
 * The physical edge a TanStack pin side lands on. `getColumnPinningStyle`
 * swaps the offsets under `dir="rtl"`, so the `"left"` (inline-start) pin
 * sticks to the right edge there.
 */
export function physicalPinEdge(side: GridPinSide, dir: Direction) {
	if (dir !== "rtl") {
		return side;
	}
	return side === "left" ? "right" : "left";
}

/**
 * The label of a pin/unpin menu row, naming the edge the column actually
 * moves to (or leaves) in the grid's reading direction.
 */
export function DataGridPinLabel({
	dir,
	pinned,
	side,
}: {
	dir: Direction;
	pinned: boolean;
	side: GridPinSide;
}) {
	const tl = useLiteralMessages();
	const edge = physicalPinEdge(side, dir);
	if (pinned) {
		return (
			<>
				<PinOffIcon />
				{edge === "left" ? tl("Unpin from left") : tl("Unpin from right")}
			</>
		);
	}
	return (
		<>
			<PinIcon />
			{edge === "left" ? tl("Pin to left") : tl("Pin to right")}
		</>
	);
}

interface DataGridPinItemsProps {
	/** The grid element; its nearest `dir` decides the labels. */
	gridElement: Element | null | undefined;
	onLeftPin: () => void;
	onRightPin: () => void;
	onUnpin: () => void;
	pinnedPosition: GridPinSide | false;
}

/**
 * The column header's pin rows. They render only while the menu is open, so
 * the grid element is mounted and its direction can be read.
 */
export function DataGridPinItems({
	gridElement,
	onLeftPin,
	onRightPin,
	onUnpin,
	pinnedPosition,
}: DataGridPinItemsProps) {
	const dir = gridInlineDirection(gridElement, useDirection());
	const pinnedLeft = pinnedPosition === "left";
	const pinnedRight = pinnedPosition === "right";
	return (
		<>
			<DropdownMenuItem
				className="[&_svg]:text-muted-foreground"
				onClick={pinnedLeft ? onUnpin : onLeftPin}
			>
				<DataGridPinLabel dir={dir} pinned={pinnedLeft} side="left" />
			</DropdownMenuItem>
			<DropdownMenuItem
				className="[&_svg]:text-muted-foreground"
				onClick={pinnedRight ? onUnpin : onRightPin}
			>
				<DataGridPinLabel dir={dir} pinned={pinnedRight} side="right" />
			</DropdownMenuItem>
		</>
	);
}
