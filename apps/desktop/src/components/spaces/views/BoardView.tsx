import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { DataGridOptionBadge } from "@ryu/ui/components/data-grid/data-grid-option-badge.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type DragEvent, useMemo, useState } from "react";
import type {
	applyCellEdits,
	DbColumn,
	DbRow,
} from "@/src/lib/realtime/yjs-database.ts";
import { RowCard } from "./RowCard.tsx";

/** Sentinel group value for rows whose group cell is empty or unmatched. */
const NO_GROUP = "__none__";

interface BoardGroup {
	color?: string;
	key: string;
	label: string;
	rows: DbRow[];
}

/**
 * A Notion-style kanban board: rows become cards grouped into lanes by a `select`
 * column. Dragging a card to another lane writes that column's cell (the single
 * source of truth), so the move persists through the same CRDT path as any edit.
 */
export function BoardView({
	columns,
	rows,
	groupByColumnId,
	readOnly,
	onOpenRow,
	setCell,
	createRow,
}: {
	columns: DbColumn[];
	rows: DbRow[];
	groupByColumnId?: string;
	readOnly: boolean;
	onOpenRow: (row: DbRow) => void;
	setCell: (
		rowId: string,
		columnId: string,
		value: Parameters<typeof applyCellEdits>[1][number]["value"]
	) => void;
	createRow: (values?: DbRow) => void;
}) {
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [dragOverKey, setDragOverKey] = useState<string | null>(null);

	const groupColumn = columns.find((column) => column.id === groupByColumnId);
	const isSelectGroup =
		groupColumn?.cell.variant === "select" ||
		groupColumn?.cell.variant === "multi-select";

	const groups = useMemo<BoardGroup[]>(() => {
		if (!(groupColumn && isSelectGroup)) {
			return [];
		}
		const options =
			groupColumn.cell.variant === "select" ||
			groupColumn.cell.variant === "multi-select"
				? groupColumn.cell.options
				: [];
		const buckets = new Map<string, DbRow[]>();
		buckets.set(NO_GROUP, []);
		for (const option of options) {
			buckets.set(option.value, []);
		}
		for (const row of rows) {
			const raw = row[groupColumn.id];
			const value = Array.isArray(raw) ? raw[0] : raw;
			const key = isNativeText(value) && buckets.has(value) ? value : NO_GROUP;
			buckets.get(key)?.push(row);
		}
		const result: BoardGroup[] = options.map((option) => ({
			key: option.value,
			label: option.label,
			color: option.color,
			rows: buckets.get(option.value) ?? [],
		}));
		result.push({
			key: NO_GROUP,
			label: "No group",
			rows: buckets.get(NO_GROUP) ?? [],
		});
		return result;
	}, [groupColumn, isSelectGroup, rows]);

	if (!groupColumn) {
		return (
			<div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground text-sm">
				Pick a Select property to group cards by in the view menu.
			</div>
		);
	}
	if (!isSelectGroup) {
		return (
			<div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground text-sm">
				Board grouping needs a Select or Multi-select property.
			</div>
		);
	}

	const dropOnGroup = (groupKey: string) => {
		setDragOverKey(null);
		if (readOnly || !draggingId) {
			return;
		}
		const value = groupKey === NO_GROUP ? "" : groupKey;
		const target =
			groupColumn.cell.variant === "multi-select"
				? value
					? [value]
					: []
				: value;
		setCell(draggingId, groupColumn.id, target);
		setDraggingId(null);
	};

	const allowDrop = (event: DragEvent) => {
		if (draggingId) {
			event.preventDefault();
		}
	};

	return (
		<div className="scroll-fade-x flex h-full gap-3 overflow-x-auto p-4">
			{groups.map((group) => (
				<div
					className={cn(
						"flex h-full w-72 shrink-0 flex-col rounded-lg bg-muted/40 transition-colors",
						dragOverKey === group.key && "bg-muted"
					)}
					key={group.key}
					onDragLeave={() =>
						setDragOverKey((k) => (k === group.key ? null : k))
					}
					onDragOver={(e) => {
						allowDrop(e);
						if (draggingId) {
							setDragOverKey(group.key);
						}
					}}
					onDrop={() => dropOnGroup(group.key)}
				>
					<div className="flex items-center gap-2 px-3 pt-3 pb-2">
						{group.key === NO_GROUP ? (
							<span className="font-medium text-muted-foreground text-xs">
								{group.label}
							</span>
						) : (
							<DataGridOptionBadge color={group.color}>
								{group.label}
							</DataGridOptionBadge>
						)}
						<span className="text-muted-foreground text-xs">
							{group.rows.length}
						</span>
					</div>
					<div className="scroll-fade flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
						{group.rows.map((row) => (
							<RowCard
								columns={columns}
								draggable={!readOnly}
								dragging={draggingId === row.__id}
								key={row.__id}
								onDragEnd={() => {
									setDraggingId(null);
									setDragOverKey(null);
								}}
								onDragStart={(e: DragEvent) => {
									if (row.__id) {
										setDraggingId(row.__id);
										e.dataTransfer.effectAllowed = "move";
									}
								}}
								onOpen={onOpenRow}
								row={row}
							/>
						))}
						{!readOnly && (
							<Button
								className="justify-start"
								onClick={() =>
									createRow(
										group.key === NO_GROUP
											? undefined
											: {
													[groupColumn.id]:
														groupColumn.cell.variant === "multi-select"
															? [group.key]
															: group.key,
												}
									)
								}
								size="sm"
								variant="ghost-muted"
							>
								<HugeiconsIcon className="size-3.5" icon={PlusSignIcon} />
								New
							</Button>
						)}
					</div>
				</div>
			))}
		</div>
	);
}
