import { cn } from "@ryu/ui/lib/utils";
import { ArrowDown, ArrowUp } from "lucide-react";
import { type PointerEvent, useRef, useState } from "react";
import {
	ALIGN,
	CELL,
	FROZEN_EDGE,
	HEADER_EDGE,
	HEADER_FOCUS,
	SHEET_COLUMN_ICON,
} from "./sheet-grid-constants.ts";
import {
	clampColumnWidth,
	SHEET_COLUMNS,
	SHEET_GUTTER_WIDTH,
	type SheetColumn,
	type SheetColumnId,
	type SheetSort,
} from "./sheet-model.ts";

function SortGlyph({ sort }: { sort: SheetSort | null }) {
	if (!sort) {
		return null;
	}
	const Icon = sort.direction === "asc" ? ArrowUp : ArrowDown;
	return (
		<Icon aria-hidden="true" className="size-3.5 shrink-0 text-foreground" />
	);
}

function ResizeHandle({
	column,
	onResize,
	width,
}: {
	column: SheetColumn;
	onResize: (id: SheetColumnId, width: number) => void;
	width: number;
}) {
	const drag = useRef<{ startWidth: number; startX: number } | null>(null);
	// While dragging, the guide runs the full visible height of the sheet so the
	// edge can be lined up against the cells below, as in a spreadsheet.
	const [guideHeight, setGuideHeight] = useState<number | null>(null);
	const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { startWidth: width, startX: event.clientX };
		event.currentTarget.dataset.dragging = "true";
		const scroller = event.currentTarget.closest<HTMLElement>(
			"[data-sheet-scroll]"
		);
		setGuideHeight(scroller?.clientHeight ?? null);
	};
	const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
		const start = drag.current;
		if (!start) {
			return;
		}
		onResize(
			column.id,
			clampColumnWidth(
				column.id,
				start.startWidth + event.clientX - start.startX
			)
		);
	};
	const onPointerEnd = (event: PointerEvent<HTMLSpanElement>) => {
		drag.current = null;
		delete event.currentTarget.dataset.dragging;
		setGuideHeight(null);
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};
	return (
		<span
			aria-hidden="true"
			className="group/resize absolute inset-y-0 right-0 z-10 flex w-2 translate-x-1/2 cursor-col-resize touch-none justify-center"
			data-sheet-resize=""
			onClick={(event) => event.stopPropagation()}
			onDoubleClick={(event) => {
				event.stopPropagation();
				onResize(column.id, column.defaultWidth);
			}}
			onPointerCancel={onPointerEnd}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
		>
			<span className="h-full w-0.5 rounded-full bg-primary opacity-0 transition-opacity group-hover/resize:opacity-60 group-data-[dragging=true]/resize:opacity-100" />
			{guideHeight === null ? null : (
				<span
					className="pointer-events-none absolute top-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary"
					data-sheet-resize-guide=""
					style={{ height: guideHeight }}
				/>
			)}
		</span>
	);
}

export function HeaderCell({
	column,
	cursor,
	index,
	onResize,
	onSort,
	sort,
	width,
}: {
	column: SheetColumn;
	cursor: boolean;
	index: number;
	onResize: (id: SheetColumnId, width: number) => void;
	onSort: (id: SheetColumnId) => void;
	sort: SheetSort | null;
	width: number;
}) {
	const Icon = SHEET_COLUMN_ICON[column.id];
	const active = sort?.column === column.id ? sort : null;
	let ariaSort: "ascending" | "descending" | "none" = "none";
	if (active) {
		ariaSort = active.direction === "asc" ? "ascending" : "descending";
	}
	const frozen = column.id === "title";
	return (
		<th
			aria-colindex={index + 1}
			aria-sort={ariaSort}
			className={cn(
				CELL,
				HEADER_EDGE,
				HEADER_FOCUS,
				"sticky top-0 z-20 cursor-pointer select-none bg-muted font-normal text-foreground/85 text-xs transition-colors hover:bg-[color-mix(in_oklab,var(--foreground)_5%,var(--muted))] hover:text-foreground",
				active && "text-foreground",
				index === SHEET_COLUMNS.length - 1 && "border-r-0",
				frozen && cn("z-30", FROZEN_EDGE)
			)}
			data-sheet-col={index}
			data-sheet-row={-1}
			onClick={() => onSort(column.id)}
			scope="col"
			style={frozen ? { left: SHEET_GUTTER_WIDTH } : undefined}
			tabIndex={cursor ? 0 : -1}
		>
			<div
				className={cn("flex min-w-0 items-center gap-1.5", ALIGN[column.align])}
			>
				{active ? (
					<SortGlyph sort={active} />
				) : (
					<Icon
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
				)}
				<span className="truncate">{column.label}</span>
			</div>
			<ResizeHandle column={column} onResize={onResize} width={width} />
		</th>
	);
}
