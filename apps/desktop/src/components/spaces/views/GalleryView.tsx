import { Button } from "@ryu/ui/components/button";
import { Plus } from "lucide-react";
import type { DbColumn, DbRow } from "@/src/lib/realtime/yjs-database.ts";
import { RowCard } from "./RowCard.tsx";

/**
 * A Notion-style gallery: every row is a card in a responsive grid. Ungrouped —
 * cards keep the database's row order. Cards open as pages; adding one appends an
 * empty row through the same path as the table's "add row".
 */
export function GalleryView({
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
	return (
		<div className="h-full overflow-y-auto p-4">
			<div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
				{rows.map((row) => (
					<RowCard
						columns={columns}
						key={row.__id}
						onOpen={onOpenRow}
						row={row}
					/>
				))}
				{!readOnly && (
					<Button
						className="h-full min-h-24 justify-center border border-dashed text-muted-foreground"
						onClick={() => createRow()}
						variant="ghost"
					>
						<Plus className="size-4" />
						New
					</Button>
				)}
			</div>
		</div>
	);
}
