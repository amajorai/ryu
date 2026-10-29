// Table widget: renders an array of row records through the shadcn Table.

import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { asRecord, cell, inferColumns, resolveArray } from "./data.ts";
import { parseConfig, tableConfigSchema } from "./schema.ts";

export function TableBodyWidget({
	value,
	config,
}: {
	value: unknown;
	config: unknown;
}) {
	const cfg = parseConfig(tableConfigSchema, config);
	const rows = resolveArray(value, cfg.rows_key);
	if (rows.length === 0) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
				No rows
			</div>
		);
	}
	const columns =
		cfg.columns && cfg.columns.length > 0 ? cfg.columns : inferColumns(rows);

	return (
		<div className="h-full overflow-auto">
			<Table>
				<TableHeader appearance="widget" className="sticky top-0 z-10">
					<TableRow appearance="header">
						{columns.map((c) => (
							<TableHead key={c} presentation="widget-label">
								{c}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row, i) => {
						const record = asRecord(row);
						return (
							// Row order is the data's natural order; index is a stable key here.
							<TableRow key={i}>
								{columns.map((c) => (
									<TableCell key={c}>
										{cell(record ? record[c] : i === 0 ? row : "")}
									</TableCell>
								))}
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
}
