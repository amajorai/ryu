import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { Maximize2, Plus } from "lucide-react";
import type { DbColumn, DbRow } from "@/src/lib/realtime/yjs-database.ts";
import { CellValue } from "./cell-display.tsx";

/** How many trailing property chips a list row shows next to its title. */
const MAX_LIST_PROPERTIES = 3;

/**
 * A Notion-style list: one compact row per record — the first column as a title,
 * a few property chips trailing, and an open affordance. The lightest-weight view;
 * good for reading and jumping into row pages.
 */
export function ListView({
	columns,
	rows,
	readOnly,
	onOpenRow,
	createRow,
}: {
	columns: DbColumn[];
	rows: DbRow[];
	readOnly: boolean;
	onOpenRow: (row: DbRow) => void;
	createRow: (values?: Record<string, unknown>) => void;
}) {
	const [titleColumn, ...rest] = columns;
	const chipColumns = rest
		.filter((column) => column.cell.variant !== "long-text")
		.slice(0, MAX_LIST_PROPERTIES);

	return (
		<div className="h-full overflow-y-auto p-4">
			<div className="mx-auto flex max-w-3xl flex-col divide-y rounded-lg border">
				{rows.map((row) => {
					const titleValue = titleColumn ? row[titleColumn.id] : undefined;
					const title =
						titleValue == null || titleValue === ""
							? "Untitled"
							: String(titleValue);
					return (
						<button
							className="group flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/50"
							key={row.__id}
							onClick={() => onOpenRow(row)}
							type="button"
						>
							<span className="min-w-0 flex-1 truncate font-medium text-sm">
								{title}
							</span>
							<div className="flex shrink-0 items-center gap-2">
								{chipColumns.map((column) => (
									<CellValue
										column={column}
										key={column.id}
										value={row[column.id]}
									/>
								))}
							</div>
							<Maximize2
								className={cn(
									"size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100"
								)}
							/>
						</button>
					);
				})}
				{rows.length === 0 && (
					<div className="px-3 py-6 text-center text-muted-foreground text-sm">
						No rows yet.
					</div>
				)}
			</div>
			{!readOnly && (
				<div className="mx-auto mt-2 max-w-3xl">
					<Button
						className="justify-start text-muted-foreground"
						onClick={() => createRow()}
						size="sm"
						variant="ghost"
					>
						<Plus className="size-3.5" />
						New row
					</Button>
				</div>
			)}
		</div>
	);
}
