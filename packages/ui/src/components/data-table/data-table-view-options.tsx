"use client";

import "../../types/data-table.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import type { Table } from "@tanstack/react-table";
import { Settings2 } from "lucide-react";

interface DataTableViewOptionsProps<TData> {
	disabled?: boolean;
	table: Table<TData>;
}

/** The "View" menu that toggles which hideable columns are shown. */
export function DataTableViewOptions<TData>({
	table,
	disabled,
}: DataTableViewOptionsProps<TData>) {
	const columns = table
		.getAllColumns()
		.filter(
			(column) =>
				typeof column.accessorFn !== "undefined" && column.getCanHide()
		);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label="View columns"
						className="ms-auto hidden lg:flex"
						disabled={disabled}
						variant="outline"
					/>
				}
			>
				<Settings2 className="text-muted-foreground" />
				View
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-44">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Columns</DropdownMenuLabel>
					{columns.map((column) => (
						<DropdownMenuCheckboxItem
							checked={column.getIsVisible()}
							key={column.id}
							onCheckedChange={(value) => column.toggleVisibility(value)}
						>
							<span className="truncate">
								{column.columnDef.meta?.label ?? column.id}
							</span>
						</DropdownMenuCheckboxItem>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
