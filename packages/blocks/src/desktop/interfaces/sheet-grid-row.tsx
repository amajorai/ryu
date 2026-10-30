import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Maximize2 } from "lucide-react";
import { motion } from "motion/react";
import { memo, type ReactNode } from "react";
import {
	SheetAgents,
	SheetChip,
	SheetHighlight,
	SheetLastMessage,
	SheetPinned,
	SheetStatusPill,
	SheetUpdated,
} from "./sheet-cells.tsx";
import {
	ALIGN,
	CELL,
	CELL_FOCUS,
	EXPAND_OFFSET,
	FROZEN_EDGE,
	rowTint,
	SKELETON_WIDTHS,
} from "./sheet-grid-constants.ts";
import {
	SHEET_COLUMNS,
	SHEET_GUTTER_WIDTH,
	type SheetColumn,
	type SheetRow,
} from "./sheet-model.ts";

function BodyCell({
	children,
	column,
	cursorActive,
	cursorCol,
	index,
	open,
	rowIndex,
	selected,
}: {
	children: ReactNode;
	column: SheetColumn;
	cursorActive: boolean;
	cursorCol: number | null;
	index: number;
	open: boolean;
	rowIndex: number;
	selected: boolean;
}) {
	const cursor = cursorCol === index;
	const frozen = column.id === "title";
	const Tag = frozen ? "th" : "td";
	return (
		<Tag
			aria-colindex={index + 1}
			className={cn(
				CELL,
				CELL_FOCUS,
				rowTint(selected, open),
				index === SHEET_COLUMNS.length - 1 && "border-r-0",
				"font-normal text-foreground",
				frozen && cn("sticky z-10", FROZEN_EDGE)
			)}
			data-cursor={cursorActive && cursor}
			data-sheet-col={index}
			data-sheet-row={rowIndex}
			role={frozen ? "rowheader" : "gridcell"}
			scope={frozen ? "row" : undefined}
			style={frozen ? { left: SHEET_GUTTER_WIDTH } : undefined}
			tabIndex={cursor ? 0 : -1}
		>
			<div
				className={cn(
					"flex min-w-0 items-center overflow-hidden",
					ALIGN[column.align]
				)}
			>
				{children}
			</div>
		</Tag>
	);
}

interface SheetGridRowProps {
	animate: boolean;
	/** False until the user has moved the cursor, so nothing looks selected on first paint. */
	cursorActive: boolean;
	cursorCol: number | null;
	index: number;
	now: number;
	onOpen: (threadId: string) => void;
	open: boolean;
	query: string;
	row: SheetRow;
}

export const SheetGridRow = memo(function SheetGridRowImpl({
	animate,
	cursorActive,
	cursorCol,
	index,
	now,
	onOpen,
	open,
	query,
	row,
}: SheetGridRowProps) {
	const tl = useLiteralMessages();
	const selected = cursorActive && cursorCol !== null;
	const cellFor = (column: SheetColumn): ReactNode => {
		switch (column.id) {
			case "title":
				return (
					<>
						<span className="min-w-0 flex-1 truncate font-medium">
							<SheetHighlight query={query} text={row.title} />
						</span>
						{/* Sits over the row-number gutter, which hides its number on hover, so the title keeps its width. */}
						<button
							aria-label={tl("Open {title}", { title: row.title })}
							className="absolute top-1/2 hidden size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring group-hover/row:flex"
							onClick={() => onOpen(row.thread.id)}
							onMouseDown={(event) => event.preventDefault()}
							style={{ left: EXPAND_OFFSET }}
							tabIndex={-1}
							type="button"
						>
							<Maximize2 aria-hidden="true" className="size-3.5" />
						</button>
					</>
				);
			case "status":
				return <SheetStatusPill status={row.status} />;
			case "agents":
				return <SheetAgents agents={row.agents} query={query} />;
			case "team":
				return <SheetChip kind="team" name={row.team} query={query} />;
			case "project":
				return <SheetChip kind="project" name={row.project} query={query} />;
			case "messages":
				return (
					<span className="text-foreground/85 tabular-nums">
						{row.thread.messageCount.toLocaleString()}
					</span>
				);
			case "lastMessage":
				return <SheetLastMessage query={query} row={row} />;
			case "updated":
				return <SheetUpdated now={now} row={row} />;
			case "pinned":
				return <SheetPinned pinned={row.thread.pinned} />;
			default:
				return null;
		}
	};
	return (
		<motion.tr
			aria-rowindex={index + 2}
			aria-selected={selected}
			className="group/row"
			data-open={open}
			data-thread-id={row.thread.id}
			layout={animate ? "position" : false}
			transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
		>
			<td
				aria-hidden="true"
				className={cn(
					CELL,
					rowTint(selected, open),
					"sticky left-0 z-10 px-0 text-center text-muted-foreground text-xs tabular-nums",
					(selected || open) && "text-foreground"
				)}
			>
				<span className="group-hover/row:invisible">{index + 1}</span>
			</td>
			{SHEET_COLUMNS.map((column, colIndex) => (
				<BodyCell
					column={column}
					cursorActive={cursorActive}
					cursorCol={cursorCol}
					index={colIndex}
					key={column.id}
					open={open}
					rowIndex={index}
					selected={selected}
				>
					{cellFor(column)}
				</BodyCell>
			))}
			<td
				aria-hidden="true"
				className={cn("border-border border-b", rowTint(selected, open))}
			/>
		</motion.tr>
	);
});

export function SkeletonRow({ index }: { index: number }) {
	return (
		<tr>
			<td
				aria-hidden="true"
				className={cn(CELL, "sticky left-0 z-10 bg-background px-0")}
			>
				<span className="flex justify-center">
					<Skeleton className="h-2 w-3" />
				</span>
			</td>
			{SHEET_COLUMNS.map((column, colIndex) => (
				<td
					aria-hidden="true"
					className={cn(
						CELL,
						"bg-background",
						column.id === "title" && cn("sticky z-10", FROZEN_EDGE),
						colIndex === SHEET_COLUMNS.length - 1 && "border-r-0"
					)}
					key={column.id}
					style={
						column.id === "title" ? { left: SHEET_GUTTER_WIDTH } : undefined
					}
				>
					<Skeleton
						className={cn(
							"h-2.5",
							SKELETON_WIDTHS[(index + colIndex) % SKELETON_WIDTHS.length]
						)}
					/>
				</td>
			))}
			<td aria-hidden="true" className="border-border border-b bg-background" />
		</tr>
	);
}
