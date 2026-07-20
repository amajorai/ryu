import { Button } from "@ryu/ui/components/button";
import { Card } from "@ryu/ui/components/card";
import { cn } from "@ryu/ui/lib/utils";
import { Maximize2 } from "lucide-react";
import type { DragEvent } from "react";
import type { DbColumn, DbRow } from "@/src/lib/realtime/yjs-database.ts";
import { CellValue } from "./cell-display.tsx";

/** How many non-title properties a card shows before it stops (keeps cards short). */
const MAX_CARD_PROPERTIES = 4;

/**
 * A card representation of one database row: the first column as a title, then a
 * few property values. Shared by the board and gallery views. Optional drag props
 * let the board move a card between group lanes (native HTML5 DnD, which works in
 * the desktop window because `dragDropEnabled:false` is set in tauri.conf.json).
 */
export function RowCard({
	row,
	columns,
	onOpen,
	draggable,
	onDragStart,
	onDragEnd,
	dragging,
}: {
	row: DbRow;
	columns: DbColumn[];
	onOpen: (row: DbRow) => void;
	draggable?: boolean;
	onDragStart?: (event: DragEvent) => void;
	onDragEnd?: (event: DragEvent) => void;
	dragging?: boolean;
}) {
	const [titleColumn, ...rest] = columns;
	const titleValue = titleColumn ? row[titleColumn.id] : undefined;
	const title =
		titleValue == null || titleValue === "" ? "Untitled" : String(titleValue);
	const properties = rest
		.filter((column) => column.cell.variant !== "long-text")
		.map((column) => ({ column, value: row[column.id] }))
		.filter(
			({ value }) =>
				value != null &&
				value !== "" &&
				(!Array.isArray(value) || value.length > 0)
		)
		.slice(0, MAX_CARD_PROPERTIES);

	return (
		<Card
			className={cn(
				"group cursor-pointer gap-2 p-3 shadow-sm transition-shadow hover:shadow-md",
				dragging && "opacity-50"
			)}
			draggable={draggable}
			onClick={() => onOpen(row)}
			onDragEnd={onDragEnd}
			onDragStart={onDragStart}
		>
			<div className="flex items-start justify-between gap-2">
				<span className="min-w-0 flex-1 truncate font-medium text-sm">
					{title}
				</span>
				<Button
					aria-label="Open row"
					className="size-6 shrink-0 opacity-0 group-hover:opacity-100"
					onClick={(e) => {
						e.stopPropagation();
						onOpen(row);
					}}
					size="icon"
					variant="ghost"
				>
					<Maximize2 className="size-3" />
				</Button>
			</div>
			{properties.length > 0 && (
				<div className="flex flex-col gap-1.5">
					{properties.map(({ column, value }) => (
						<CellValue column={column} key={column.id} value={value} />
					))}
				</div>
			)}
		</Card>
	);
}
