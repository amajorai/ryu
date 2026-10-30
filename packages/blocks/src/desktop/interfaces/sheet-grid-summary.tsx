import { cn } from "@ryu/ui/lib/utils";
import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { SheetStatusShare } from "./sheet-cells.tsx";
import { ALIGN } from "./sheet-grid-constants.ts";
import {
	SHEET_COLUMNS,
	SHEET_GUTTER_WIDTH,
	type SheetColumnId,
	type SheetTotals,
	type SheetWidths,
} from "./sheet-model.ts";

/**
 * The summary row closing the records, the way a grid tool totals each field
 * in place: every value sits under its own column and scrolls sideways with
 * the grid, and it sticks to the bottom edge once the rows overflow.
 */
export function SheetSummaryBar({
	countLabel,
	statusCounts,
	totals,
	widths,
}: {
	/** "10 threads", or "2 of 10 threads" while a search or filter is on. */
	countLabel: string;
	/** Visible rows per status, for the Status column's share-by-option bar. */
	statusCounts: Record<ThreadStatus, number>;
	totals: SheetTotals;
	widths: SheetWidths;
}) {
	const totalWidth =
		SHEET_GUTTER_WIDTH +
		SHEET_COLUMNS.reduce((sum, column) => sum + widths[column.id], 0);
	const summaryFor = (id: SheetColumnId): ReactNode => {
		if (id === "messages") {
			return (
				<>
					<span className="text-muted-foreground">Sum</span>
					<span className="text-foreground tabular-nums">
						{totals.messages.toLocaleString()}
					</span>
				</>
			);
		}
		if (id === "status") {
			return <SheetStatusShare counts={statusCounts} />;
		}
		if (id === "pinned") {
			return (
				<>
					<span className="text-foreground tabular-nums">{totals.pinned}</span>
					<span className="text-muted-foreground">pinned</span>
				</>
			);
		}
		return null;
	};
	return (
		<div
			className="sticky bottom-0 z-20 flex h-8 w-full border-border border-y bg-background text-xs"
			data-sheet-summary=""
			style={{ minWidth: totalWidth }}
		>
			<p
				aria-live="polite"
				className="sticky left-0 z-10 flex shrink-0 items-center truncate bg-background text-foreground/80 tabular-nums"
				style={{
					paddingInlineStart: SHEET_GUTTER_WIDTH + 10,
					width: SHEET_GUTTER_WIDTH + widths.title,
				}}
			>
				{countLabel}
			</p>
			{SHEET_COLUMNS.filter((column) => column.id !== "title").map((column) => (
				<div
					className={cn(
						"flex min-w-0 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap px-2.5",
						ALIGN[column.align]
					)}
					key={column.id}
					style={{ width: widths[column.id] }}
				>
					{summaryFor(column.id)}
				</div>
			))}
		</div>
	);
}
