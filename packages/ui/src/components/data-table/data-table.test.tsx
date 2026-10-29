import { describe, expect, test } from "bun:test";
import type { ColumnDef } from "@tanstack/react-table";
import { renderToStaticMarkup } from "react-dom/server";
import { useDataTable } from "../../hooks/use-data-table.ts";
import { DataTable } from "./data-table.tsx";
import { DataTableColumnHeader } from "./data-table-column-header.tsx";
import { DataTableToolbar } from "./data-table-toolbar.tsx";

interface Row {
	id: string;
	kind: string;
	name: string;
}

const COLUMNS: ColumnDef<Row>[] = [
	{
		id: "name",
		accessorKey: "name",
		header: ({ column }) => (
			<DataTableColumnHeader column={column} label="Name" />
		),
		enableColumnFilter: true,
		meta: { label: "Name", placeholder: "Search names…", variant: "text" },
	},
	{
		id: "kind",
		accessorKey: "kind",
		header: ({ column }) => (
			<DataTableColumnHeader column={column} label="Kind" />
		),
		enableColumnFilter: true,
		meta: {
			label: "Kind",
			options: [{ label: "Alpha", value: "a" }],
			variant: "multiSelect",
		},
	},
];

function ClientTable({ rows }: { rows: Row[] }) {
	const { table } = useDataTable({
		columns: COLUMNS,
		data: rows,
		mode: "client",
		initialState: { pagination: { pageSize: 2 } },
	});
	return (
		<DataTable emptyMessage="Nothing here." table={table}>
			<DataTableToolbar table={table} />
		</DataTable>
	);
}

describe("DataTable", () => {
	test("pages client rows and renders the toolbar filters", () => {
		const html = renderToStaticMarkup(
			<ClientTable
				rows={[
					{ id: "1", kind: "a", name: "First" },
					{ id: "2", kind: "a", name: "Second" },
					{ id: "3", kind: "b", name: "Third" },
				]}
			/>
		);
		expect(html).toContain("First");
		expect(html).toContain("Second");
		expect(html).not.toContain("Third");
		expect(html).toContain("Page 1 of 2");
		expect(html).toContain('placeholder="Search names…"');
		expect(html).toContain("Kind");
	});

	test("shows the empty message without rows", () => {
		const html = renderToStaticMarkup(<ClientTable rows={[]} />);
		expect(html).toContain("Nothing here.");
		expect(html).toContain("Page 1 of 1");
	});
});
