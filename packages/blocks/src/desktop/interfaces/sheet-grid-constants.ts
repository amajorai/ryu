import { cn } from "@ryu/ui/lib/utils";
import {
	CircleDot,
	Clock3,
	FolderKanban,
	Hash,
	type LucideIcon,
	MessageSquareText,
	SquareCheck,
	Type,
	Users,
	UsersRound,
} from "lucide-react";
import {
	SHEET_GUTTER_WIDTH,
	type SheetColumn,
	type SheetColumnId,
} from "./sheet-model.ts";

export const SHEET_COLUMN_ICON: Record<SheetColumnId, LucideIcon> = {
	agents: Users,
	lastMessage: MessageSquareText,
	messages: Hash,
	pinned: SquareCheck,
	project: FolderKanban,
	status: CircleDot,
	team: UsersRound,
	title: Type,
	updated: Clock3,
};

/** Left offset that centres the 24px expand button in the gutter, from the Title cell. */
export const EXPAND_OFFSET = -(SHEET_GUTTER_WIDTH + 24) / 2;
/** Header row height; the body rows match it. */
export const ROW_HEIGHT = 32;
/** Pixels an Alt+Arrow press widens or narrows the focused column. */
export const KEY_RESIZE_STEP = 16;
/** Above this many rows, sorting snaps instead of animating. */
export const ANIMATED_ROW_LIMIT = 80;
export const SKELETON_ROWS = [
	"skeleton-1",
	"skeleton-2",
	"skeleton-3",
	"skeleton-4",
	"skeleton-5",
	"skeleton-6",
	"skeleton-7",
	"skeleton-8",
	"skeleton-9",
	"skeleton-10",
	"skeleton-11",
	"skeleton-12",
] as const;
export const SKELETON_WIDTHS = [
	"w-3/4",
	"w-1/2",
	"w-2/3",
	"w-2/5",
	"w-3/5",
] as const;

export const CELL =
	"h-8 whitespace-nowrap border-border border-r border-b px-2.5 text-[13px]";
/**
 * Row fills are mixed against the background, so they stay opaque: the frozen
 * gutter and Title cells tint without showing what scrolls under them.
 */
export const ROW_FILL = {
	hover:
		"group-hover/row:bg-[color-mix(in_oklab,var(--muted)_70%,var(--background))]",
	open: "bg-[color-mix(in_oklab,var(--primary)_14%,var(--background))] dark:bg-[color-mix(in_oklab,var(--primary)_20%,var(--background))]",
	rest: "bg-background",
	selected:
		"bg-[color-mix(in_oklab,var(--primary)_8%,var(--background))] dark:bg-[color-mix(in_oklab,var(--primary)_11%,var(--background))]",
} as const;
/** Spreadsheet active cell: a solid outline on focus, a faint one while the grid is blurred. */
export const CELL_FOCUS =
	"focus:outline-2 focus:-outline-offset-2 focus:outline-primary data-[cursor=true]:not-focus:outline-1 data-[cursor=true]:not-focus:-outline-offset-1 data-[cursor=true]:not-focus:outline-primary/60";
/** Headers only ring for keyboard focus, so a sort click leaves no box behind. */
export const HEADER_FOCUS =
	"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary";
/** The freeze line: a firmer divider always, plus a cast shadow once the body scrolls under it. */
export const FROZEN_EDGE =
	"border-r-foreground/15 after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-3 after:translate-x-full after:bg-linear-to-r after:from-foreground/16 after:to-transparent after:opacity-0 after:transition-opacity group-data-[scrolled-x=true]/sheet:border-r-foreground/25 group-data-[scrolled-x=true]/sheet:after:opacity-100";
export const HEADER_EDGE =
	"before:pointer-events-none before:absolute before:inset-x-0 before:bottom-0 before:h-2.5 before:translate-y-full before:bg-linear-to-b before:from-foreground/12 before:to-transparent before:opacity-0 before:transition-opacity group-data-[scrolled-y=true]/sheet:before:opacity-100";

export const ALIGN: Record<SheetColumn["align"], string> = {
	center: "justify-center text-center",
	end: "justify-end text-right",
	start: "justify-start text-left",
};

export function rowTint(selected: boolean, open: boolean): string {
	if (open) {
		return ROW_FILL.open;
	}
	if (selected) {
		return ROW_FILL.selected;
	}
	return cn(ROW_FILL.rest, ROW_FILL.hover);
}
